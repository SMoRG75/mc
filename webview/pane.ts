import type {
  Capabilities, EntryDto, ListingDto, PaneId, PaneKind, PaneLocation, ProfileDto, ViewDto,
} from '../src/shared/protocol';
import { VirtualList } from './virtualList';

const KINDS: [PaneKind, string][] = [
  ['local', 'Local'], ['ds', 'DS'], ['uss', 'USS'], ['jes', 'JES'],
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
  private profiles: ProfileDto[] = [];
  private readonly marked = new Set<string>();
  private filter = '';
  /** Filtered and sorted rows, recomputed only when the data or filter changes. */
  private view: EntryDto[] = [];
  /**
   * Which column the rows are ordered by. Every column a provider declares can
   * be sorted on — VV.MM and Created on a source PDS, AMODE and RMODE on a load
   * library — so this is a column id rather than a fixed list of sort orders.
   */
  private sort: { column: string; descending: boolean } = { column: 'name', descending: false };
  /** Right-aligned columns hold counts, and 9 must not sort after 10. */
  private numericColumns = new Set<string>();

  constructor(
    readonly id: PaneId,
    private readonly callbacks: {
      activate: (entry: EntryDto) => void;
      focus: (pane: PaneId) => void;
      navigate: (location: PaneLocation) => void;
      switchKind: (kind: PaneKind) => void;
      cursorMoved: (pane: PaneId, entryId: string) => void;
    },
  ) {
    this.element.className = 'pane';
    this.element.addEventListener('mousedown', () => this.callbacks.focus(this.id));

    this.list = new VirtualList(
      (entry) => this.callbacks.activate(entry),
      () => this.callbacks.focus(this.id),
      (index) => {
        const entry = this.view[index];
        if (entry) this.callbacks.cursorMoved(this.id, entry.id);
      },
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

  /** What the provider behind this listing allows — undefined until it arrives. */
  get capabilities(): Capabilities | undefined {
    return this.listing?.capabilities;
  }

  setActive(active: boolean): void {
    this.element.classList.toggle('inactive', !active);
  }

  /** Puts the keyboard in this pane's row list. */
  focus(): void {
    this.list.focus();
  }

  setProfiles(profiles: ProfileDto[]): void {
    this.profiles = profiles;
    this.profileSelect.replaceChildren(
      ...profiles.map((profile) => {
        const option = document.createElement('option');
        option.value = profile.name;
        option.textContent = profile.isDefault ? `${profile.name} ★` : profile.name;
        return option;
      }),
    );
    if (profiles.length === 0) {
      this.profileSelect.append(placeholder('(no profiles)'));
    }
    // The profile list and the listing arrive in either order.
    this.showProfile(this.listing?.location.profile ?? '');
  }

  /**
   * Shows which profile the pane is on.
   *
   * An empty profile means "the default one" — the location says nothing, and no
   * option carries an empty value, so assigning it straight to the select leaves
   * the header showing an empty box. Resolve it to the default profile, and fall
   * back to an option for the bare name when the profile list does not hold it
   * (a renamed profile, or a listing that arrived before the list did).
   */
  private showProfile(profile: string): void {
    const name = profile || this.profiles.find((p) => p.isDefault)?.name || this.profiles[0]?.name || '';
    // Against the options rather than the profile list: every refresh comes
    // through here, and the placeholder must not be added a second time.
    if (name && ![...this.profileSelect.options].some((o) => o.value === name)) {
      this.profileSelect.append(placeholder(name, name));
    }
    this.profileSelect.value = name;
  }

  /**
   * Points the pane at another world — what the header tabs do, and what
   * Alt+1..4 do. Both go through here so the keyboard cannot drift away from
   * what the tabs mean.
   *
   * Where in that world is the host's answer: it comes back to where the pane
   * last stood there, and asking for the world it is already showing is the way
   * back to the top of it.
   */
  showKind(kind: PaneKind): void {
    this.callbacks.switchKind(kind);
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
    this.showProfile(listing.location.profile);
    this.profileSelect.classList.toggle('hidden', listing.location.kind === 'local');
    this.renderKindTabs(listing.location.kind);
    this.renderViewTabs(listing.views ?? []);

    this.pathBar.textContent = listing.title;
    if (listing.truncated) {
      const badge = document.createElement('span');
      badge.className = 'badge warn';
      badge.textContent = 'truncated';
      this.pathBar.append(badge);
    }

    this.numericColumns = new Set(
      listing.columns.filter((c) => c.align === 'right').map((c) => c.id),
    );
    // A DS filter and a load library do not share columns, so an order carried
    // over from the last listing may name a column that is no longer there.
    if (!listing.columns.some((c) => c.id === this.sort.column)) {
      this.sort = { column: 'name', descending: false };
    }
    this.renderColumns();

    this.applyFilter();
    if (listing.cursor !== undefined) {
      // A position carried over from the last session. The row may well be gone
      // — a member deleted, a job purged — and the top of the list is then the
      // only honest answer.
      const index = this.view.findIndex((entry) => entry.id === listing.cursor);
      this.list.setCursor(index < 0 ? 0 : index);
    } else if (movedElsewhere) {
      // Refreshing in place should not throw away where the user was reading.
      this.list.setCursor(0);
    }
    this.updateFooter();
  }

  private renderColumns(): void {
    const columns = this.listing?.columns ?? [];
    this.columnsRow.replaceChildren(...columns.map((column) => {
      const cell = document.createElement('span');
      cell.className = column.align === 'right' ? 'cell right sortable' : 'cell sortable';
      cell.style.flexBasis = `${column.width}%`;
      const sorted = this.sort.column === column.id;
      cell.textContent = sorted
        ? `${column.title} ${this.sort.descending ? '▼' : '▲'}`
        : column.title;
      if (sorted) cell.classList.add('sorted');
      cell.title = `Sort by ${column.title}`;
      cell.addEventListener('click', () => this.sortBy(column.id));
      return cell;
    }));
  }

  /** Clicking a header sorts by it, and clicking it again turns it around. */
  private sortBy(column: string): void {
    this.sort = this.sort.column === column
      ? { column, descending: !this.sort.descending }
      : { column, descending: false };
    this.resort();
  }

  /** Ctrl+F3: the next column along, wrapping back to the first. */
  sortByNextColumn(): void {
    const columns = this.listing?.columns ?? [];
    if (columns.length === 0) return;
    const index = columns.findIndex((c) => c.id === this.sort.column);
    this.sort = { column: columns[(index + 1) % columns.length]!.id, descending: false };
    this.resort();
  }

  /** Ctrl+Shift+F3: same column, other end. */
  reverseSort(): void {
    this.sort = { ...this.sort, descending: !this.sort.descending };
    this.resort();
  }

  /**
   * Re-orders in place. The cursor follows the row it was on rather than the
   * position: sorting is for finding something, and losing it in the act would
   * defeat the point.
   */
  private resort(): void {
    const entryId = this.cursorEntry?.id;
    this.renderColumns();
    this.applyFilter();
    const index = entryId ? this.view.findIndex((entry) => entry.id === entryId) : -1;
    this.list.setCursor(index < 0 ? 0 : index);
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
      .sort((a, b) => this.compare(a, b));

    this.view = [up, ...rows];
    this.list.setData(this.listing.columns, this.view);
    this.list.setMarked(this.marked);
  }

  /**
   * Orders two rows by the sorted column, falling back to the name so that
   * equal values keep a fixed order instead of shuffling on every refresh.
   *
   * Blank cells always sink to the bottom: members written by anything but
   * ISPF carry no statistics, and a screenful of empty rows is not a useful
   * answer to "show me the biggest ones" in either direction.
   */
  private compare(a: EntryDto, b: EntryDto): number {
    const byName = (a.sortKey ?? a.name).localeCompare(b.sortKey ?? b.name, 'en');
    if (this.sort.column === 'name') return this.sort.descending ? -byName : byName;

    const left = a.cells[this.sort.column] ?? '';
    const right = b.cells[this.sort.column] ?? '';
    if (left === right) return byName;
    if (!left) return 1;
    if (!right) return -1;

    let order = left.localeCompare(right, 'en');
    if (this.numericColumns.has(this.sort.column)) {
      const [x, y] = [Number(left), Number(right)];
      if (Number.isFinite(x) && Number.isFinite(y)) order = x - y;
    }
    return this.sort.descending ? -order : order;
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
      ? `${this.marked.size} of ${total} selected — ${bytes.toLocaleString('en-US')} bytes`
      : `${total} item${total === 1 ? '' : 's'}${this.filter ? ` (filter: ${this.filter})` : ''}`;
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
      tab.addEventListener('click', () => this.showKind(kind));
      return tab;
    }));
  }

  private navigate(patch: Partial<PaneLocation>): void {
    const base = this.listing?.location ?? { kind: 'local' as PaneKind, profile: '', path: '' };
    this.callbacks.navigate({ ...base, ...patch });
  }
}

/** An option that stands in for something the profile list does not have. */
function placeholder(label: string, value = ''): HTMLOptionElement {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

function errorSpan(message: string, detail?: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'error';
  span.textContent = message;
  if (detail) span.title = detail;
  return span;
}
