import type { Writable } from 'node:stream';
import { DeleteJobs, DownloadJobs, GetJobs, SubmitJobs } from '@zowe/zos-jobs-for-zowe-sdk';
import type { IJob, IJobFile } from '@zowe/zos-jobs-for-zowe-sdk';
import type { AbstractSession } from '@zowe/imperative';
import type {
  Capabilities, ColumnDef, FilterDto, PaneLocation, TransferOptions, ViewDto,
} from '../shared/protocol';
import type { Entry, Listing, PaneProvider, SourceItem } from '../core/provider';
import type { SessionManager } from '../zowe/sessions';
import { UserFacingError } from '../core/errors';
import { pacedDownload } from '../zowe/flow';

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
      // Uppercased here rather than only where the dialog writes it, so a filter
      // typed by hand into `mc.panes.*` or on the command line works too.
      const owner = (parsed.owner || this.settings.defaultOwner()).trim().toUpperCase() || user || '*';
      const prefix = parsed.prefix.trim().toUpperCase() || '*';
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
        status: `${jobs.length} job${jobs.length === 1 ? '' : 's'}`,
        truncated: false,
        views: this.views(loc, { ...parsed, owner, prefix }, user),
        filter: filterDto({ ...parsed, owner, prefix }),
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
          records: (file['record-count'] ?? 0).toLocaleString('en-US'),
          class: file.class ?? '',
        },
      },
    }));

    return {
      title: `${jobid} · ${jobname} · spool`,
      columns: SPOOL_COLUMNS,
      entries,
      status: `${files.length} spool file${files.length === 1 ? '' : 's'}`,
      truncated: false,
      // Picking a view from inside a job steps back out into that view.
      views: this.views(loc, parsed, sessionUser(session)),
      filter: filterDto({ ...parsed, owner: parsed.owner || sessionUser(session) }),
    };
  }

  /**
   * The four ways of looking at the queue.
   *
   * `Mine` and `All` are whole views: they say "every job of this owner", so
   * they clear the job name filter as well — a `Mine` that still hides
   * everything but RACF* is not mine. `Active` and `Output` only claim to be a
   * queue, so they keep the owner and the job name already in force: drilling
   * into someone else's jobs and then asking for their output does what it says.
   *
   * Which one is current is not guessed from the owner and the queue: a view is
   * where the pane is standing when the pane is showing exactly what the view
   * points at, prefix included. So a filter typed into Ctrl+F that none of the
   * four describes lights up none of them, rather than claiming to be `Mine`.
   */
  private views(loc: PaneLocation, filter: JesFilter, user: string): ViewDto[] {
    const here: JesFilter = {
      owner: filter.owner || user || '*',
      prefix: filter.prefix || '*',
      status: filter.status,
    };
    // A view is a place to stand, never a job — selecting one leaves the spool.
    const at = (patch: Partial<JesFilter>): JesFilter => ({ ...here, ...patch, job: undefined });
    const view = (id: string, label: string, target: JesFilter): ViewDto => ({
      id,
      label,
      location: { ...loc, path: toPath(target) },
      active: target.owner === here.owner
        && target.prefix === here.prefix
        && target.status === here.status,
    });

    return [
      view('mine', 'Mine', at({ owner: user || here.owner, prefix: '*', status: 'all' })),
      view('active', 'Active', at({ status: 'active' })),
      view('output', 'Output', at({ status: 'output' })),
      view('all', 'All', at({ owner: '*', prefix: '*', status: 'all' })),
    ];
  }

  /**
   * Ctrl+F. Owner and job name are what a JES pane is really about, and this is
   * where they get answered — the alternative is typing `owner=…;prefix=…` into
   * the command line and remembering the syntax.
   *
   * An empty owner is "not stated" rather than "nobody": the pane falls back to
   * `mc.jes.owner` and then to the session user, which is what clearing the
   * field should mean.
   */
  applyFilter(loc: PaneLocation, values: Record<string, string>): PaneLocation {
    const current = parseLocation(loc);
    return {
      ...loc,
      // Answering the filter is about which jobs to list, and a spool listing
      // shows none — so the pane steps back out of the job it was in.
      path: toPath({
        owner: (values.owner ?? current.owner).trim().toUpperCase(),
        prefix: (values.prefix ?? current.prefix).trim().toUpperCase(),
        status: asStatus(values.status ?? current.status),
        job: undefined,
      }),
    };
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
      // Spool output lands next door as a plain text file. The spool id is in
      // the name because the DD name alone is not unique — every step has its
      // SYSPRINT — and padded so the files sort in the order the job wrote them.
      // The size column is a record count, so it is no measure of the bytes.
      ? { name: `${ref.jobid}.${String(ref.spoolId).padStart(3, '0')}.${ref.ddname}.txt`, text: true }
      // A job is a folder of its spool files, and a copy of it is named the way
      // SDSF shows it.
      : { name: `${ref.jobname}.${ref.jobid}`, text: true };
  }

  async read(loc: PaneLocation, entry: Entry, options: TransferOptions): Promise<Buffer> {
    const session = await this.sessions.session(loc.profile);
    const ref = entry.ref as JesRef;
    // Spool output is EBCDIC like everything else; the JCL endpoint takes no
    // encoding, so that one stays on the service default.
    const content = ref.kind === 'spool'
      ? await GetJobs.getSpoolContentById(session, ref.jobname, ref.jobid, ref.spoolId, options.codepage)
      : await GetJobs.getJcl(session, ref.jobname, ref.jobid);
    return Buffer.from(String(content), 'utf8');
  }

  /**
   * A spool file can run to millions of lines, so it is streamed; the JCL is a
   * few records at most and comes back as one string whatever we do.
   */
  async readTo(
    loc: PaneLocation, entry: Entry, options: TransferOptions, sink: Writable, signal: AbortSignal,
  ): Promise<void> {
    const ref = entry.ref as JesRef;
    if (ref.kind !== 'spool') {
      const jcl = await this.read(loc, entry, options);
      await new Promise<void>((resolve, reject) => {
        sink.once('error', reject);
        sink.end(jcl, resolve);
      });
      return;
    }
    const session = await this.sessions.session(loc.profile);
    // Only the fields the download builds its URL from; the rest of an IJobFile
    // describes the spool file, which the SDK has no use for here.
    const jobFile = {
      jobname: ref.jobname, jobid: ref.jobid, id: ref.spoolId, ddname: ref.ddname,
    } as IJobFile;
    await pacedDownload(sink, signal, (stream) => DownloadJobs.downloadSpoolContentCommon(session, {
      jobFile, stream, encoding: options.codepage,
    }));
  }

  async write(): Promise<void> {
    throw new UserFacingError(
      'You cannot write into the JES queue.',
      'Use F9 to submit JCL from a dataset or a USS file instead.',
    );
  }

  async writeFrom(): Promise<void> {
    return this.write();
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
        throw new UserFacingError('A single spool file cannot be deleted — only the whole job.');
      }
      await DeleteJobs.deleteJob(session, ref.jobname, ref.jobid);
    }
  }

  async rename(): Promise<void> {
    throw new UserFacingError('Jobs cannot be renamed.');
  }

  async create(): Promise<string> {
    throw new UserFacingError('Use F9 to submit a job.');
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

/**
 * The Ctrl+F dialog for a JES pane.
 *
 * The values are the resolved ones, not what the path happens to say: the
 * dialog has to open on what is actually being listed, or clearing a field the
 * user never filled in would change the listing.
 */
function filterDto(filter: JesFilter): FilterDto {
  return {
    title: 'Job filter',
    fields: [
      {
        id: 'owner',
        label: 'Owner',
        value: filter.owner,
        hint: 'Whose jobs to list. * is everyone; empty falls back to mc.jes.owner and then to your own user.',
      },
      {
        id: 'prefix',
        label: 'Job name',
        value: filter.prefix || '*',
        // The wildcard is the whole trap: JES matches the name as it is given,
        // so a name typed without one finds the single job called exactly that
        // — which looks like a filter that is simply broken.
        hint: "Matched as typed: 'RACF' finds only a job called RACF, 'RACF*' finds all of them. * is every job.",
      },
      {
        id: 'status',
        label: 'Queue',
        value: filter.status,
        choices: [
          { value: 'all', label: 'All queues' },
          { value: 'input', label: 'Input — waiting to run' },
          { value: 'active', label: 'Active — running now' },
          { value: 'output', label: 'Output — finished' },
        ],
      },
    ],
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
