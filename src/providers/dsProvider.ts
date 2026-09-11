import { Create, CreateDataSetTypeEnum, Delete, Get, List, Rename, Upload } from '@zowe/zos-files-for-zowe-sdk';
import type { ICreateDataSetOptions, IZosFilesResponse } from '@zowe/zos-files-for-zowe-sdk';
import type { AbstractSession } from '@zowe/imperative';
import type {
  Capabilities, ColumnDef, DatasetSpec, PaneLocation, TransferOptions,
} from '../shared/protocol';
import type { Entry, Listing, PaneProvider, SourceItem } from '../core/provider';
import type { SessionManager } from '../zowe/sessions';
import { describeError, UserFacingError } from '../core/errors';
import { fitToRecordLength, resolveMode } from '../core/text';

export interface DsSettings {
  pageSize: () => number;
  binaryExtensions: () => readonly string[];
  /** Overrides the derived `<USER>.*` filter when the pane path is empty. */
  defaultFilter: () => string;
}

/** A pane on MVS datasets: a filter listing at the top level, members inside a PDS. */
type DsRef =
  | { kind: 'dataset'; dsname: string; dsorg?: string; recfm?: string; lrecl?: string; migrated: boolean }
  | { kind: 'member'; dsname: string; member: string; lrecl?: string };

const DATASET_COLUMNS: ColumnDef[] = [
  { id: 'name', title: 'Dataset', width: 40 },
  { id: 'dsorg', title: 'Org', width: 10 },
  { id: 'recfm', title: 'RECFM', width: 10 },
  { id: 'lrecl', title: 'LRECL', width: 10, align: 'right' },
  { id: 'used', title: 'Used', width: 10, align: 'right' },
  { id: 'vol', title: 'Volume', width: 20 },
];

/** The ISPF 3.4 member list: statistics kept for members edited under ISPF. */
const MEMBER_COLUMNS: ColumnDef[] = [
  { id: 'name', title: 'Member', width: 30 },
  { id: 'vers', title: 'VV.MM', width: 10 },
  { id: 'created', title: 'Created', width: 16 },
  { id: 'changed', title: 'Changed', width: 22 },
  { id: 'size', title: 'Size', width: 8, align: 'right' },
  { id: 'init', title: 'Init', width: 8, align: 'right' },
  { id: 'mod', title: 'Mod', width: 8, align: 'right' },
  { id: 'user', title: 'ID', width: 10 },
];

/** Load libraries carry no ISPF statistics; the binder's attributes take their place. */
const LOAD_COLUMNS: ColumnDef[] = [
  { id: 'name', title: 'Member', width: 28 },
  { id: 'alias', title: 'Alias-of', width: 16 },
  { id: 'size', title: 'Size', width: 12, align: 'right' },
  { id: 'amode', title: 'AMODE', width: 10 },
  { id: 'rmode', title: 'RMODE', width: 10 },
  { id: 'ac', title: 'AC', width: 6, align: 'right' },
  { id: 'attr', title: 'Attr', width: 18 },
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
      ? this.listDataSets(session, loc.path || this.defaultFilter(session), signal)
      : this.listMembers(session, loc.path, signal);
  }

  /**
   * An empty pane path must not become `dslevel=*`.
   *
   * A bare `*` asks z/OSMF to walk the entire catalog, which is slow at best
   * and on most systems fails outright in the TSO data set list services
   * (LMDINIT). The user's own high-level qualifier is both the safe default and
   * what they almost always wanted.
   */
  private defaultFilter(session: AbstractSession): string {
    const configured = this.settings.defaultFilter().trim();
    if (configured) return configured;
    const user = (session.ISession?.user ?? '').trim();
    return user ? `${user.toUpperCase()}.*` : '*';
  }

  private async listDataSets(session: AbstractSession, filter: string, signal: AbortSignal): Promise<Listing> {
    const { response, withAttributes } = await this.listWithAttributeFallback(session, filter);
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
      status: withAttributes
        ? `${items.length} data set${items.length === 1 ? '' : 's'}`
        : `${items.length} data set${items.length === 1 ? '' : 's'} · without attributes`,
      truncated: items.length > limit,
    };
  }

  /**
   * Lists with `X-IBM-Attributes: base` and falls back to a plain catalog list.
   *
   * Asking for attributes makes z/OSMF go through the TSO/ISPF data set list
   * services, which blow up on things a plain catalog read handles fine: a
   * migrated data set that DFSMShsm wants to prompt about, a volume that is not
   * mounted, a filter that matches too much. The symptom is an LMDINIT failure
   * or "received TSO Prompt when expecting TsoServletResponse" — never
   * something the user can act on.
   *
   * So: try the rich listing, and if anything at all goes wrong, get the names
   * without attributes rather than showing an empty pane. The original error is
   * re-thrown only if the plain listing fails too, since that one is real.
   */
  private async listWithAttributeFallback(
    session: AbstractSession, filter: string,
  ): Promise<{ response: IZosFilesResponse; withAttributes: boolean }> {
    try {
      return { response: await List.dataSet(session, filter, { attributes: true }), withAttributes: true };
    } catch (rich) {
      try {
        return { response: await List.dataSet(session, filter, {}), withAttributes: false };
      } catch {
        throw explainListFailure(rich, filter);
      }
    }
  }

  private async listMembers(session: AbstractSession, dsname: string, signal: AbortSignal): Promise<Listing> {
    const [members, attributes] = await Promise.all([
      List.allMembers(session, dsname, { attributes: true }),
      this.attributes(session, dsname).catch(() => undefined),
    ]);
    signal.throwIfAborted();

    const items = (members.apiResponse?.items ?? []) as ZosmfMember[];
    const limit = this.settings.pageSize();
    const load = isLoadLibrary(attributes?.recfm, items);

    const entries: Entry<DsRef>[] = items.slice(0, limit).map((item) => ({
      // The LRECL is the PDS's, not the member's, and it is what Shift+F3 has to
      // split raw records on — so it travels with every member rather than
      // costing a second listing later.
      ref: { kind: 'member', dsname, member: item.member, lrecl: attributes?.lrecl },
      dto: {
        id: `${dsname}(${item.member})`,
        name: item.member,
        kind: 'file',
        size: load ? hex(item.size) : item.cnorc,
        cells: load ? loadCells(item) : statisticsCells(item),
      },
    }));

    const shape = attributes
      ? `${attributes.dsorg ?? ''} · ${attributes.recfm ?? ''} ${attributes.lrecl ?? ''}`.trim()
      : '';

    return {
      title: shape ? `${dsname} (${shape})` : dsname,
      columns: load ? LOAD_COLUMNS : MEMBER_COLUMNS,
      entries,
      status: attributes?.vol ? `VOL=${attributes.vol}` : `${items.length} member${items.length === 1 ? '' : 's'}`,
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
        `${ref.dsname} is migrated (HSM).`,
        'The dataset has to be recalled before it can be read. Use F2 → Recall, or reach it through TSO.',
      );
    }
    return isPartitioned(ref.dsorg) ? { ...loc, path: ref.dsname } : undefined;
  }

  describe(_loc: PaneLocation, entry: Entry): SourceItem {
    const ref = entry.ref as DsRef;
    // Datasets hold records, not bytes: they are always text unless the user says otherwise.
    return { name: ref.kind === 'member' ? ref.member : ref.dsname, size: entry.dto.size, text: true };
  }

  recordLength(_loc: PaneLocation, entry: Entry): number | undefined {
    const lrecl = Number((entry.ref as DsRef).lrecl);
    return Number.isFinite(lrecl) && lrecl > 0 ? lrecl : undefined;
  }

  /**
   * `fileEncoding` on the way out says which EBCDIC page the records are in, so
   * z/OSMF hands back UTF-8 with the national characters intact. Without it the
   * conversion falls back to whatever the service defaults to, which turns æøå
   * into something else entirely.
   */
  async read(loc: PaneLocation, entry: Entry, options: TransferOptions): Promise<Buffer> {
    const session = await this.sessions.session(loc.profile);
    const ref = entry.ref as DsRef;
    const mode = resolveMode(options, this.describe(loc, entry).name, this.settings.binaryExtensions());
    return Get.dataSet(
      session, qualify(ref),
      mode === 'binary' ? { binary: true } : { encoding: options.codepage },
    );
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

  /** F6. A new dataset name is read the same way as an allocated one. */
  async rename(loc: PaneLocation, entry: Entry, newName: string): Promise<void> {
    const session = await this.sessions.session(loc.profile);
    const ref = entry.ref as DsRef;
    if (ref.kind === 'member') {
      await Rename.dataSetMember(session, ref.dsname, ref.member, memberName(newName));
    } else {
      await Rename.dataSet(session, ref.dsname, datasetName(newName, userPrefix(session)));
    }
  }

  /**
   * F7. Inside a PDS this creates an empty member; at filter level it allocates
   * a dataset from the attributes the dialog collected — or, with no dialog (the
   * command line), a PDS/E with the shape JCL and source normally use.
   */
  async create(loc: PaneLocation, name: string, spec?: DatasetSpec): Promise<string> {
    const session = await this.sessions.session(loc.profile);
    if (!isFilter(loc.path)) {
      const member = memberName(name);
      await Upload.bufferToDataSet(session, Buffer.alloc(0), `${loc.path}(${member})`);
      return member;
    }

    const prefix = userPrefix(session);
    const dsname = datasetName(name, prefix);
    if (spec?.like) {
      // z/OSMF copies every attribute from the model, so sending our own on top
      // would only overwrite what the user asked to inherit.
      await Create.dataSetLike(session, dsname, datasetName(spec.like, prefix), classesOf(spec));
      return dsname;
    }
    await Create.dataSet(session, typeOf(spec), dsname, attributesOf(spec));
    return dsname;
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

/**
 * z/OSMF reports these failures in terms of the TSO services it happens to use
 * internally, which tells the user nothing. Name the two things that actually
 * fix it.
 */
function explainListFailure(err: unknown, filter: string): UserFacingError {
  const { message, detail } = describeError(err);
  const haystack = `${message}\n${detail ?? ''}`;

  if (!/LMDINIT|LMDLIST|ISPF|TSO Prompt|IKJ566/i.test(haystack)) {
    return new UserFacingError(`Could not list '${filter}'.`, `${message}\n${detail ?? ''}`.trim());
  }
  return new UserFacingError(
    `z/OSMF could not list '${filter}'.`,
    'The filter probably matches too much, or the result contains migrated '
    + 'data sets that DFSMShsm wants to prompt about. Try a narrower filter, '
    + "or set a fixed starting point in the 'mc.ds.defaultFilter' setting.\n\n"
    + `${message}\n${detail ?? ''}`.trim(),
  );
}

/* ------------------------------------------------------------------ */
/* F7 allocation                                                       */
/* ------------------------------------------------------------------ */

/** Half a 3390 track: the block size everyone has used since the 1990s. */
const HALF_TRACK = 27998;

function typeOf(spec: DatasetSpec | undefined): CreateDataSetTypeEnum {
  return spec?.type === 'seq'
    ? CreateDataSetTypeEnum.DATA_SET_SEQUENTIAL
    : CreateDataSetTypeEnum.DATA_SET_PARTITIONED;
}

/**
 * The dialog's fields as z/OSMF allocation attributes.
 *
 * Only what the user actually decided is sent; Zowe fills the rest in from its
 * defaults for the chosen type. The two things worth knowing: a sequential
 * dataset must not carry `dirblk` at all (z/OSMF rejects the combination), and
 * an empty block size is computed rather than left to a default that may not be
 * a multiple of the record length.
 */
function attributesOf(spec: DatasetSpec | undefined): Partial<ICreateDataSetOptions> {
  if (!spec) {
    return {
      primary: 10, secondary: 5, recfm: 'FB', lrecl: 80, blksize: 27920, dsntype: 'LIBRARY',
    };
  }
  const recfm = spec.recfm.trim().toUpperCase() || 'FB';
  return {
    ...classesOf(spec),
    alcunit: spec.alcunit,
    primary: spec.primary,
    secondary: spec.secondary,
    recfm,
    lrecl: spec.lrecl,
    blksize: spec.blksize && spec.blksize > 0 ? spec.blksize : blockSize(recfm, spec.lrecl),
    ...(spec.type === 'seq' ? {} : { dirblk: spec.type === 'pdse' ? 1 : (spec.dirblk || 20) }),
    ...(spec.type === 'pdse' ? { dsntype: 'LIBRARY' } : {}),
  };
}

/** The SMS classes and the volume — the fields that also make sense with LIKE. */
function classesOf(spec: DatasetSpec): Partial<ICreateDataSetOptions> {
  const set = (value: string | undefined) => (value?.trim() ? value.trim().toUpperCase() : undefined);
  return {
    ...(set(spec.volser) ? { volser: set(spec.volser) } : {}),
    ...(set(spec.dataclass) ? { dataclass: set(spec.dataclass) } : {}),
    ...(set(spec.storclass) ? { storclass: set(spec.storclass) } : {}),
    ...(set(spec.mgntclass) ? { mgntclass: set(spec.mgntclass) } : {}),
  };
}

/** The largest sensible block for this record format, the way ISPF picks one. */
function blockSize(recfm: string, lrecl: number): number {
  if (recfm.startsWith('U')) return 32760;
  if (recfm.startsWith('V')) return Math.min(32760, Math.max(HALF_TRACK, lrecl + 4));
  if (lrecl <= 0 || lrecl > HALF_TRACK) return Math.max(lrecl, 1);
  return Math.floor(HALF_TRACK / lrecl) * lrecl;
}

/** The user's own high-level qualifier — TSO's prefix for unquoted names. */
function userPrefix(session: AbstractSession): string {
  return (session.ISession?.user ?? '').trim().toUpperCase();
}

/**
 * TSO's naming rule, and then the syntax check z/OSMF only answers with a rule
 * number for.
 *
 * A name in apostrophes is the whole name; anything else is relative to the
 * user's own high-level qualifier, so `TEST.JCL` allocates `IBMUSER.TEST.JCL`
 * exactly as it would under ISPF. The closing apostrophe is optional — the
 * dialog prefills an opening one and the user types onto the end of it.
 *
 * The rest is the format: up to 22 qualifiers of 1-8 characters, 44 in total,
 * no leading digit. The mistakes are always a too-long qualifier or a stray
 * wildcard left over from the pane filter.
 */
function datasetName(raw: string, prefix: string): string {
  const typed = raw.trim();
  const bare = typed.replace(/^'/, '').replace(/'$/, '').trim();
  const fullyQualified = typed.startsWith("'") || !prefix;
  const name = (fullyQualified ? bare : `${prefix}.${bare}`).toUpperCase();
  const qualifiers = name.split('.');
  const valid = name.length > 0 && name.length <= 44
    && qualifiers.length <= 22
    && qualifiers.every((q) => /^[A-Z$#@][A-Z0-9$#@-]{0,7}$/.test(q));
  if (!valid) {
    throw new UserFacingError(
      `'${name}' is not a valid dataset name.`,
      'A name is up to 22 qualifiers separated by dots, each 1-8 characters '
      + '(A-Z, 0-9, @ # $ -, not starting with a digit), and at most 44 characters in all.'
      + (fullyQualified ? '' : `\n\n'${raw}' was read as ${name} because it is not `
        + 'in apostrophes. Put an apostrophe in front to use it exactly as typed.'),
    );
  }
  return name;
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
  if (!stem) throw new UserFacingError(`'${name}' cannot be turned into a member name.`);
  return stem.slice(0, 8);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * RECFM=U is the giveaway, but the dataset attributes are a best-effort second
 * listing that may not have come back — so the members themselves get a vote.
 */
function isLoadLibrary(recfm: string | undefined, items: ZosmfMember[]): boolean {
  if (recfm) return recfm.startsWith('U');
  return items.some((item) => item.amode !== undefined || item.attr !== undefined);
}

/**
 * ISPF statistics. Members written by anything but ISPF carry none at all, so
 * every cell is optional and an empty column is the honest answer, not a bug.
 */
function statisticsCells(item: ZosmfMember): Record<string, string> {
  return {
    name: item.member,
    vers: item.vers !== undefined ? `${pad2(item.vers)}.${pad2(item.mod ?? 0)}` : '',
    created: item.c4date ?? '',
    changed: [item.m4date, item.mtime].filter(Boolean).join(' '),
    // Size is the current record count. mnorc, which this used to show, counts
    // only the lines changed since the last save — 0 for almost every member.
    size: count(item.cnorc),
    init: count(item.inorc),
    mod: count(item.mnorc),
    user: item.user ?? '',
  };
}

function loadCells(item: ZosmfMember): Record<string, string> {
  const size = hex(item.size);
  return {
    name: item.member,
    alias: item['alias-of'] ?? '',
    size: size !== undefined ? String(size) : '',
    amode: item.amode ?? '',
    rmode: item.rmode ?? '',
    ac: item.ac ?? '',
    attr: item.attr ?? '',
  };
}

function count(value: number | undefined): string {
  return value !== undefined ? String(value) : '';
}

/** Load module sizes come back as hex, the way the binder reports them. */
function hex(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 16);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Shapes of the z/OSMF list responses we actually read. */
interface ZosmfDataSet {
  dsname: string; dsorg?: string; recfm?: string; lrecl?: string;
  used?: string; vol?: string; migr?: string;
}
interface ZosmfMember {
  member: string;
  // ISPF statistics, present only on members an editor kept them for.
  vers?: number; mod?: number; c4date?: string; m4date?: string;
  mtime?: string; cnorc?: number; inorc?: number; mnorc?: number;
  user?: string; sclm?: string;
  // Binder attributes, returned instead for load libraries.
  ac?: string; amode?: string; rmode?: string; attr?: string;
  size?: string; ssi?: string; ttr?: string; 'alias-of'?: string;
}
