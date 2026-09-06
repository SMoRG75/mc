import { randomUUID } from 'node:crypto';
import type { PaneLocation, TransferJobDto, TransferOptions } from '../shared/protocol';
import type { Entry, PaneProvider } from './provider';
import { describeError } from './errors';

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
  error?: string;
  abort: AbortController;
}

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
    try {
      const data = await job.source.read(job.sourceLoc, job.entry, job.options, job.abort.signal);
      job.progress = 0.5;
      this.publish();
      await job.target.write(job.targetLoc, job.name, data, job.options, job.abort.signal);
      if (job.move) {
        await job.source.remove(job.sourceLoc, [job.entry]);
      }
      job.state = 'done';
      job.progress = 1;
    } catch (err) {
      job.state = job.abort.signal.aborted ? 'cancelled' : 'failed';
      job.error = describeError(err).message;
    } finally {
      this.running -= 1;
      this.onFinished(job);
      this.publish();
      this.pump();
      this.reap();
    }
  }

  /** Drop finished jobs once nothing is left to watch, so the list stays short. */
  private reap(): void {
    if (this.jobs.some((j) => j.state === 'queued' || j.state === 'running')) return;
    const keep = this.jobs.filter((j) => j.state === 'failed');
    this.jobs.length = 0;
    this.jobs.push(...keep);
    this.publish();
  }

  private publish(): void {
    this.onChange(this.jobs.map((j) => ({
      id: j.id,
      label: `${j.entry.dto.name} → ${j.name}`,
      state: j.state,
      progress: j.progress,
      error: j.error,
    })));
  }
}
