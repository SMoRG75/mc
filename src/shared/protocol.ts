/**
 * The contract between the extension host and the webview.
 *
 * Both sides import this file, so it must stay free of Node and DOM types —
 * plain data only. Every message is a discriminated union member so that
 * adding a case forces both sides to handle it.
 */

export type PaneId = 'left' | 'right';

/** The four worlds a pane can show. They all behave like a filesystem. */
export type PaneKind = 'local' | 'ds' | 'uss' | 'jes';

/**
 * Where a pane is pointing.
 *
 * `profile` is a Zowe profile name; it is empty for `local` and means "the
 * default zosmf profile" when empty for the remote kinds. `path` is
 * interpreted by the provider: a directory for local/uss, a dataset filter or
 * PDS name for ds, and an owner/prefix filter or job id for jes.
 */
export interface PaneLocation {
  kind: PaneKind;
  profile: string;
  path: string;
}

export type EntryKind = 'up' | 'dir' | 'file' | 'link';

/** One row in a pane. `cells` is keyed by the column ids the provider declared. */
export interface EntryDto {
  id: string;
  name: string;
  kind: EntryKind;
  cells: Record<string, string>;
  /** Bytes where meaningful; used for transfer progress and the footer total. */
  size?: number;
  /** Sorted on by the webview; falls back to `name` when absent. */
  sortKey?: string;
  /** Rendered in a warning colour — migrated datasets, failed jobs. */
  attention?: boolean;
}

export interface ColumnDef {
  id: string;
  title: string;
  /** Relative width, distributed as flex-basis percentages. */
  width: number;
  align?: 'left' | 'right';
}

/**
 * A named alternative view of the same place, rendered as a segmented control
 * in the pane header.
 *
 * The provider decides what its views are and where each one points, so the
 * webview switches between them without knowing what a JES status queue is —
 * it just navigates to the location the view carries.
 */
export interface ViewDto {
  id: string;
  label: string;
  location: PaneLocation;
  active: boolean;
}

export interface ListingDto {
  location: PaneLocation;
  /** What the path bar shows, e.g. `IBMUSER.PROD.JCL (PO-E · FB 80)`. */
  title: string;
  columns: ColumnDef[];
  entries: EntryDto[];
  /** Right-hand side of the pane footer: volume, free space, refresh interval. */
  status: string;
  /** True when the listing hit `mc.list.pageSize`. */
  truncated: boolean;
  capabilities: Capabilities;
  /** Empty for providers that only have one way of looking at a location. */
  views?: ViewDto[];
}

export interface Capabilities {
  write: boolean;
  delete: boolean;
  rename: boolean;
  create: boolean;
  submit: boolean;
}

export interface TransferOptions {
  mode: 'text' | 'binary' | 'auto';
  codepage: string;
  longLines: 'wrap' | 'truncate' | 'abort';
  onConflict: 'ask' | 'overwrite' | 'skip' | 'newer';
  /** Destination pattern; `*` keeps the source name. */
  destination: string;
}

export interface TransferJobDto {
  id: string;
  label: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  /** 0..1, or undefined when the total size is unknown. */
  progress?: number;
  error?: string;
}

export interface ProfileDto {
  name: string;
  type: string;
  host?: string;
  isDefault: boolean;
}

/* ------------------------------------------------------------------ */
/* extension host -> webview                                           */
/* ------------------------------------------------------------------ */

export type HostMessage =
  | { type: 'init'; panes: Record<PaneId, PaneLocation>; profiles: ProfileDto[]; defaults: TransferOptions }
  | { type: 'listing'; pane: PaneId; listing: ListingDto }
  | { type: 'busy'; pane: PaneId; busy: boolean }
  | { type: 'error'; pane: PaneId | null; message: string; detail?: string }
  | { type: 'transfers'; jobs: TransferJobDto[] }
  | { type: 'profiles'; profiles: ProfileDto[] }
  /** A key VS Code would otherwise have swallowed (F5 starts the debugger). */
  | { type: 'key'; key: string }
  /**
   * The panel became the active editor. VS Code focuses the webview's iframe,
   * but nothing inside it, so the webview has to put the caret somewhere itself
   * or the first keypress goes nowhere and the user has to click.
   */
  | { type: 'focus' };

/* ------------------------------------------------------------------ */
/* webview -> extension host                                           */
/* ------------------------------------------------------------------ */

export type ClientMessage =
  | { type: 'ready' }
  | { type: 'navigate'; pane: PaneId; location: PaneLocation }
  | { type: 'enter'; pane: PaneId; entryId: string }
  | { type: 'up'; pane: PaneId }
  | { type: 'refresh'; pane: PaneId }
  | { type: 'open'; pane: PaneId; entryId: string; mode: 'view' | 'edit' }
  | { type: 'copy'; from: PaneId; entryIds: string[]; options: TransferOptions }
  | { type: 'move'; from: PaneId; entryIds: string[]; options: TransferOptions }
  | { type: 'rename'; pane: PaneId; entryId: string; newName: string }
  | { type: 'delete'; pane: PaneId; entryIds: string[] }
  | { type: 'create'; pane: PaneId; name: string }
  | { type: 'submit'; pane: PaneId; entryIds: string[] }
  | { type: 'compare'; leftEntryId: string; rightEntryId: string }
  | { type: 'cancelTransfer'; id: string }
  | { type: 'commandLine'; pane: PaneId; line: string };
