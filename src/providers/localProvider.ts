import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Capabilities, ColumnDef, PaneLocation, TransferOptions } from '../shared/protocol';
import type { Entry, Listing, PaneProvider, SourceItem } from '../core/provider';

interface LocalRef { fullPath: string; isDirectory: boolean }

const COLUMNS: ColumnDef[] = [
  { id: 'name', title: 'Name', width: 34 },
  { id: 'ext', title: 'Ext', width: 12 },
  { id: 'size', title: 'Size', width: 16, align: 'right' },
  { id: 'date', title: 'Date', width: 26 },
  { id: 'attr', title: 'Attr', width: 12 },
];

/** The local disk pane — the other half of every upload and download. */
export class LocalProvider implements PaneProvider {
  readonly kind = 'local' as const;

  constructor(private readonly pageSize: () => number) {}

  label(): string {
    return 'Denne PC';
  }

  capabilities(): Capabilities {
    return { write: true, delete: true, rename: true, create: true, submit: false };
  }

  async list(loc: PaneLocation, signal: AbortSignal): Promise<Listing> {
    const dir = loc.path || path.parse(process.cwd()).root;
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    signal.throwIfAborted();

    const limit = this.pageSize();
    const entries: Entry<LocalRef>[] = [];
    let bytes = 0;

    for (const dirent of dirents.slice(0, limit)) {
      const fullPath = path.join(dir, dirent.name);
      const stat = await fs.stat(fullPath).catch(() => undefined);
      const isDirectory = dirent.isDirectory();
      const ext = isDirectory ? '' : path.extname(dirent.name).replace(/^\./, '');
      const base = isDirectory ? dirent.name : path.basename(dirent.name, ext ? `.${ext}` : '');
      if (stat && !isDirectory) bytes += stat.size;

      entries.push({
        ref: { fullPath, isDirectory },
        dto: {
          id: fullPath,
          name: base,
          kind: isDirectory ? 'dir' : dirent.isSymbolicLink() ? 'link' : 'file',
          size: isDirectory ? undefined : stat?.size,
          sortKey: `${isDirectory ? '0' : '1'}${base.toLowerCase()}`,
          cells: {
            name: base,
            ext: isDirectory ? '—' : ext,
            size: isDirectory ? '<DIR>' : formatBytes(stat?.size),
            date: formatDate(stat?.mtime),
            attr: `${isDirectory ? 'd' : '-'}${stat && !isDirectory ? 'a' : '-'}--`,
          },
        },
      });
    }

    return {
      title: dir,
      columns: COLUMNS,
      entries,
      status: `${formatBytes(bytes)} i katalog`,
      truncated: dirents.length > limit,
    };
  }

  parent(loc: PaneLocation): PaneLocation | undefined {
    const parent = path.dirname(loc.path);
    return parent === loc.path ? undefined : { ...loc, path: parent };
  }

  enter(loc: PaneLocation, entry: Entry): PaneLocation | undefined {
    const ref = entry.ref as LocalRef;
    return ref.isDirectory ? { ...loc, path: ref.fullPath } : undefined;
  }

  /** `path.resolve` already knows about drive letters, UNC paths and `..`. */
  resolve(loc: PaneLocation, argument: string): PaneLocation {
    const target = argument.trim();
    if (!target) return loc;
    return { ...loc, path: path.resolve(loc.path || process.cwd(), target) };
  }

  describe(_loc: PaneLocation, entry: Entry): SourceItem {
    const ref = entry.ref as LocalRef;
    return { name: path.basename(ref.fullPath), size: entry.dto.size, text: false };
  }

  async read(_loc: PaneLocation, entry: Entry): Promise<Buffer> {
    return fs.readFile((entry.ref as LocalRef).fullPath);
  }

  async write(loc: PaneLocation, name: string, data: Buffer, _options: TransferOptions): Promise<void> {
    await fs.writeFile(path.join(loc.path, name), data);
  }

  async exists(loc: PaneLocation, name: string): Promise<boolean> {
    return fs.access(path.join(loc.path, name)).then(() => true, () => false);
  }

  async remove(_loc: PaneLocation, entries: Entry[]): Promise<void> {
    for (const entry of entries) {
      const ref = entry.ref as LocalRef;
      await fs.rm(ref.fullPath, { recursive: ref.isDirectory, force: false });
    }
  }

  async rename(_loc: PaneLocation, entry: Entry, newName: string): Promise<void> {
    const ref = entry.ref as LocalRef;
    await fs.rename(ref.fullPath, path.join(path.dirname(ref.fullPath), newName));
  }

  async create(loc: PaneLocation, name: string): Promise<string> {
    await fs.mkdir(path.join(loc.path, name), { recursive: false });
    return name;
  }
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  return bytes.toLocaleString('da-DK');
}

function formatDate(date: Date | undefined): string {
  if (!date) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
