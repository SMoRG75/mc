import type {
  Capabilities, ColumnDef, EntryDto, PaneKind, PaneLocation, TransferOptions,
} from '../shared/protocol';

/**
 * A pane entry plus whatever the provider needs to act on it later. The `dto`
 * half crosses to the webview; `ref` never leaves the extension host.
 */
export interface Entry<TRef = unknown> {
  dto: EntryDto;
  ref: TRef;
}

export interface Listing {
  title: string;
  columns: ColumnDef[];
  entries: Entry[];
  status: string;
  truncated: boolean;
}

/** Everything a transfer needs to know about one item without re-listing it. */
export interface SourceItem {
  /** Name as it should arrive at the destination, extension included. */
  name: string;
  size?: number;
  /** True when the provider knows this is text (a PDS member always is). */
  text: boolean;
}

/**
 * The one abstraction the whole extension turns on: local disk, MVS datasets,
 * USS and JES all implement this, so every keystroke in the UI has exactly one
 * implementation regardless of which world the pane is showing.
 *
 * Implementations must be stateless between calls — a pane may be re-pointed
 * at a different profile at any time.
 */
export interface PaneProvider {
  readonly kind: PaneKind;

  /** Human-readable label for the pane header, e.g. `LPAR1` or `Denne PC`. */
  label(loc: PaneLocation): string;

  capabilities(loc: PaneLocation): Capabilities;

  list(loc: PaneLocation, signal: AbortSignal): Promise<Listing>;

  /** The location one level up, or undefined when already at the root. */
  parent(loc: PaneLocation): PaneLocation | undefined;

  /**
   * Where Enter on this entry leads. `undefined` means the entry is a leaf and
   * should be opened in an editor instead of navigated into.
   */
  enter(loc: PaneLocation, entry: Entry): PaneLocation | undefined;

  /** Describes the entry for transfer purposes. */
  describe(loc: PaneLocation, entry: Entry): SourceItem;

  /** Reads an entry whole. Large files should go through `readStream` instead. */
  read(loc: PaneLocation, entry: Entry, signal: AbortSignal): Promise<Buffer>;

  /** Writes `data` into `loc` under `name`, creating or replacing it. */
  write(
    loc: PaneLocation, name: string, data: Buffer,
    options: TransferOptions, signal: AbortSignal,
  ): Promise<void>;

  /** True when `name` already exists in `loc` — drives the conflict prompt. */
  exists(loc: PaneLocation, name: string): Promise<boolean>;

  remove(loc: PaneLocation, entries: Entry[]): Promise<void>;

  rename(loc: PaneLocation, entry: Entry, newName: string): Promise<void>;

  /** F7: allocate a dataset, make a directory. `spec` is provider-specific. */
  create(loc: PaneLocation, spec: string): Promise<void>;

  /** F9, only where `capabilities().submit` is true. */
  submit?(loc: PaneLocation, entries: Entry[]): Promise<string[]>;
}

/** Lookup by kind. Registered once at activation. */
export class ProviderRegistry {
  private readonly providers = new Map<PaneKind, PaneProvider>();

  register(provider: PaneProvider): void {
    this.providers.set(provider.kind, provider);
  }

  get(kind: PaneKind): PaneProvider {
    const provider = this.providers.get(kind);
    if (!provider) {
      throw new Error(`No provider registered for pane kind '${kind}'`);
    }
    return provider;
  }
}
