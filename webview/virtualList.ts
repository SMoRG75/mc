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

  constructor(
    private readonly onActivate: (entry: EntryDto) => void,
    private readonly onCursor: (index: number) => void,
  ) {
    this.viewport.className = 'rows-viewport';
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

  setData(columns: ColumnDef[], entries: EntryDto[]): void {
    this.columns = columns;
    this.entries = entries;
    this.cursor = Math.min(this.cursor, Math.max(0, entries.length - 1));
    this.spacer.style.height = `${entries.length * ROW_HEIGHT}px`;
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

  private paint(): void {
    const first = Math.max(0, Math.floor(this.viewport.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(this.entries.length, first + this.visibleRowCount + OVERSCAN * 2);

    this.rows.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
    this.rows.replaceChildren(
      ...this.entries.slice(first, last).map((entry, offset) => this.row(entry, first + offset)),
    );
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
