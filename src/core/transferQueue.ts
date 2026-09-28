import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import type { PaneLocation, TransferJobDto, TransferOptions } from '../shared/protocol';
import type { Entry, PaneProvider } from './provider';
import { describeError } from './errors';
import { log } from './log';

export interface TransferRequest {
  source: PaneProvider;
  sourceLoc: PaneLocation;
  target: PaneProvider;
  targetLoc: PaneLocation;
  entry: Entry;
  name: string;
  options: TransferOptions;
  /** Delete the source once the copy has landed (F6). */
  move: boolean;
}

interface Job extends TransferRequest {
  id: string;
  state: TransferJobDto['state'];
  progress?: number;
  bytes?: number;
  error?: string;
  abort: AbortController;
}

/** How often a running transfer may redraw the status bar. */
const PROGRESS_MS = 250;

/**
 * Runs transfers a few at a time so the UI never blocks on an 18 MB tarball.
 *
 * The queue is deliberately dumb: it holds jobs, runs `concurrency` of them,
 * and reports state. All the knowledge about *how* to move bytes lives in the
 * providers, which is what makes LPAR1 -> LPAR2 no different from disk -> PDS.
 */
export class TransferQueue {
  private readonly jobs: Job[] = [];
  private running = 0;
  private progressTimer?: NodeJS.Timeout;

  constructor(
    private readonly concurrency: () => number,
    private readonly onChange: (jobs: TransferJobDto[]) => void,
    private readonly onFinished: (job: TransferRequest) => void,
  ) {}

  enqueue(requests: TransferRequest[]): void {
    for (const request of requests) {
      this.jobs.push({ ...request, id: randomUUID(), state: 'queued', abort: new AbortController() });
    }
    this.publish();
    this.pump();
  }

  cancel(id: string): void {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return;
    if (job.state === 'queued') {
      job.state = 'cancelled';
    } else if (job.state === 'running') {
      job.abort.abort();
    }
    this.publish();
  }

  cancelAll(): void {
    for (const job of this.jobs) this.cancel(job.id);
  }

  private pump(): void {
    while (this.running < Math.max(1, this.concurrency())) {
      const next = this.jobs.find((j) => j.state === 'queued');
      if (!next) return;
      next.state = 'running';
      this.running += 1;
      this.publish();
      void this.run(next);
    }
  }

  private async run(job: Job): Promise<void> {
    const what = `${place(job.sourceLoc)} ${job.entry.dto.name} → ${place(job.targetLoc)} ${job.name}`;
    const started = performance.now();
    log.debug(`Transfer started: ${what}`);
    try {
      await this.copy(job);
      if (job.move) {
        await job.source.remove(job.sourceLoc, [job.entry]);
      }
      job.state = 'done';
      job.progress = 1;
      log.info(`Transferred ${what}: ${job.bytes ?? 0} bytes in ${Math.round(performance.now() - started)} ms`);
    } catch (err) {
      job.state = job.abort.signal.aborted ? 'cancelled' : 'failed';
      const { message, detail } = describeError(err);
      job.error = message;
      if (job.state === 'cancelled') log.info(`Transfer cancelled: ${what}`);
      else log.error(`Transfer failed: ${what}: ${message}`, detail);
    } finally {
      this.running -= 1;
      this.onFinished(job);
      this.publish();
      this.pump();
      this.reap();
    }
  }

  /**
   * Streams the source into the target, the two running side by side with
   * nothing but a stream's buffer of the content between them.
   *
   * Either side can fail first, and the other must not be left waiting for
   * bytes that are never coming or a reader that has gone: the first failure
   * stops both, and it is the one reported — whatever the other side says
   * about being stopped is only a consequence of it.
   */
  private async copy(job: Job): Promise<void> {
    const size = job.source.describe(job.sourceLoc, job.entry).size;
    const pipe = new Transform({
      transform: (chunk: Buffer, _encoding, done) => {
        job.bytes = (job.bytes ?? 0) + chunk.length;
        // Short of 1 until the target says it is done: the last bytes read are
        // not yet the last bytes written, and a spooled upload has not started.
        if (size) job.progress = Math.min(job.bytes / size, 0.99);
        this.publishProgress();
        done(null, chunk);
      },
    });
    // Destroying it is how `fail` tells the side that is still running; the
    // error itself is already on its way out of here, and a target that failed
    // before it ever read from the pipe has no listener of its own on it.
    pipe.on('error', () => undefined);

    const stop = new AbortController();
    const signal = AbortSignal.any([job.abort.signal, stop.signal]);
    let first: { error: unknown } | undefined;
    const fail = (error: unknown): never => {
      first ??= { error };
      stop.abort(error);
      pipe.destroy(error instanceof Error ? error : new Error(String(error)));
      throw error;
    };

    await Promise.allSettled([
      job.source.readTo(job.sourceLoc, job.entry, job.options, pipe, signal).catch(fail),
      job.target.writeFrom(job.targetLoc, job.name, pipe, job.options, signal).catch(fail),
    ]);
    if (first) throw first.error;
  }

  /** Drop finished jobs once nothing is left to watch, so the list stays short. */
  private reap(): void {
    if (this.jobs.some((j) => j.state === 'queued' || j.state === 'running')) return;
    const keep = this.jobs.filter((j) => j.state === 'failed');
    this.jobs.length = 0;
    this.jobs.push(...keep);
    this.publish();
  }

  /** Progress comes with every chunk; the status bar only needs a few a second. */
  private publishProgress(): void {
    this.progressTimer ??= setTimeout(() => {
      this.progressTimer = undefined;
      this.publish();
    }, PROGRESS_MS);
  }

  private publish(): void {
    // Whatever a pending progress update would have said, this says now — and
    // the last publish of a queue has to stay the last, even for a panel that
    // closed in between.
    clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
    this.onChange(this.jobs.map((j) => ({
      id: j.id,
      label: `${j.entry.dto.name} → ${j.name}`,
      state: j.state,
      progress: j.progress,
      bytes: j.bytes,
      error: j.error,
    })));
  }
}

/** Where a transfer is from or to, as the log shows it. */
function place(loc: PaneLocation): string {
  return `${loc.kind}:${loc.profile || '-'}:${loc.path || '/'}`;
}
