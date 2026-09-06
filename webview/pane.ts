import type {
  EntryDto, ListingDto, PaneId, PaneKind, PaneLocation, ProfileDto, ViewDto,
} from '../src/shared/protocol';
import { VirtualList } from './virtualList';

const KINDS: [PaneKind, string][] = [
  ['local', 'Lokal'], ['ds', 'DS'], ['uss', 'USS'], ['jes', 'JES'],
];

/** One half of the screen: header, path bar, rows, footer. */
export class Pane {
  readonly element = document.createElement('div');
  private readonly profileSelect = document.createElement('select');
  private readonly kindTabs = document.createElement('span');
  private readonly viewTabs = document.createElement('span');
  private readonly pathBar = document.createElement('div');
  private readonly header = document.createElement('div');
  private readonly footer = document.createElement('div');
  private readonly list: VirtualList;
  private readonly columnsRow: HTMLElement;

  private listing?: ListingDto;
  private readonly marked = new Set<string>();
  private filter = '';
  /** Filtered and sorted rows, recomputed only when the data or filter changes. */
  private view: EntryDto[] = [];

  constructor(
    readonly id: PaneId,
    private readonly callbacks: {
      activate: (entry: EntryDto) => void;
      focus: (pane: PaneId) => void;
      navigate: (location: PaneLocation) => void;
    },
  ) {
    this.element.className = 'pane';
    this.element.addEventListener('mousedown', () => this.callbacks.focus(this.id));

    this.list = new VirtualList(
      (entry) => this.callbacks.activate(entry),
      () => this.callbacks.focus(this.id),
    );

    this.header.className = 'pane-head';
    this.profileSelect.className = 'pill';
    this.profileSelect.addEventListener('change', () => this.navigate({ profile: this.profileSelect.value }));
    this.kindTabs.className = 'seg';
    this.viewTabs.className = 'seg views';
    this.header.append(this.profileSelect, this.kindTabs, this.viewTabs);

    this.pathBar.className = 'pathbar';
    this.footer.className = 'pane-foot';

    const columns = document.createElement('div');
    columns.className = 'columns';
    this.columnsRow = columns;

    this.element.append(this.header, this.pathBar, columns, this.list.element, this.footer);
    this.renderKindTabs('local');
  }

  get location(): PaneLocation | undefined {
    return this.listing?.location;
  }

  setActive(active: boolean): void {
    this.element.classList.toggle('inactive', !active);
  }

  /** Puts the keyboard in this pane's row list. */
  focus(): void {
    this.list.focus();
  }

  setProfiles(profiles: ProfileDto[]): void {
    this.profileSelect.replaceChildren(
      ...profiles.map((profile) => {
        const option = document.createElement('option');
        option.value = profile.name;
        option.textContent = profile.isDefault ? `${profile.name} ★` : profile.name;
        return option;
      }),
    );
  }

  setBusy(busy: boolean): void {
    this.element.classList.toggle('busy', busy);
  }

  setError(message: string, detail?: string): void {
    this.footer.replaceChildren(errorSpan(message, detail));
  }

  setListing(listing: ListingDto): void {
    const movedElsewhere = this.listing?.location.path !== listing.location.path
      || this.listing?.location.kind !== listing.location.kind
      || this.listing?.location.profile !== listing.location.profile;

    this.listing = listing;
    this.marked.clear();
    this.filter = '';
    this.profileSelect.value = listing.location.profile;
    this.profileSelect.classList.toggle('hidden', listing.location.kind === 'local');
    this.renderKindTabs(listing.location.kind);
    this.renderViewTabs(listing.views ?? []);

    this.pathBar.textContent = listing.title;
    if (listing.truncated) {
      const badge = document.createElement('span');
      badge.className = 'badge warn';
      badge.textContent = 'afkortet';
      this.pathBar.append(badge);
    }

    this.columnsRow.replaceChildren(...listing.columns.map((column) => {
      const cell = document.createElement('span');
      cell.className = column.align === 'right' ? 'cell right' : 'cell';
      cell.style.flexBasis = `${column.width}%`;
      cell.textContent = column.title;
      return cell;
    }));

    this.applyFilter();
    // Refreshing in place should not throw away where the user was reading.
    if (movedElsewhere) this.list.setCursor(0);
    this.updateFooter();
  }

  /** Ctrl+S in Total Commander: type to narrow the list without leaving it. */
  setFilter(filter: string): void {
    this.filter = filter.toLowerCase();
    this.applyFilter();
    this.updateFooter();
  }

  /**
   * Rebuilds the visible rows. This is the only place that sorts, so scrolling
   * and cursor movement stay free no matter how many members the PDS holds.
   */
  private applyFilter(): void {
    if (!this.listing) {
      this.view = [];
      return;
    }
    // '..' belongs in the name column — that is the one that carries the icon
    // and is left-aligned. Column order is the provider's business, not ours.
    const nameColumn = this.listing.columns.find((c) => c.id === 'name')
      ?? this.listing.columns[0];
    const up: EntryDto = {
      id: '..', name: '..', kind: 'up',
      cells: Object.fromEntries(
        this.listing.columns.map((c) => [c.id, c.id === nameColumn?.id ? '..' : '']),
      ),
    };
    const rows = this.listing.entries
      .filter((entry) => !this.filter || entry.name.toLowerCase().includes(this.filter))
      .sort((a, b) => (a.sortKey ?? a.name).localeCompare(b.sortKey ?? b.name, 'da'));

    this.view = [up, ...rows];
    this.list.setData(this.listing.columns, this.view);
    this.list.setMarked(this.marked);
  }

  visibleEntries(): readonly EntryDto[] {
    return this.view;
  }

  get cursorEntry(): EntryDto | undefined {
    return this.view[this.list.cursorIndex];
  }

  /** Marked rows, or the row under the cursor when nothing is marked. */
  get selectionIds(): string[] {
    if (this.marked.size > 0) return [...this.marked];
    const entry = this.cursorEntry;
    return entry && entry.kind !== 'up' ? [entry.id] : [];
  }

  moveCursor(delta: number): void {
    this.list.setCursor(this.list.cursorIndex + delta);
  }

  setCursor(index: number): void {
    this.list.setCursor(index);
  }

  get pageSize(): number {
    return this.list.visibleRowCount;
  }

  get entryCount(): number {
    return this.view.length;
  }

  toggleMark(): void {
    const entry = this.cursorEntry;
    if (!entry || entry.kind === 'up') return;
    if (this.marked.has(entry.id)) this.marked.delete(entry.id);
    else this.marked.add(entry.id);
    this.list.setMarked(this.marked);
    this.moveCursor(1);
    this.updateFooter();
  }

  markAll(invert: boolean): void {
    for (const entry of this.view) {
      if (entry.kind === 'up') continue;
      if (invert && this.marked.has(entry.id)) this.marked.delete(entry.id);
      else this.marked.add(entry.id);
    }
    this.list.setMarked(this.marked);
    this.updateFooter();
  }

  clearMarks(): void {
    this.marked.clear();
    this.list.setMarked(this.marked);
    this.updateFooter();
  }

  private updateFooter(): void {
    if (!this.listing) return;
    const total = this.listing.entries.length;
    const bytes = this.listing.entries
      .filter((entry) => this.marked.has(entry.id))
      .reduce((sum, entry) => sum + (entry.size ?? 0), 0);
    const left = document.createElement('span');
    left.textContent = this.marked.size > 0
      ? `${this.marked.size} af ${total} markeret — ${bytes.toLocaleString('da-DK')} byte`
      : `${total} elementer${this.filter ? ` (filter: ${this.filter})` : ''}`;
    const right = document.createElement('span');
    right.className = 'r';
    right.textContent = this.listing.status;
    this.footer.replaceChildren(left, right);
  }

  /** The location of the view after the active one — Ctrl+J cycles through them. */
  get nextView(): PaneLocation | undefined {
    const views = this.listing?.views ?? [];
    if (views.length === 0) return undefined;
    const index = views.findIndex((view) => view.active);
    return views[(index + 1) % views.length]?.location;
  }

  private renderViewTabs(views: ViewDto[]): void {
    this.viewTabs.classList.toggle('hidden', views.length === 0);
    this.viewTabs.replaceChildren(...views.map((view) => {
      const tab = document.createElement('span');
      tab.textContent = view.label;
      if (view.active) tab.className = 'on';
      tab.addEventListener('click', () => this.callbacks.navigate(view.location));
      return tab;
    }));
  }

  private renderKindTabs(current: PaneKind): void {
    this.kindTabs.replaceChildren(...KINDS.map(([kind, label]) => {
      const tab = document.createElement('span');
      tab.textContent = label;
      if (kind === current) tab.className = 'on';
      tab.addEventListener('click', () => this.navigate({ kind, path: '' }));
      return tab;
    }));
  }

  private navigate(patch: Partial<PaneLocation>): void {
    const base = this.listing?.location ?? { kind: 'local' as PaneKind, profile: '', path: '' };
    this.callbacks.navigate({ ...base, ...patch });
  }
}

function errorSpan(message: string, detail?: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'error';
  span.textContent = message;
  if (detail) span.title = detail;
  return span;
}
