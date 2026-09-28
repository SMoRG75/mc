import { sameLocation, type PaneLocation, type TransferOptions } from '../shared/protocol';
import type { Entry, PaneProvider } from './provider';
import type { TransferRequest } from './transferQueue';
import { describeError } from './errors';

export type ConflictAnswer = { answer: 'overwrite' | 'skip'; all: boolean };

export interface CopyRequest {
  source: PaneProvider;
  sourceLoc: PaneLocation;
  target: PaneProvider;
  targetLoc: PaneLocation;
  entries: Entry[];
  options: TransferOptions;
  move: boolean;
  /**
   * Asked about each name that is already at the target when `onConflict` is
   * `ask`. `many` says whether "all" answers make sense: they do once there is
   * more than one thing being copied. No answer means skip.
   */
  ask(name: string, where: PaneLocation, many: boolean): Promise<ConflictAnswer | undefined>;
  signal: AbortSignal;
}

export interface CopyPlan {
  /** One per file, into folders that already exist by now. */
  requests: TransferRequest[];
  /** What was left out, and why — one line each, for the user to read. */
  problems: string[];
  /** Folders made directly in the target location, which the pane there now has to show. */
  foldersMade: number;
}

/**
 * Turns F5 on a selection into the file transfers the queue runs.
 *
 * Files map to one transfer each. A folder — a directory, a PDS, a job — is
 * walked: made at the target, then its content added the same way, all the
 * way down. The folders are made here, before anything is queued, so a
 * transfer only ever writes a file into a place that exists.
 *
 * Nothing in here is allowed to stop the rest: a folder that cannot be made or
 * listed, a name that cannot be stored, a file that would land on another one
 * — each is left out with a line saying why, and the copy goes on without it.
 */
export async function planCopy(request: CopyRequest): Promise<CopyPlan> {
  const planner = new Planner(request);
  const many = request.entries.length > 1 || request.entries.some((e) => e.dto.kind === 'dir');
  for (const entry of request.entries) {
    const name = applyPattern(request.options.destination, request.source.describe(request.sourceLoc, entry).name);
    await planner.add(entry, request.sourceLoc, request.targetLoc, name, true, many);
  }
  return planner.plan;
}

/** `*` keeps the source name; anything else is used verbatim. */
export function applyPattern(pattern: string, sourceName: string): string {
  if (!pattern || pattern === '*') return sourceName;
  return pattern.replace(/\*/g, sourceName);
}

class Planner {
  readonly plan: CopyPlan = { requests: [], problems: [], foldersMade: 0 };
  /** An "all" answer, which stands for the rest of this copy. */
  private decided?: 'overwrite' | 'skip';
  /** Per target folder: the names this copy has already put there, by key. */
  private readonly claimed = new Map<string, Map<string, string>>();
  private readonly sameWorld: boolean;

  constructor(private readonly request: CopyRequest) {
    const { source, sourceLoc, target, targetLoc } = request;
    this.sameWorld = source.kind === target.kind && sourceLoc.profile === targetLoc.profile;
  }

  async add(
    entry: Entry, sourceLoc: PaneLocation, targetLoc: PaneLocation,
    name: string, merging: boolean, many: boolean,
  ): Promise<void> {
    try {
      if (entry.dto.kind === 'dir') {
        await this.folder(entry, sourceLoc, targetLoc, name, many);
      } else {
        await this.file(entry, sourceLoc, targetLoc, name, merging, many);
      }
    } catch (err) {
      this.leaveOut(entry.dto.name, describeError(err).message);
    }
  }

  private async file(
    entry: Entry, sourceLoc: PaneLocation, targetLoc: PaneLocation,
    name: string, merging: boolean, many: boolean,
  ): Promise<void> {
    const { source, target, options } = this.request;
    if (this.sameWorld && sameLocation(sourceLoc, targetLoc)
      && this.key(targetLoc, source.describe(sourceLoc, entry).name) === this.key(targetLoc, name)) {
      // Not a question of overwriting: the source is read while the target is
      // written, and here they are the same file.
      this.leaveOut(entry.dto.name, 'it would be copied onto itself.');
      return;
    }
    if (source.describe(sourceLoc, entry).offline) {
      // One recall per file of a folder full of them is not something to
      // start on the way past; the user can ask for the ones they want.
      this.leaveOut(entry.dto.name, 'it is migrated — recall it first: Enter on it offers to.');
      return;
    }
    if (!this.claim(entry, targetLoc, name)) return;

    // Nothing needs asking about in a folder this copy has just made.
    if (merging && options.onConflict !== 'overwrite' && await target.exists(targetLoc, name)) {
      if (options.onConflict === 'skip') return;
      if (await this.decide(name, targetLoc, many) === 'skip') return;
    }
    this.plan.requests.push({
      source, sourceLoc, target, targetLoc, entry, name, options, move: this.request.move,
    });
  }

  private async folder(
    entry: Entry, sourceLoc: PaneLocation, targetLoc: PaneLocation, name: string, many: boolean,
  ): Promise<void> {
    const { source, target, signal } = this.request;
    if (this.request.move) {
      this.leaveOut(entry.dto.name, 'folders can be copied, but not moved yet.');
      return;
    }
    if (!target.folder) {
      this.leaveOut(entry.dto.name, `${target.label(targetLoc)} cannot hold folders.`);
      return;
    }
    const inside = source.enter(sourceLoc, entry);
    if (!inside) {
      this.leaveOut(entry.dto.name, 'it cannot be opened as a folder.');
      return;
    }
    if (this.sameWorld && this.within(targetLoc, inside)) {
      // It would find its own copy on the way down, and never finish.
      this.leaveOut(entry.dto.name, 'a folder cannot be copied into itself.');
      return;
    }
    if (!this.claim(entry, targetLoc, name)) return;

    // Listed before the target is made, so a new data set can be sized for
    // what is coming, and in full: a pane may stop at `mc.list.pageSize`, a
    // copy must not.
    const listing = await source.list(inside, signal, { all: true });
    const files = listing.entries.filter((e) => e.dto.kind !== 'dir');
    const made = await target.folder(targetLoc, name, {
      from: source.kind,
      dataset: source.describe(sourceLoc, entry).dataset,
      files: files.length,
      bytes: files.reduce((sum, e) => sum + (source.describe(inside, e).size ?? 0), 0),
    });
    if (this.sameWorld && sameLocation(made.location, inside)) {
      this.leaveOut(entry.dto.name, 'it would be copied onto itself.');
      return;
    }
    if (made.created && sameLocation(targetLoc, this.request.targetLoc)) this.plan.foldersMade += 1;

    for (const child of listing.entries) {
      const childName = source.describe(inside, child).name;
      await this.add(child, inside, made.location, childName, !made.created, many);
    }
  }

  /**
   * Reserves `name` in `targetLoc` for `entry`, or says why it cannot have it:
   * two members of a local folder, `a.jcl` and `a.txt`, are both member A in a
   * PDS, and the second must not quietly replace the first.
   */
  private claim(entry: Entry, targetLoc: PaneLocation, name: string): boolean {
    const key = this.key(targetLoc, name);
    const where = locationKey(targetLoc);
    const names = this.claimed.get(where) ?? new Map<string, string>();
    this.claimed.set(where, names);
    const first = names.get(key);
    if (first !== undefined) {
      this.leaveOut(entry.dto.name, `it would land on the same name as '${first}' in ${this.describeLocation(targetLoc)}.`);
      return false;
    }
    names.set(key, entry.dto.name);
    return true;
  }

  private key(loc: PaneLocation, name: string): string {
    return this.request.target.nameKey?.(loc, name) ?? name;
  }

  /** True when `loc` is `folder` or somewhere below it. */
  private within(loc: PaneLocation, folder: PaneLocation): boolean {
    for (let at: PaneLocation | undefined = loc; at; at = this.request.target.parent(at)) {
      if (sameLocation(at, folder)) return true;
    }
    return false;
  }

  private async decide(name: string, where: PaneLocation, many: boolean): Promise<'overwrite' | 'skip'> {
    if (this.decided) return this.decided;
    const reply = await this.request.ask(name, where, many);
    if (!reply) return 'skip';
    if (reply.all) this.decided = reply.answer;
    return reply.answer;
  }

  private describeLocation(loc: PaneLocation): string {
    return loc.path || this.request.target.label(loc);
  }

  private leaveOut(name: string, why: string): void {
    this.plan.problems.push(`${name}: ${why}`);
  }
}

function locationKey(loc: PaneLocation): string {
  return `${loc.kind}\u0000${loc.profile}\u0000${loc.path}`;
}
