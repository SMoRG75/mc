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
  | 'view' | 'edit' | 'copy' | 'copyNoDialog' | 'rename' | 'create'
  | 'delete' | 'submit' | 'compare' | 'refresh' | 'swapPanes' | 'focusCommandLine'
  | 'quickFilter' | 'cancel' | 'nextView';

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
  F3: 'view',
  F4: 'edit',
  F5: 'copy',
  'Shift+F5': 'copyNoDialog',
  F6: 'rename',
  F7: 'create',
  F8: 'delete',
  Delete: 'delete',
  F9: 'submit',
  F10: 'compare',
  'Ctrl+r': 'refresh',
  'Ctrl+u': 'swapPanes',
  'Ctrl+a': 'markAll',
  'Ctrl+i': 'invertMark',
  'Ctrl+s': 'quickFilter',
  'Ctrl+j': 'nextView',
  Escape: 'cancel',
};

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
