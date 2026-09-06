import { DeleteJobs, GetJobs, SubmitJobs } from '@zowe/zos-jobs-for-zowe-sdk';
import type { IJob } from '@zowe/zos-jobs-for-zowe-sdk';
import type { AbstractSession } from '@zowe/imperative';
import type { Capabilities, ColumnDef, PaneLocation, ViewDto } from '../shared/protocol';
import type { Entry, Listing, PaneProvider, SourceItem } from '../core/provider';
import type { SessionManager } from '../zowe/sessions';
import { UserFacingError } from '../core/errors';

type JesRef =
  | { kind: 'job'; jobname: string; jobid: string; job: IJob }
  | { kind: 'spool'; jobname: string; jobid: string; spoolId: number; ddname: string };

const JOB_COLUMNS: ColumnDef[] = [
  { id: 'name', title: 'Job', width: 30 },
  { id: 'jobid', title: 'JobID', width: 14 },
  { id: 'status', title: 'Status', width: 16 },
  { id: 'rc', title: 'RC', width: 14, align: 'right' },
  { id: 'class', title: 'Class', width: 10 },
];

// The name column goes first here as in every other listing: it carries the
// icon and the '..' row, and both look wrong hanging off a right-aligned ID.
const SPOOL_COLUMNS: ColumnDef[] = [
  { id: 'name', title: 'DDNAME', width: 26 },
  { id: 'id', title: 'ID', width: 8, align: 'right' },
  { id: 'step', title: 'Stepname', width: 22 },
  { id: 'records', title: 'Records', width: 20, align: 'right' },
  { id: 'class', title: 'Class', width: 12 },
];

/**
 * The jobs pane. Jobs are folders, spool DDs are the files inside them — which
 * is what lets F3, F5 and F8 keep meaning "view", "copy out" and "purge"
 * without a second set of commands just for JES.
 */
export class JesProvider implements PaneProvider {
  readonly kind = 'jes' as const;

  constructor(
    private readonly sessions: SessionManager,
    private readonly settings: { defaultOwner: () => string },
  ) {}

  label(loc: PaneLocation): string {
    return loc.profile || '(default)';
  }

  capabilities(loc: PaneLocation): Capabilities {
    return {
      write: false, delete: true, rename: false, create: false,
      submit: !parseLocation(loc).job,
    };
  }

  async list(loc: PaneLocation, signal: AbortSignal): Promise<Listing> {
    const session = await this.sessions.session(loc.profile);
    const parsed = parseLocation(loc);
    signal.throwIfAborted();

    if (!parsed.job) {
      const user = sessionUser(session);
      const owner = parsed.owner || this.settings.defaultOwner().trim().toUpperCase() || user || '*';
      const prefix = parsed.prefix || '*';
      const jobs = await GetJobs.getJobsCommon(session, {
        owner,
        prefix,
        ...(parsed.status === 'all' ? {} : { status: parsed.status.toUpperCase() }),
      });
      signal.throwIfAborted();

      const entries: Entry<JesRef>[] = jobs.map((job) => ({
        ref: { kind: 'job', jobname: job.jobname, jobid: job.jobid, job },
        dto: {
          id: job.jobid,
          name: job.jobname,
          kind: 'dir',
          attention: isFailure(job),
          cells: {
            name: job.jobname,
            jobid: job.jobid,
            status: job.status ?? '',
            rc: job.retcode ?? (job.status === 'ACTIVE' ? '—' : ''),
            class: job.class ?? '',
          },
        },
      }));

      return {
        title: `JES2 · owner=${owner} · prefix=${prefix}${parsed.status === 'all' ? '' : ` · ${parsed.status}`}`,
        columns: JOB_COLUMNS,
        entries,
        status: `${jobs.length} jobs`,
        truncated: false,
        views: this.views(loc, { ...parsed, owner, prefix }, user),
      };
    }

    const files = await GetJobs.getSpoolFiles(session, parsed.job.jobname, parsed.job.jobid) as ZosmfSpoolFile[];
    signal.throwIfAborted();
    const { jobname, jobid } = parsed.job;

    const entries: Entry<JesRef>[] = files.map((file) => ({
      ref: {
        kind: 'spool', jobname, jobid,
        spoolId: file.id, ddname: file.ddname,
      },
      dto: {
        id: String(file.id),
        name: file.ddname,
        kind: 'file',
        size: file['record-count'],
        cells: {
          id: String(file.id),
          name: file.ddname,
          step: file.stepname ?? '',
          records: (file['record-count'] ?? 0).toLocaleString('da-DK'),
          class: file.class ?? '',
        },
      },
    }));

    return {
      title: `${jobid} · ${jobname} · spool`,
      columns: SPOOL_COLUMNS,
      entries,
      status: `${files.length} spool-filer`,
      truncated: false,
      // Picking a view from inside a job steps back out into that view.
      views: this.views(loc, parsed, sessionUser(session)),
    };
  }

  /**
   * The four ways of looking at the queue.
   *
   * `Mine` and `Alle` set the owner; `Aktive` and `Output` narrow to a queue and
   * keep whatever owner is already in force, so drilling into someone else's
   * jobs and then asking for their output does what it says.
   */
  private views(loc: PaneLocation, filter: JesFilter, user: string): ViewDto[] {
    const owner = filter.owner || user || '*';
    const at = (patch: Partial<JesFilter>): PaneLocation => ({
      ...loc,
      // A view is a place to stand, never a job — selecting one leaves the spool.
      path: toPath({ ...filter, job: undefined, ...patch }),
    });
    const current = filter.status !== 'all'
      ? filter.status
      : (owner === '*' ? 'all' : 'mine');

    return [
      { id: 'mine', label: 'Mine', location: at({ owner: user || owner, status: 'all' }), active: current === 'mine' },
      { id: 'active', label: 'Aktive', location: at({ status: 'active' }), active: current === 'active' },
      { id: 'output', label: 'Output', location: at({ status: 'output' }), active: current === 'output' },
      { id: 'all', label: 'Alle', location: at({ owner: '*', status: 'all' }), active: current === 'all' },
    ];
  }

  parent(loc: PaneLocation): PaneLocation | undefined {
    const filter = parseLocation(loc);
    // Up from a job's spool returns to the job list the user was filtering by.
    return filter.job ? { ...loc, path: toPath({ ...filter, job: undefined }) } : undefined;
  }

  enter(loc: PaneLocation, entry: Entry): PaneLocation | undefined {
    const ref = entry.ref as JesRef;
    if (ref.kind !== 'job') return undefined;
    const filter = parseLocation(loc);
    return { ...loc, path: toPath({ ...filter, job: { jobname: ref.jobname, jobid: ref.jobid } }) };
  }

  describe(_loc: PaneLocation, entry: Entry): SourceItem {
    const ref = entry.ref as JesRef;
    return ref.kind === 'spool'
      // Spool output lands next door as a plain text file, named so it stays sortable.
      ? { name: `${ref.jobid}.${ref.ddname}.txt`, size: entry.dto.size, text: true }
      : { name: `${ref.jobid}.jcl`, text: true };
  }

  async read(loc: PaneLocation, entry: Entry): Promise<Buffer> {
    const session = await this.sessions.session(loc.profile);
    const ref = entry.ref as JesRef;
    const content = ref.kind === 'spool'
      ? await GetJobs.getSpoolContentById(session, ref.jobname, ref.jobid, ref.spoolId)
      : await GetJobs.getJcl(session, ref.jobname, ref.jobid);
    return Buffer.from(String(content), 'utf8');
  }

  async write(): Promise<void> {
    throw new UserFacingError(
      'Man kan ikke skrive ind i JES-køen.',
      'Brug F9 til at submitte JCL fra et dataset eller en USS-fil i stedet.',
    );
  }

  async exists(): Promise<boolean> {
    return false;
  }

  /** F8 purges the job. Purging a single spool DD is not a thing JES offers. */
  async remove(loc: PaneLocation, entries: Entry[]): Promise<void> {
    const session = await this.sessions.session(loc.profile);
    for (const entry of entries) {
      const ref = entry.ref as JesRef;
      if (ref.kind !== 'job') {
        throw new UserFacingError('Enkelte spool-filer kan ikke slettes — kun hele jobbet.');
      }
      await DeleteJobs.deleteJob(session, ref.jobname, ref.jobid);
    }
  }

  async rename(): Promise<void> {
    throw new UserFacingError('Jobs kan ikke omdøbes.');
  }

  async create(): Promise<string> {
    throw new UserFacingError('Brug F9 til at submitte et job.');
  }

  /** F9 on a job resubmits its JCL unchanged. */
  async submit(loc: PaneLocation, entries: Entry[]): Promise<string[]> {
    const session = await this.sessions.session(loc.profile);
    const ids: string[] = [];
    for (const entry of entries) {
      const ref = entry.ref as JesRef;
      const jcl = await GetJobs.getJcl(session, ref.jobname, ref.jobid);
      const job = await SubmitJobs.submitJcl(session, String(jcl));
      ids.push(job.jobid);
    }
    return ids;
  }
}

/** The queues a JES pane can be narrowed to. `all` sends no status at all. */
type JesStatus = 'all' | 'input' | 'active' | 'output';

/**
 * Everything a JES pane path says, parsed.
 *
 * The filter travels with the pane even while a job's spool is open (`job`),
 * which is what lets Backspace put the user back in the view they came from
 * rather than dumping them in the default one.
 */
interface JesFilter {
  /** Empty means "not stated" — the session user is filled in at list time. */
  owner: string;
  /** Empty means `*`. */
  prefix: string;
  status: JesStatus;
  job?: { jobname: string; jobid: string };
}

/**
 * `owner=SANJ;prefix=BK*;status=active` lists jobs, plus `;job=SANJBKUP/JOB04412`
 * for that job's spool. A bare `SANJBKUP/JOB04412` is still understood, so
 * paths written by hand in `mc.panes.*` keep working.
 */
function parseLocation(loc: PaneLocation): JesFilter {
  const empty: JesFilter = { owner: '', prefix: '', status: 'all' };
  if (!loc.path) return empty;

  if (!loc.path.includes('=')) {
    const slash = loc.path.indexOf('/');
    return slash > 0
      ? { ...empty, job: { jobname: loc.path.slice(0, slash), jobid: loc.path.slice(slash + 1) } }
      : empty;
  }

  const query = new URLSearchParams(loc.path.replace(/;/g, '&'));
  const job = query.get('job') ?? '';
  const slash = job.indexOf('/');
  return {
    owner: query.get('owner') ?? '',
    prefix: query.get('prefix') ?? '',
    status: asStatus(query.get('status')),
    job: slash > 0
      ? { jobname: job.slice(0, slash), jobid: job.slice(slash + 1) }
      : undefined,
  };
}

/** The inverse of `parseLocation`; only states what differs from the default. */
function toPath(filter: JesFilter): string {
  const parts: string[] = [];
  if (filter.owner) parts.push(`owner=${filter.owner}`);
  if (filter.prefix && filter.prefix !== '*') parts.push(`prefix=${filter.prefix}`);
  if (filter.status !== 'all') parts.push(`status=${filter.status}`);
  if (filter.job) parts.push(`job=${filter.job.jobname}/${filter.job.jobid}`);
  return parts.join(';');
}

function asStatus(value: string | null): JesStatus {
  const lower = (value ?? '').toLowerCase();
  return lower === 'input' || lower === 'active' || lower === 'output' ? lower : 'all';
}

/**
 * The user the profile logs in as, which is who "my jobs" means.
 *
 * Empty when the profile authenticates by token or certificate rather than by
 * user name; the caller then falls back to `*` rather than guessing.
 */
function sessionUser(session: AbstractSession): string {
  return (session.ISession?.user ?? '').trim().toUpperCase();
}

function isFailure(job: IJob): boolean {
  const rc = job.retcode ?? '';
  return /ABEND|JCL ERROR|SEC ERROR/i.test(rc) || /^CC (?!0000)/.test(rc);
}

interface ZosmfSpoolFile {
  id: number; ddname: string; stepname?: string; class?: string; 'record-count'?: number;
}
