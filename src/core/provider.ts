import type { Readable, Writable } from 'node:stream';
import { traced } from './trace';
import type {
  Capabilities, ColumnDef, DatasetSpec, EntryDto, FilterDto, PaneKind, PaneLocation,
  TransferOptions, ViewDto,
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
  /**
   * Named ways of looking at the same location. Only providers that have more
   * than one — JES and its status queues — fill this in.
   */
  views?: ViewDto[];
  /**
   * What Ctrl+F offers to change here.
   *
   * Built during the listing rather than asked for separately, because only the
   * listing knows the resolved values: the owner a JES pane fell back to is the
   * session user, which the path says nothing about.
   */
  filter?: FilterDto;
}

/** Everything a transfer needs to know about one item without re-listing it. */
export interface SourceItem {
  /** Name as it should arrive at the destination, extension included. */
  name: string;
  /**
   * Bytes, when the listing knows them — what the progress bar measures
   * against. Left out where the pane's size column counts something else, like
   * the records in a member or a spool file.
   */
  size?: number;
  /** True when the provider knows this is text (a PDS member always is). */
  text: boolean;
  /**
   * For a PDS: the attributes a copy of it has to be allocated with — the
   * record format and length above all, since the members' text is fitted to
   * them. Absent when the listing came back without attributes.
   */
  dataset?: DatasetSpec;
}

export interface ListOptions {
  /**
   * Every entry, past `mc.list.pageSize`. A pane can show a truncated listing
   * and say so; a copy of a whole folder must not quietly leave the rest behind.
   */
  all?: boolean;
}

/** What `folder` is told about the folder a copy is about to fill. */
export interface FolderShape {
  /**
   * Which world it comes from. A data set's name is already complete, while a
   * directory's is relative to the user's high-level qualifier, as in TSO.
   */
  from: PaneKind;
  /** The source PDS's attributes, when it is one. */
  dataset?: DatasetSpec;
  /** The files directly in it, and their bytes where known, for sizing a new data set. */
  files: number;
  bytes: number;
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

  /** Human-readable label for the pane header, e.g. `LPAR1` or `This PC`. */
  label(loc: PaneLocation): string;

  capabilities(loc: PaneLocation): Capabilities;

  list(loc: PaneLocation, signal: AbortSignal, options?: ListOptions): Promise<Listing>;

  /** The location one level up, or undefined when already at the root. */
  parent(loc: PaneLocation): PaneLocation | undefined;

  /**
   * Where `cd <argument>` from the command line lands.
   *
   * Only the provider knows whether its paths nest: USS and local disk join a
   * relative name onto the current directory, while a dataset filter or a JES
   * job filter is always absolute. Left out, `cd` replaces the path verbatim.
   */
  resolve?(loc: PaneLocation, argument: string): PaneLocation;

  /**
   * Where the filter dialog's answers point. `values` is keyed by the field ids
   * from the `filter` this provider put on its last listing, so the mapping from
   * "owner and job name" to a pane path stays in the one place that owns it.
   */
  applyFilter?(loc: PaneLocation, values: Record<string, string>): PaneLocation;

  /**
   * Where Enter on this entry leads. `undefined` means the entry is a leaf and
   * should be opened in an editor instead of navigated into.
   */
  enter(loc: PaneLocation, entry: Entry): PaneLocation | undefined;

  /** Describes the entry for transfer purposes. */
  describe(loc: PaneLocation, entry: Entry): SourceItem;

  /**
   * The entry's record length, where the world it lives in has one.
   *
   * Only Shift+F3 asks: bytes read raw out of a fixed-record dataset carry no
   * newline to split on, so the record length is the only thing that says where
   * one line ends. USS and local disk have none and leave this out.
   */
  recordLength?(loc: PaneLocation, entry: Entry): number | undefined;

  /**
   * Reads an entry whole, for the editor: VS Code wants the content as one
   * buffer anyway. Transfers go through `readTo`, which never holds all of it.
   *
   * `options` carries the codepage the host content has to be converted from —
   * the same one F5 writes with, so viewing, editing and copying cannot end up
   * disagreeing about what a national character means.
   */
  read(
    loc: PaneLocation, entry: Entry, options: TransferOptions, signal: AbortSignal,
  ): Promise<Buffer>;

  /** Writes `data` into `loc` under `name`, creating or replacing it. */
  write(
    loc: PaneLocation, name: string, data: Buffer,
    options: TransferOptions, signal: AbortSignal,
  ): Promise<void>;

  /**
   * `read` as a stream: the entry's content, converted the same way, written
   * into `sink`, which is ended once all of it is there. On failure the sink
   * may be left open or destroyed, and the caller has to cope with either: it
   * owns the sink, and decides what a half copy means.
   */
  readTo(
    loc: PaneLocation, entry: Entry, options: TransferOptions,
    sink: Writable, signal: AbortSignal,
  ): Promise<void>;

  /**
   * `write` from a stream, resolving once `source` has been read to the end and
   * the result is in place.
   */
  writeFrom(
    loc: PaneLocation, name: string, source: Readable,
    options: TransferOptions, signal: AbortSignal,
  ): Promise<void>;

  /**
   * Makes a folder called `name` in `loc` for a copy to fill — a directory, or
   * a PDS — and says where it is. One that is already there is reused, which
   * is what copying into an existing folder means, and `created` says which.
   * Left out where nothing can hold folders.
   */
  folder?(
    loc: PaneLocation, name: string, shape: FolderShape,
  ): Promise<{ location: PaneLocation; created: boolean }>;

  /**
   * What decides whether two names are the same entry in `loc`, where that is
   * not simply the name: a PDS member keeps eight uppercase characters of it,
   * and Windows does not tell case apart. A copy uses it to catch two files
   * that would land on one another before either is written.
   */
  nameKey?(loc: PaneLocation, name: string): string;

  /** True when `name` already exists in `loc` — drives the conflict prompt. */
  exists(loc: PaneLocation, name: string): Promise<boolean>;

  remove(loc: PaneLocation, entries: Entry[]): Promise<void>;

  rename(loc: PaneLocation, entry: Entry, newName: string): Promise<void>;

  /**
   * F7: allocate a dataset, make a directory, create an empty member.
   *
   * `dataset` carries the allocation attributes the MVS dialog collected;
   * providers that have nothing to do with datasets ignore it, and so does the
   * dataset provider when the pane is inside a PDS.
   *
   * Returns the name as it was actually created — not necessarily the one that
   * was typed, since MVS puts the user's high-level qualifier in front of an
   * unquoted name.
   */
  create(loc: PaneLocation, name: string, dataset?: DatasetSpec): Promise<string>;

  /** F9, only where `capabilities().submit` is true. */
  submit?(loc: PaneLocation, entries: Entry[]): Promise<string[]>;
}

/** Lookup by kind. Registered once at activation. */
export class ProviderRegistry {
  private readonly providers = new Map<PaneKind, PaneProvider>();

  /** Registered traced, so `mc.log.level: debug` shows every call the UI makes. */
  register(provider: PaneProvider): void {
    this.providers.set(provider.kind, traced(provider));
  }

  get(kind: PaneKind): PaneProvider {
    const provider = this.providers.get(kind);
    if (!provider) {
      throw new Error(`No provider registered for pane kind '${kind}'`);
    }
    return provider;
  }
}
