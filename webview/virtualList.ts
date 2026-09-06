import type { ColumnDef, EntryDto } from '../src/shared/protocol';

const ROW_HEIGHT = 18;
const OVERSCAN = 8;

/**
 * Renders only the rows that are on screen.
 *
 * A production PDS can hold twenty thousand members, and a pane that builds
 * twenty thousand table rows is a pane that stutters on every keypress. The
 * scroller keeps a spacer of the full height and moves a small window of real
 * rows inside it.
 */
export class VirtualList {
  private readonly viewport = document.createElement('div');
  private readonly spacer = document.createElement('div');
  private readonly rows = document.createElement('div');
  private entries: EntryDto[] = [];
  private columns: ColumnDef[] = [];
  private cursor = 0;
  private marked = new Set<string>();
  /** The window currently built in the DOM; -1 forces the next paint to rebuild. */
  private painted = { first: -1, last: -1 };

  constructor(
    private readonly onActivate: (entry: EntryDto) => void,
    private readonly onCursor: (index: number) => void,
  ) {
    this.viewport.className = 'rows-viewport';
    // Focusable, but not in the tab order: the panes are driven by the keymap,
    // and something in the document must hold focus or keydown never fires.
    this.viewport.tabIndex = -1;
    this.spacer.className = 'rows-spacer';
    this.rows.className = 'rows';
    this.spacer.append(this.rows);
    this.viewport.append(this.spacer);
    this.viewport.addEventListener('scroll', () => this.paint());
    this.viewport.addEventListener('dblclick', (event) => {
      const entry = this.entryFromEvent(event);
      if (entry) this.onActivate(entry);
    });
    this.viewport.addEventListener('mousedown', (event) => {
      const index = this.indexFromEvent(event);
      if (index !== undefined) {
        this.cursor = index;
        this.onCursor(index);
        this.paint();
      }
    });
  }

  get element(): HTMLElement {
    return this.viewport;
  }

  focus(): void {
    this.viewport.focus({ preventScroll: true });
  }

  setData(columns: ColumnDef[], entries: EntryDto[]): void {
    this.columns = columns;
    this.entries = entries;
    this.cursor = Math.min(this.cursor, Math.max(0, entries.length - 1));
    this.spacer.style.height = `${entries.length * ROW_HEIGHT}px`;
    this.painted = { first: -1, last: -1 };
    this.paint();
  }

  setMarked(marked: Set<string>): void {
    this.marked = marked;
    this.paint();
  }

  setCursor(index: number): void {
    this.cursor = Math.max(0, Math.min(index, this.entries.length - 1));
    this.scrollIntoView();
    this.paint();
  }

  get cursorIndex(): number {
    return this.cursor;
  }

  get visibleRowCount(): number {
    return Math.max(1, Math.floor(this.viewport.clientHeight / ROW_HEIGHT));
  }

  private scrollIntoView(): void {
    const top = this.cursor * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < this.viewport.scrollTop) {
      this.viewport.scrollTop = top;
    } else if (bottom > this.viewport.scrollTop + this.viewport.clientHeight) {
      this.viewport.scrollTop = bottom - this.viewport.clientHeight;
    }
  }

  /**
   * Rebuilds the visible window, or — when the same rows are already in the DOM
   * — only re-flags them.
   *
   * Keeping the elements matters beyond the saved work: a click that replaced
   * the row it landed on left the browser with no shared element between the
   * two clicks of a double-click, so `dblclick` fired on the container and the
   * row was never found.
   */
  private paint(): void {
    const first = Math.max(0, Math.floor(this.viewport.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(this.entries.length, first + this.visibleRowCount + OVERSCAN * 2);

    if (first === this.painted.first && last === this.painted.last) {
      this.reflag();
      return;
    }

    this.rows.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
    this.rows.replaceChildren(
      ...this.entries.slice(first, last).map((entry, offset) => this.row(entry, first + offset)),
    );
    this.painted = { first, last };
  }

  /** The only things that change without the data changing: cursor and marks. */
  private reflag(): void {
    for (const element of this.rows.children) {
      const row = element as HTMLElement;
      const index = Number(row.dataset.index);
      const entry = this.entries[index];
      row.classList.toggle('cursor', index === this.cursor);
      row.classList.toggle('marked', entry !== undefined && this.marked.has(entry.id));
    }
  }

  private row(entry: EntryDto, index: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.index = String(index);
    if (index === this.cursor) row.classList.add('cursor');
    if (this.marked.has(entry.id)) row.classList.add('marked');
    if (entry.attention) row.classList.add('attention');
    if (entry.kind === 'up') row.classList.add('up');

    for (const column of this.columns) {
      const cell = document.createElement('span');
      cell.className = 'cell';
      cell.style.flexBasis = `${column.width}%`;
      if (column.align === 'right') cell.classList.add('right');
      const text = entry.cells[column.id] ?? '';
      cell.textContent = column.id === 'name' ? `${icon(entry)} ${text}` : text;
      cell.title = text;
      row.append(cell);
    }
    return row;
  }

  private indexFromEvent(event: Event): number | undefined {
    const row = (event.target as HTMLElement | null)?.closest('.row') as HTMLElement | null;
    const index = row?.dataset.index;
    return index === undefined ? undefined : Number(index);
  }

  private entryFromEvent(event: Event): EntryDto | undefined {
    const index = this.indexFromEvent(event);
    return index === undefined ? undefined : this.entries[index];
  }
}

function icon(entry: EntryDto): string {
  switch (entry.kind) {
    case 'up': return '↰';
    case 'dir': return '📁';
    case 'link': return '⇢';
    default: return '🗎';
  }
}
