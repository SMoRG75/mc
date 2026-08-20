import { Create, CreateDataSetTypeEnum, Delete, Get, List, Rename, Upload } from '@zowe/zos-files-for-zowe-sdk';
import type { AbstractSession } from '@zowe/imperative';
import type { Capabilities, ColumnDef, PaneLocation, TransferOptions } from '../shared/protocol';
import type { Entry, Listing, PaneProvider, SourceItem } from '../core/provider';
import type { SessionManager } from '../zowe/sessions';
import { UserFacingError } from '../core/errors';
import { fitToRecordLength, resolveMode } from '../core/text';

export interface DsSettings {
  pageSize: () => number;
  binaryExtensions: () => readonly string[];
}

/** A pane on MVS datasets: a filter listing at the top level, members inside a PDS. */
type DsRef =
  | { kind: 'dataset'; dsname: string; dsorg?: string; recfm?: string; lrecl?: string; migrated: boolean }
  | { kind: 'member'; dsname: string; member: string };

const DATASET_COLUMNS: ColumnDef[] = [
  { id: 'name', title: 'Dataset', width: 40 },
  { id: 'dsorg', title: 'Org', width: 10 },
  { id: 'recfm', title: 'RECFM', width: 10 },
  { id: 'lrecl', title: 'LRECL', width: 10, align: 'right' },
  { id: 'used', title: 'Used', width: 10, align: 'right' },
  { id: 'vol', title: 'Volume', width: 20 },
];

const MEMBER_COLUMNS: ColumnDef[] = [
  { id: 'name', title: 'Member', width: 38 },
  { id: 'vers', title: 'VV.MM', width: 14 },
  { id: 'changed', title: 'Changed', width: 26 },
  { id: 'size', title: 'Size', width: 10, align: 'right' },
  { id: 'user', title: 'ID', width: 12 },
];

export class DsProvider implements PaneProvider {
  readonly kind = 'ds' as const;

  constructor(
    private readonly sessions: SessionManager,
    private readonly settings: DsSettings,
  ) {}

  label(loc: PaneLocation): string {
    return loc.profile || '(default)';
  }

  capabilities(): Capabilities {
    return { write: true, delete: true, rename: true, create: true, submit: true };
  }

  async list(loc: PaneLocation, signal: AbortSignal): Promise<Listing> {
    const session = await this.sessions.session(loc.profile);
    signal.throwIfAborted();
    return isFilter(loc.path)
      ? this.listDataSets(session, loc.path || '*', signal)
      : this.listMembers(session, loc.path, signal);
  }

  private async listDataSets(session: AbstractSession, filter: string, signal: AbortSignal): Promise<Listing> {
    const response = await List.dataSet(session, filter, { attributes: true });
    signal.throwIfAborted();
    const items = (response.apiResponse?.items ?? []) as ZosmfDataSet[];
    const limit = this.settings.pageSize();

    const entries: Entry<DsRef>[] = items.slice(0, limit).map((item) => {
      const migrated = item.migr === 'YES' || item.vol === 'MIGRAT';
      return {
        ref: {
          kind: 'dataset', dsname: item.dsname, dsorg: item.dsorg,
          recfm: item.recfm, lrecl: item.lrecl, migrated,
        },
        dto: {
          id: item.dsname,
          name: item.dsname,
          kind: isPartitioned(item.dsorg) ? 'dir' : 'file',
          attention: migrated,
          cells: {
            name: item.dsname,
            dsorg: item.dsorg ?? (migrated ? 'MIGR' : '?'),
            recfm: item.recfm ?? '',
            lrecl: item.lrecl ?? '',
            used: item.used ? `${item.used}%` : '',
            vol: item.vol ?? '',
          },
        },
      };
    });

    return {
      title: filter,
      columns: DATASET_COLUMNS,
      entries,
      status: `${items.length} datasæt`,
      truncated: items.length > limit,
    };
  }

  private async listMembers(session: AbstractSession, dsname: string, signal: AbortSignal): Promise<Listing> {
    const [members, attributes] = await Promise.all([
      List.allMembers(session, dsname, { attributes: true }),
      this.attributes(session, dsname).catch(() => undefined),
    ]);
    signal.throwIfAborted();

    const items = (members.apiResponse?.items ?? []) as ZosmfMember[];
    const limit = this.settings.pageSize();

    const entries: Entry<DsRef>[] = items.slice(0, limit).map((item) => ({
      ref: { kind: 'member', dsname, member: item.member },
      dto: {
        id: `${dsname}(${item.member})`,
        name: item.member,
        kind: 'file',
        size: item.mnorc,
        cells: {
          name: item.member,
          vers: item.vers !== undefined ? `${pad2(item.vers)}.${pad2(item.mod ?? 0)}` : '',
          changed: [item.m4date, item.mtime].filter(Boolean).join(' '),
          size: item.mnorc !== undefined ? String(item.mnorc) : '',
          user: item.user ?? '',
        },
      },
    }));

    const shape = attributes
      ? `${attributes.dsorg ?? ''} · ${attributes.recfm ?? ''} ${attributes.lrecl ?? ''}`.trim()
      : '';

    return {
      title: shape ? `${dsname} (${shape})` : dsname,
      columns: MEMBER_COLUMNS,
      entries,
      status: attributes?.vol ? `VOL=${attributes.vol}` : `${items.length} medlemmer`,
      truncated: items.length > limit,
    };
  }

  parent(loc: PaneLocation): PaneLocation | undefined {
    if (isFilter(loc.path)) {
      // IBMUSER.PROD.* -> IBMUSER.* -> undefined
      const stem = loc.path.replace(/\.?\*+$/, '');
      const cut = stem.lastIndexOf('.');
      return cut < 0 ? undefined : { ...loc, path: `${stem.slice(0, cut)}.*` };
    }
    // Inside a PDS: go back to the filter that would have shown it.
    const cut = loc.path.lastIndexOf('.');
    return { ...loc, path: cut < 0 ? '*' : `${loc.path.slice(0, cut)}.*` };
  }

  enter(loc: PaneLocation, entry: Entry): PaneLocation | undefined {
    const ref = entry.ref as DsRef;
    if (ref.kind === 'member') return undefined;
    if (ref.migrated) {
      throw new UserFacingError(
        `${ref.dsname} er migreret (HSM).`,
        'Datasættet skal recalles før det kan læses. Brug F2 → Recall, eller tilgå det via TSO.',
      );
    }
    return isPartitioned(ref.dsorg) ? { ...loc, path: ref.dsname } : undefined;
  }

  describe(_loc: PaneLocation, entry: Entry): SourceItem {
    const ref = entry.ref as DsRef;
    // Datasets hold records, not bytes: they are always text unless the user says otherwise.
    return { name: ref.kind === 'member' ? ref.member : ref.dsname, size: entry.dto.size, text: true };
  }

  async read(loc: PaneLocation, entry: Entry): Promise<Buffer> {
    const session = await this.sessions.session(loc.profile);
    return Get.dataSet(session, qualify(entry.ref as DsRef));
  }

  async write(
    loc: PaneLocation, name: string, data: Buffer, options: TransferOptions,
  ): Promise<void> {
    const session = await this.sessions.session(loc.profile);
    const target = isFilter(loc.path) ? name : `${loc.path}(${memberName(name)})`;
    const mode = resolveMode(options, name, this.settings.binaryExtensions());

    if (mode === 'binary') {
      await Upload.bufferToDataSet(session, data, target, { binary: true });
      return;
    }

    const attributes = await this.attributes(session, isFilter(loc.path) ? name : loc.path);
    const lrecl = Number(attributes?.lrecl ?? 80) || 80;
    const lines = fitToRecordLength(data.toString('utf8'), lrecl, options.longLines);
    await Upload.bufferToDataSet(
      session,
      Buffer.from(`${lines.join('\n')}\n`, 'utf8'),
      target,
      { encoding: options.codepage },
    );
  }

  async exists(loc: PaneLocation, name: string): Promise<boolean> {
    const session = await this.sessions.session(loc.profile);
    if (isFilter(loc.path)) {
      const response = await List.dataSet(session, name, {});
      return ((response.apiResponse?.items ?? []) as ZosmfDataSet[]).length > 0;
    }
    const response = await List.allMembers(session, loc.path, { pattern: memberName(name) });
    return ((response.apiResponse?.items ?? []) as ZosmfMember[]).length > 0;
  }

  async remove(loc: PaneLocation, entries: Entry[]): Promise<void> {
    const session = await this.sessions.session(loc.profile);
    for (const entry of entries) {
      await Delete.dataSet(session, qualify(entry.ref as DsRef));
    }
  }

  async rename(loc: PaneLocation, entry: Entry, newName: string): Promise<void> {
    const session = await this.sessions.session(loc.profile);
    const ref = entry.ref as DsRef;
    if (ref.kind === 'member') {
      await Rename.dataSetMember(session, ref.dsname, ref.member, memberName(newName));
    } else {
      await Rename.dataSet(session, ref.dsname, newName);
    }
  }

  /**
   * F7. Inside a PDS this creates an empty member; at filter level it allocates
   * a dataset, defaulting to a PDS/E with the shape JCL and source normally use.
   */
  async create(loc: PaneLocation, spec: string): Promise<void> {
    const session = await this.sessions.session(loc.profile);
    if (!isFilter(loc.path)) {
      await Upload.bufferToDataSet(session, Buffer.alloc(0), `${loc.path}(${memberName(spec)})`);
      return;
    }
    await Create.dataSet(session, CreateDataSetTypeEnum.DATA_SET_PARTITIONED, spec, {
      primary: 10, secondary: 5, recfm: 'FB', lrecl: 80, blksize: 27920, dsntype: 'LIBRARY',
    });
  }

  async submit(loc: PaneLocation, entries: Entry[]): Promise<string[]> {
    // Imported lazily: the jobs SDK is only needed when someone actually submits.
    const { SubmitJobs } = await import('@zowe/zos-jobs-for-zowe-sdk');
    const session = await this.sessions.session(loc.profile);
    const ids: string[] = [];
    for (const entry of entries) {
      const job = await SubmitJobs.submitJob(session, qualify(entry.ref as DsRef));
      ids.push(job.jobid);
    }
    return ids;
  }

  private async attributes(session: AbstractSession, dsname: string): Promise<ZosmfDataSet | undefined> {
    const response = await List.dataSet(session, dsname, { attributes: true });
    return ((response.apiResponse?.items ?? []) as ZosmfDataSet[])[0];
  }
}

/** A path with a wildcard (or empty) is a filter; anything else names one dataset. */
function isFilter(path: string): boolean {
  return path === '' || path.includes('*') || path.includes('%');
}

function isPartitioned(dsorg: string | undefined): boolean {
  return dsorg?.startsWith('PO') ?? false;
}

function qualify(ref: DsRef): string {
  return ref.kind === 'member' ? `${ref.dsname}(${ref.member})` : ref.dsname;
}

/** Member names are 1-8 uppercase characters; local file names rarely are. */
function memberName(name: string): string {
  const stem = name.replace(/\.[^.]*$/, '').toUpperCase().replace(/[^A-Z0-9$#@]/g, '');
  if (!stem) throw new UserFacingError(`'${name}' kan ikke omsættes til et medlemsnavn.`);
  return stem.slice(0, 8);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Shapes of the z/OSMF list responses we actually read. */
interface ZosmfDataSet {
  dsname: string; dsorg?: string; recfm?: string; lrecl?: string;
  used?: string; vol?: string; migr?: string;
}
interface ZosmfMember {
  member: string; vers?: number; mod?: number; m4date?: string;
  mtime?: string; mnorc?: number; user?: string;
}
