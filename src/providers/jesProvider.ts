import { DeleteJobs, GetJobs, SubmitJobs } from '@zowe/zos-jobs-for-zowe-sdk';
import type { IJob } from '@zowe/zos-jobs-for-zowe-sdk';
import type { Capabilities, ColumnDef, PaneLocation } from '../shared/protocol';
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

const SPOOL_COLUMNS: ColumnDef[] = [
  { id: 'id', title: 'ID', width: 10, align: 'right' },
  { id: 'name', title: 'DDNAME', width: 24 },
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
      submit: parseLocation(loc).kind === 'jobs',
    };
  }

  async list(loc: PaneLocation, signal: AbortSignal): Promise<Listing> {
    const session = await this.sessions.session(loc.profile);
    const parsed = parseLocation(loc);
    signal.throwIfAborted();

    if (parsed.kind === 'jobs') {
      const owner = parsed.owner || this.settings.defaultOwner() || '*';
      const jobs = await GetJobs.getJobsCommon(session, { owner, prefix: parsed.prefix || '*' });
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
        title: `JES2 / owner=${owner} / prefix=${parsed.prefix || '*'}`,
        columns: JOB_COLUMNS,
        entries,
        status: `${jobs.length} jobs`,
        truncated: false,
      };
    }

    const files = await GetJobs.getSpoolFiles(session, parsed.jobname, parsed.jobid) as ZosmfSpoolFile[];
    signal.throwIfAborted();

    const entries: Entry<JesRef>[] = files.map((file) => ({
      ref: {
        kind: 'spool', jobname: parsed.jobname, jobid: parsed.jobid,
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
      title: `${parsed.jobid} · ${parsed.jobname} · spool`,
      columns: SPOOL_COLUMNS,
      entries,
      status: `${files.length} spool-filer`,
      truncated: false,
    };
  }

  parent(loc: PaneLocation): PaneLocation | undefined {
    return parseLocation(loc).kind === 'jobs' ? undefined : { ...loc, path: '' };
  }

  enter(loc: PaneLocation, entry: Entry): PaneLocation | undefined {
    const ref = entry.ref as JesRef;
    return ref.kind === 'job' ? { ...loc, path: `${ref.jobname}/${ref.jobid}` } : undefined;
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

  async create(): Promise<void> {
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

type ParsedJes =
  | { kind: 'jobs'; owner: string; prefix: string }
  | { kind: 'spool'; jobname: string; jobid: string };

/** '' or 'owner=SANJ;prefix=BK*' lists jobs; 'SANJBKUP/JOB04412' lists its spool. */
function parseLocation(loc: PaneLocation): ParsedJes {
  const slash = loc.path.indexOf('/');
  if (slash > 0) {
    return {
      kind: 'spool',
      jobname: loc.path.slice(0, slash),
      jobid: loc.path.slice(slash + 1),
    };
  }
  const filter = new URLSearchParams(loc.path.replace(/;/g, '&'));
  return { kind: 'jobs', owner: filter.get('owner') ?? '', prefix: filter.get('prefix') ?? '' };
}

function isFailure(job: IJob): boolean {
  const rc = job.retcode ?? '';
  return /ABEND|JCL ERROR|SEC ERROR/i.test(rc) || /^CC (?!0000)/.test(rc);
}

interface ZosmfSpoolFile {
  id: number; ddname: string; stepname?: string; class?: string; 'record-count'?: number;
}
