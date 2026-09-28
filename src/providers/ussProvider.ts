import type { Readable, Writable } from 'node:stream';
import { Create, Delete, Download, Get, List, Upload, Utilities } from '@zowe/zos-files-for-zowe-sdk';
import type { AbstractSession } from '@zowe/imperative';
import type { Capabilities, ColumnDef, PaneLocation, TransferOptions } from '../shared/protocol';
import type { Entry, Listing, PaneProvider, SourceItem } from '../core/provider';
import type { SessionManager } from '../zowe/sessions';
import { pacedDownload, pacedUpload } from '../zowe/flow';
import { resolveMode } from '../core/text';

interface UssRef { path: string; isDirectory: boolean }

const COLUMNS: ColumnDef[] = [
  { id: 'name', title: 'Name', width: 40 },
  { id: 'size', title: 'Size', width: 14, align: 'right' },
  { id: 'mtime', title: 'Modified', width: 24 },
  { id: 'mode', title: 'Perm', width: 12 },
  { id: 'user', title: 'Owner', width: 10 },
];

export class UssProvider implements PaneProvider {
  readonly kind = 'uss' as const;

  constructor(
    private readonly sessions: SessionManager,
    private readonly settings: { pageSize: () => number; binaryExtensions: () => readonly string[] },
  ) {}

  label(loc: PaneLocation): string {
    return loc.profile || '(default)';
  }

  capabilities(): Capabilities {
    return { write: true, delete: true, rename: true, create: true, submit: true };
  }

  async list(loc: PaneLocation, signal: AbortSignal): Promise<Listing> {
    const session = await this.sessions.session(loc.profile);
    const dir = loc.path || '/';
    const response = await List.fileList(session, dir, {});
    signal.throwIfAborted();

    const items = (response.apiResponse?.items ?? []) as ZosmfUssItem[];
    const limit = this.settings.pageSize();
    let bytes = 0;

    const entries: Entry<UssRef>[] = items
      // z/OSMF returns '.' and '..'; the pane draws its own '..' row.
      .filter((item) => item.name !== '.' && item.name !== '..')
      .slice(0, limit)
      .map((item) => {
        const isDirectory = item.mode?.startsWith('d') ?? false;
        const isLink = item.mode?.startsWith('l') ?? false;
        if (!isDirectory) bytes += item.size ?? 0;
        return {
          ref: { path: join(dir, item.name), isDirectory },
          dto: {
            id: join(dir, item.name),
            name: item.name,
            kind: isDirectory ? 'dir' : isLink ? 'link' : 'file',
            size: isDirectory ? undefined : item.size,
            sortKey: `${isDirectory ? '0' : '1'}${item.name.toLowerCase()}`,
            cells: {
              name: item.name,
              size: isDirectory ? '<DIR>' : (item.size ?? 0).toLocaleString('en-US'),
              mtime: item.mtime ?? '',
              mode: item.mode ?? '',
              user: item.user ?? String(item.uid ?? ''),
            },
          },
        };
      });

    return {
      title: dir,
      columns: COLUMNS,
      entries,
      status: `${(bytes / 1024 / 1024).toFixed(1)} MB in directory`,
      truncated: items.length > limit,
    };
  }

  parent(loc: PaneLocation): PaneLocation | undefined {
    if (loc.path === '/' || loc.path === '') return undefined;
    const cut = loc.path.replace(/\/$/, '').lastIndexOf('/');
    return { ...loc, path: cut <= 0 ? '/' : loc.path.slice(0, cut) };
  }

  enter(loc: PaneLocation, entry: Entry): PaneLocation | undefined {
    const ref = entry.ref as UssRef;
    return ref.isDirectory ? { ...loc, path: ref.path } : undefined;
  }

  /** `cd /u`, `cd u`, `cd ../tmp` and a bare `cd` for the root. */
  resolve(loc: PaneLocation, argument: string): PaneLocation {
    const target = argument.trim();
    if (!target) return { ...loc, path: '/' };
    return {
      ...loc,
      path: normalize(target.startsWith('/') ? target : join(loc.path || '/', target)),
    };
  }

  describe(_loc: PaneLocation, entry: Entry): SourceItem {
    const ref = entry.ref as UssRef;
    return { name: basename(ref.path), size: entry.dto.size, text: false };
  }

  async read(loc: PaneLocation, entry: Entry, transfer: TransferOptions): Promise<Buffer> {
    const session = await this.sessions.session(loc.profile);
    const ref = entry.ref as UssRef;
    return Get.USSFile(session, ref.path, await this.readOptions(session, ref.path, transfer));
  }

  async readTo(
    loc: PaneLocation, entry: Entry, transfer: TransferOptions, sink: Writable, signal: AbortSignal,
  ): Promise<void> {
    const session = await this.sessions.session(loc.profile);
    const ref = entry.ref as UssRef;
    const options = await this.readOptions(session, ref.path, transfer);
    await pacedDownload(sink, signal, (stream) => Download.ussFile(session, ref.path, { ...options, stream }));
  }

  /**
   * A binary read is the caller saying "the bytes, untouched" — Shift+F3 and an
   * extension on the binary list both mean it, and the file's tag must not
   * convert them back out from under it. Otherwise the file's own tag knows
   * better than any default we could pick — but an untagged file has to be
   * read as something, and the configured codepage is a far better guess than
   * the service default.
   */
  private async readOptions(
    session: AbstractSession, path: string, transfer: TransferOptions,
  ): Promise<{ binary?: boolean; encoding?: string }> {
    if (resolveMode(transfer, basename(path), this.settings.binaryExtensions()) === 'binary') {
      return { binary: true };
    }
    const options: { binary?: boolean; encoding?: string } = { encoding: transfer.codepage };
    await Utilities.applyTaggedEncoding(session, path, options).catch(() => undefined);
    if (options.binary) delete options.encoding;
    return options;
  }

  async write(loc: PaneLocation, name: string, data: Buffer, options: TransferOptions): Promise<void> {
    const session = await this.sessions.session(loc.profile);
    await Upload.bufferToUssFile(session, join(loc.path, name), data, this.writeOptions(name, options));
  }

  async writeFrom(
    loc: PaneLocation, name: string, source: Readable, options: TransferOptions, signal: AbortSignal,
  ): Promise<void> {
    const session = await this.sessions.session(loc.profile);
    await pacedUpload(source, signal, (body) =>
      Upload.streamToUssFile(session, join(loc.path, name), body, this.writeOptions(name, options)));
  }

  private writeOptions(name: string, options: TransferOptions): { binary?: boolean; encoding?: string } {
    return resolveMode(options, name, this.settings.binaryExtensions()) === 'binary'
      ? { binary: true }
      : { encoding: options.codepage };
  }

  async exists(loc: PaneLocation, name: string): Promise<boolean> {
    const session = await this.sessions.session(loc.profile);
    const response = await List.fileList(session, loc.path, {});
    const items = (response.apiResponse?.items ?? []) as ZosmfUssItem[];
    return items.some((item) => item.name === name);
  }

  async remove(loc: PaneLocation, entries: Entry[]): Promise<void> {
    const session = await this.sessions.session(loc.profile);
    for (const entry of entries) {
      const ref = entry.ref as UssRef;
      await Delete.ussFile(session, ref.path, ref.isDirectory);
    }
  }

  async rename(loc: PaneLocation, entry: Entry, newName: string): Promise<void> {
    const session = await this.sessions.session(loc.profile);
    const ref = entry.ref as UssRef;
    await Utilities.renameUSSFile(session, ref.path, join(dirname(ref.path), newName));
  }

  /** F7 makes a directory; a trailing name without '/' still means a directory here. */
  async create(loc: PaneLocation, name: string): Promise<string> {
    const session = await this.sessions.session(loc.profile);
    await Create.uss(session, join(loc.path, name), 'directory');
    return name;
  }

  async submit(loc: PaneLocation, entries: Entry[]): Promise<string[]> {
    const { SubmitJobs } = await import('@zowe/zos-jobs-for-zowe-sdk');
    const session = await this.sessions.session(loc.profile);
    const ids: string[] = [];
    for (const entry of entries) {
      const job = await SubmitJobs.submitUSSJob(session, (entry.ref as UssRef).path);
      ids.push(job.jobid);
    }
    return ids;
  }
}

function join(dir: string, name: string): string {
  return `${dir.replace(/\/$/, '')}/${name}`;
}

/** Resolves `.` and `..` and collapses repeated slashes; always absolute. */
function normalize(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join('/')}`;
}

function dirname(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

interface ZosmfUssItem {
  name: string; mode?: string; size?: number; uid?: number;
  user?: string; gid?: number; group?: string; mtime?: string;
}
