/**
 * One place that turns a keyboard event into an action name.
 *
 * Two things make this less trivial than it looks. First, VS Code binds F3-F12
 * globally, so the same press can arrive twice: once natively in the webview
 * and once forwarded from the extension host. `Dispatcher` drops the duplicate.
 * Second, the webview must call preventDefault on everything it handles, or
 * the host acts on it as well.
 */
export type Action =
  | 'up' | 'down' | 'pageUp' | 'pageDown' | 'home' | 'end'
  | 'enter' | 'parent' | 'switchPane' | 'mark' | 'markAll' | 'invertMark'
  | 'view' | 'viewEbcdic' | 'edit' | 'copy' | 'copyNoDialog' | 'rename' | 'create'
  | 'delete' | 'submit' | 'compare' | 'refresh' | 'swapPanes' | 'focusCommandLine'
  | 'quickFilter' | 'cancel' | 'nextView' | 'sortNext' | 'sortReverse'
  | 'editFilter' | 'favourites' | 'help'
  | 'kindLocal' | 'kindDs' | 'kindUss' | 'kindJes';

const BINDINGS: Record<string, Action> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  PageUp: 'pageUp',
  PageDown: 'pageDown',
  Home: 'home',
  End: 'end',
  Enter: 'enter',
  Backspace: 'parent',
  Tab: 'switchPane',
  Insert: 'mark',
  ' ': 'mark',
  F1: 'help',
  F2: 'refresh',
  F3: 'view',
  'Shift+F3': 'viewEbcdic',
  // Total Commander sorts with Ctrl+F3..F6, one key per column. The columns
  // here are the provider's, and differ per world, so one key walks them.
  'Ctrl+F3': 'sortNext',
  'Ctrl+Shift+F3': 'sortReverse',
  F4: 'edit',
  F5: 'copy',
  'Shift+F5': 'copyNoDialog',
  F6: 'rename',
  F7: 'create',
  F8: 'delete',
  Delete: 'delete',
  F9: 'submit',
  F10: 'compare',
  // No Ctrl+R: VS Code has it on Reload Window, and losing the whole panel is
  // not what someone reaching for a refresh key had in mind. F2 is the refresh.
  'Ctrl+u': 'swapPanes',
  'Ctrl+a': 'markAll',
  'Ctrl+i': 'invertMark',
  'Ctrl+s': 'quickFilter',
  'Ctrl+j': 'nextView',
  // Ctrl+F edits what the pane is a filter of — owner and job name on JES —
  // where Ctrl+S only narrows the rows that came back.
  'Ctrl+f': 'editFilter',
  // Total Commander's directory hotlist, on the same key.
  'Ctrl+d': 'favourites',
  Escape: 'cancel',
  // The four tabs in the pane header, in the order they are drawn.
  'Alt+1': 'kindLocal',
  'Alt+2': 'kindDs',
  'Alt+3': 'kindUss',
  'Alt+4': 'kindJes',
};

/**
 * The bindings above, written out for F1.
 *
 * Deliberately a second list rather than something generated from `BINDINGS`:
 * the dialog is read by someone who does not know the keys yet, so it groups by
 * what the user is trying to do, says what a key means where the name does not,
 * and covers the parts that are not keys at all. Adding a binding means adding a
 * line here — which is why the two lists are neighbours.
 */
export const SHORTCUTS: readonly {
  title: string;
  rows: readonly (readonly [keys: string, what: string])[];
  note?: string;
}[] = [
  {
    title: 'Getting around',
    rows: [
      ['↑ ↓', 'Move the cursor'],
      ['PgUp · PgDn', 'A screen at a time'],
      ['Home · End', 'First row, last row'],
      ['Enter', 'Open the row — into a folder, a library, a job'],
      ['Backspace', 'Up one level'],
      ['Tab', 'The other pane'],
      ['Ctrl+U', 'Swap the two panes'],
      ['Alt+1 … Alt+4', 'Local · DS · USS · JES, in the pane you are in'],
      ['Ctrl+J', 'Next tab in the pane header'],
      ['Ctrl+D', 'Saved views — and save the one on screen'],
    ],
  },
  {
    title: 'Marking',
    rows: [
      ['Insert · Space', 'Mark the row and step down'],
      ['Ctrl+A', 'Mark everything'],
      ['Ctrl+I', 'Invert the marks'],
    ],
    note: 'F5, F8 and F9 work on the marked rows — or on the row under the cursor when nothing is marked.',
  },
  {
    title: 'The F-key bar',
    rows: [
      ['F1', 'This list'],
      ['F2', 'Refresh'],
      ['F3', 'View'],
      ['Shift+F3', 'View the raw bytes as EBCDIC'],
      ['F4', 'Edit'],
      ['F5', 'Copy to the other pane'],
      ['Shift+F5', 'Copy with the last settings, no dialog'],
      ['F6', 'Rename'],
      ['F7', 'New member, folder or dataset'],
      ['F8 · Delete', 'Delete'],
      ['F9', 'Submit as JCL'],
      ['F10', 'Compare the two rows the cursors are on'],
    ],
  },
  {
    title: 'Finding things',
    rows: [
      ['Ctrl+S', 'Quick filter: type to narrow, Enter keeps it, Esc clears it'],
      ['Ctrl+F', 'Change what the pane is a filter of — owner and job name on JES'],
      ['Ctrl+F3', 'Sort by the next column'],
      ['Ctrl+Shift+F3', 'Reverse the sort'],
    ],
    note: 'Clicking the path bar opens the same form as Ctrl+F wherever the path is a filter.',
  },
  {
    title: 'The command line',
    rows: [
      ['cd <path>', 'Go there in the active pane'],
      ['submit <name>', 'Submit that row'],
      ['refresh', 'Same as F2'],
    ],
    note: 'Esc leaves the command line and gives the keyboard back to the pane.',
  },
];

/** Normalised name, matching what package.json forwards ("Shift+F5"). */
export function keyName(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.shiftKey && event.key.startsWith('F')) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  parts.push(event.key.length === 1 ? event.key.toLowerCase() : event.key);
  return parts.join('+');
}

export class Dispatcher {
  private lastKey = '';
  private lastAt = 0;

  constructor(private readonly run: (action: Action, event?: KeyboardEvent) => void) {}

  /** From the webview's own keydown listener. */
  fromEvent(event: KeyboardEvent): void {
    const name = keyName(event);
    const action = BINDINGS[name];
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    this.remember(name);
    this.run(action, event);
  }

  /** From the extension host, for keys VS Code claimed first. */
  fromHost(name: string): void {
    if (this.isDuplicate(name)) return;
    const action = BINDINGS[name];
    if (action) {
      this.remember(name);
      this.run(action);
    }
  }

  private remember(name: string): void {
    this.lastKey = name;
    this.lastAt = Date.now();
  }

  /**
   * The forwarded copy arrives a few milliseconds after the native one. A short
   * window is enough to tell "the same press, twice" from "pressed F5 twice".
   */
  private isDuplicate(name: string): boolean {
    return name === this.lastKey && Date.now() - this.lastAt < 250;
  }
}
