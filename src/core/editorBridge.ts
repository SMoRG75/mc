import * as vscode from 'vscode';
import type { PaneLocation, TransferOptions } from '../shared/protocol';
import type { ProviderRegistry } from './provider';
import { describeError } from './errors';
import { ebcdicToText } from './ebcdic';

export const SCHEME_EDIT = 'mc';
export const SCHEME_VIEW = 'mc-view';
/** Shift+F3: raw bytes, decoded here rather than by z/OSMF. Read-only, like mc-view. */
export const SCHEME_EBCDIC = 'mc-ebcdic';

export type OpenMode = 'view' | 'edit' | 'ebcdic';

/** What Shift+F3 needs and a transfer does not: which page, and how long a record. */
export interface EbcdicSettings {
  codepage: () => string;
  recordLength: () => number;
}

interface Target {
  location: PaneLocation;
  entryId: string;
  name: string;
}

/**
 * Lets F3/F4 open mainframe content in a real VS Code editor.
 *
 * Everything the pane can list gets a URI, so syntax highlighting, diffing,
 * search and Ctrl+S all work on a PDS member or a spool file exactly as they
 * do on a local file — no temp files to clean up, and no separate "save to
 * mainframe" command for the user to forget.
 */
export class EditorBridge implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  /**
   * Where a Ctrl+S just landed.
   *
   * The listing behind it is stale the moment the save returns — the size and
   * the ISPF statistics are z/OS's answer, not ours, and a member saved from
   * here may have no statistics at all. The pane showing that place refreshes
   * itself rather than making the user think to press F2.
   */
  private readonly wrote = new vscode.EventEmitter<PaneLocation>();
  readonly onDidWrite = this.wrote.event;

  constructor(
    private readonly providers: ProviderRegistry,
    private readonly transferDefaults: () => TransferOptions,
    private readonly ebcdic: EbcdicSettings,
  ) {}

  static register(
    context: vscode.ExtensionContext,
    providers: ProviderRegistry,
    transferDefaults: () => TransferOptions,
    ebcdic: EbcdicSettings,
  ): EditorBridge {
    const bridge = new EditorBridge(providers, transferDefaults, ebcdic);
    context.subscriptions.push(
      vscode.workspace.registerFileSystemProvider(SCHEME_EDIT, bridge, { isCaseSensitive: true }),
      vscode.workspace.registerFileSystemProvider(SCHEME_VIEW, bridge, {
        isCaseSensitive: true, isReadonly: true,
      }),
      vscode.workspace.registerFileSystemProvider(SCHEME_EBCDIC, bridge, {
        isCaseSensitive: true, isReadonly: true,
      }),
    );
    return bridge;
  }

  /**
   * A URI carries the whole coordinate, so reopening one from History works
   * even after the pane has moved on: `mc://LPAR1/IBMUSER.PROD.JCL(BACKUP01)`
   * with the pane location in the query.
   */
  static uri(location: PaneLocation, entryId: string, name: string, mode: OpenMode): vscode.Uri {
    return vscode.Uri.from({
      scheme: mode === 'edit' ? SCHEME_EDIT : mode === 'view' ? SCHEME_VIEW : SCHEME_EBCDIC,
      authority: location.profile || '_',
      path: `/${name}`,
      query: JSON.stringify({ kind: location.kind, path: location.path, entryId } satisfies QueryShape),
    });
  }

  private parse(uri: vscode.Uri): Target {
    const query = JSON.parse(uri.query || '{}') as Partial<QueryShape>;
    if (!query.kind || query.entryId === undefined) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return {
      location: {
        kind: query.kind,
        profile: uri.authority === '_' ? '' : uri.authority,
        path: query.path ?? '',
      },
      entryId: query.entryId,
      name: uri.path.replace(/^\//, ''),
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const target = this.parse(uri);
    const provider = this.providers.get(target.location.kind);
    const options = this.transferDefaults();
    try {
      const listing = await provider.list(target.location, new AbortController().signal);
      const entry = listing.entries.find((e) => e.dto.id === target.entryId);
      if (!entry) throw vscode.FileSystemError.FileNotFound(uri);

      if (uri.scheme === SCHEME_EBCDIC) {
        // 'binary' is the whole point here: the bytes have to arrive unconverted
        // for there to be anything left to decode.
        const raw = await provider.read(
          target.location, entry, { ...options, mode: 'binary' }, new AbortController().signal,
        );
        const lrecl = provider.recordLength?.(target.location, entry);
        return Buffer.from(
          ebcdicToText(raw, this.ebcdic.codepage(), lrecl ?? this.ebcdic.recordLength()),
          'utf8',
        );
      }

      // Same options as a save and as F5: the codepage a file is read with has
      // to be the one it is written back with.
      return await provider.read(
        target.location, entry, options, new AbortController().signal,
      );
    } catch (err) {
      throw toFileSystemError(err, uri);
    }
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const target = this.parse(uri);
    const provider = this.providers.get(target.location.kind);
    try {
      await provider.write(
        target.location, target.name, Buffer.from(content),
        this.transferDefaults(), new AbortController().signal,
      );
      this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
      this.wrote.fire(target.location);
    } catch (err) {
      throw toFileSystemError(err, uri);
    }
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    this.parse(uri);
    // Size is unknown until the content is fetched; VS Code only needs a shape.
    return { type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: 0 };
  }

  watch(): vscode.Disposable {
    // Nothing on z/OS pushes change notifications; the pane refreshes explicitly.
    return new vscode.Disposable(() => undefined);
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}

interface QueryShape {
  kind: PaneLocation['kind'];
  path: string;
  entryId: string;
}

function toFileSystemError(err: unknown, uri: vscode.Uri): Error {
  if (err instanceof vscode.FileSystemError) return err;
  const { message } = describeError(err);
  return vscode.FileSystemError.Unavailable(`${uri.path}: ${message}`);
}
