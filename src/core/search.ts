import { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { PaneLocation, SearchHitDto, SearchQuery, TransferOptions } from '../shared/protocol';
import type { Entry, PaneProvider } from './provider';
import { describeError } from './errors';
import { isBinary } from './text';

export interface SearchRequest {
  provider: PaneProvider;
  root: PaneLocation;
  query: SearchQuery;
  /** How files are read for text: the codepage, as F3 and F5 read them. */
  options: TransferOptions;
  /** Names read as bytes, whose text is not text; they are left unread. */
  binaryExtensions: readonly string[];
  /** Listings and reads at once. Each is a z/OSMF request on the host. */
  concurrency: number;
  signal: AbortSignal;
  onHit(hit: SearchHitDto): void;
  /** How far it has got: folders listed, files looked at, and where it is. */
  onProgress(folders: number, files: number, current: string): void;
}

export interface SearchOutcome {
  stopped: boolean;
  /** What it could not look at, and why — for the user to read. */
  notes: string[];
}

/**
 * Alt+F7: walks down from `root` and reports every name that matches, or with
 * a text, every file of those names that contains it.
 *
 * Works through the providers the panes already use, so every world searches
 * the same way: a directory, a PDS and a job are all folders to walk, and
 * text is looked for in what F3 would show — converted from the codepage, so
 * a search for æøå finds æøå in a member.
 *
 * A file is read as a stream, and the read is stopped at the first line that
 * matches: finding the word on line 3 of a big member costs three lines. A
 * migrated data set is never read, since reading it starts a recall — and a
 * recall that asks for confirmation leaves z/OSMF's TSO address space waiting.
 */
export async function search(request: SearchRequest): Promise<SearchOutcome> {
  return new Search(request).run();
}

/**
 * `*` and `?` as usual; several patterns separated by `;`. A pattern with
 * neither matches anywhere in the name, as Total Commander does: `PAY` finds
 * PAYROLL and XPAY01 alike. Case never matters — MVS names have none.
 */
export function nameMatcher(patterns: string): (name: string) => boolean {
  const parts = patterns.split(';').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return () => true;
  const expressions = parts.map((part) => {
    const wild = /[*?]/.test(part);
    const body = part
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(wild ? `^${body}$` : body, 'i');
  });
  return (name) => expressions.some((expression) => expression.test(name));
}

class Search {
  private readonly matches: (name: string) => boolean;
  private readonly pool: Pool;
  private folders = 0;
  private files = 0;
  private offline = 0;
  private binary = 0;
  private readonly unlisted: string[] = [];
  private readonly unread: string[] = [];

  constructor(private readonly request: SearchRequest) {
    this.matches = nameMatcher(request.query.names);
    this.pool = new Pool(Math.max(1, request.concurrency));
  }

  async run(): Promise<SearchOutcome> {
    const { signal } = this.request;
    const stop = () => this.pool.clear();
    signal.addEventListener('abort', stop, { once: true });
    try {
      this.visit(this.request.root, '');
      await this.pool.idle();
    } finally {
      signal.removeEventListener('abort', stop);
    }
    return { stopped: signal.aborted, notes: this.notes() };
  }

  private visit(loc: PaneLocation, where: string): void {
    this.pool.add(async () => {
      const { provider, query, signal } = this.request;
      if (signal.aborted) return;
      this.folders += 1;
      this.progress(where);

      let entries: Entry[];
      try {
        // In full: a pane stops at mc.list.pageSize, a search must not.
        entries = (await provider.list(loc, signal, { all: true })).entries;
      } catch (err) {
        if (!signal.aborted) this.unlisted.push(`${where || this.rootName()}: ${describeError(err).message}`);
        return;
      }

      for (const entry of entries) {
        if (signal.aborted) return;
        const item = provider.describe(loc, entry);
        const named = this.matches(entry.dto.name) || this.matches(item.name);

        if (entry.dto.kind === 'dir') {
          if (named && !query.text) this.hit(loc, entry, item.name, where);
          if (query.subfolders) this.descend(loc, entry, item.name, where);
          continue;
        }
        if (!named) continue;
        if (!query.text) {
          this.files += 1;
          this.hit(loc, entry, item.name, where);
        } else if (item.offline) {
          this.offline += 1;
        } else if (this.request.options.mode !== 'text' && isBinary(item.name, this.request.binaryExtensions)) {
          this.binary += 1;
        } else {
          this.pool.add(() => this.look(loc, entry, item.name, where));
        }
      }
    });
  }

  private descend(loc: PaneLocation, entry: Entry, name: string, where: string): void {
    let inside: PaneLocation | undefined;
    try {
      inside = this.request.provider.enter(loc, entry);
    } catch (err) {
      // A migrated PDS says so on the way in, and is not recalled for this.
      if (this.request.provider.describe(loc, entry).offline) this.offline += 1;
      else this.unlisted.push(`${join(where, name)}: ${describeError(err).message}`);
      return;
    }
    if (inside) this.visit(inside, join(where, name));
  }

  /** Reads one file until the text turns up, or to the end. */
  private async look(loc: PaneLocation, entry: Entry, name: string, where: string): Promise<void> {
    const { provider, query, options, signal } = this.request;
    if (signal.aborted) return;
    this.files += 1;
    this.progress(join(where, name));

    const found = new AbortController();
    const finder = new TextFinder(query.text, query.caseSensitive, () => found.abort());
    try {
      await provider.readTo(loc, entry, options, finder, AbortSignal.any([signal, found.signal]));
    } catch (err) {
      // Stopping the read on a hit is how a hit ends it; only a read that
      // failed without finding anything is worth mentioning.
      if (!finder.found && !signal.aborted) this.unread.push(`${join(where, name)}: ${describeError(err).message}`);
    }
    if (finder.found && !signal.aborted) this.hit(loc, entry, name, where, finder.found);
  }

  private hit(
    loc: PaneLocation, entry: Entry, name: string, where: string,
    found?: { line: number; text: string },
  ): void {
    this.request.onHit({
      location: loc, entryId: entry.dto.id, name, kind: entry.dto.kind, where,
      ...(found ? { line: found.line, text: found.text } : {}),
    });
  }

  private progress(current: string): void {
    this.request.onProgress(this.folders, this.files, current || this.rootName());
  }

  private rootName(): string {
    const { provider, root } = this.request;
    return root.path || provider.label(root);
  }

  private notes(): string[] {
    const notes: string[] = [];
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    if (this.offline > 0) {
      notes.push(`${plural(this.offline, 'migrated data set was', 'migrated data sets were')} not searched: `
        + 'reading one starts a recall.');
    }
    if (this.binary > 0) {
      notes.push(`${plural(this.binary, 'binary file was', 'binary files were')} not searched for text `
        + '(mc.transfer.binaryExtensions).');
    }
    const some = (list: string[], what: string) => {
      if (list.length === 0) return;
      notes.push(`${plural(list.length, what, `${what}s`)} could not be searched:`);
      notes.push(...list.slice(0, 5).map((line) => `  ${line}`));
      if (list.length > 5) notes.push(`  … and ${list.length - 5} more`);
    };
    some(this.unlisted, 'folder');
    some(this.unread, 'file');
    return notes;
  }
}

function join(where: string, name: string): string {
  return where ? `${where}/${name}` : name;
}

/**
 * Takes a file's text as it streams past and notes the first line that holds
 * the needle, then asks to be stopped. Lines are split on any of CRLF, LF and
 * CR, across chunk boundaries — including a CRLF cut in two.
 */
class TextFinder extends Writable {
  found?: { line: number; text: string };
  private readonly decoder = new StringDecoder('utf8');
  private readonly needle: string;
  private carry = '';
  private lines = 0;

  constructor(needle: string, private readonly caseSensitive: boolean, private readonly onFound: () => void) {
    super();
    this.needle = caseSensitive ? needle : needle.toLowerCase();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.scan(this.decoder.write(chunk), false);
    done();
  }

  override _final(done: (error?: Error | null) => void): void {
    this.scan(this.decoder.end(), true);
    done();
  }

  private scan(text: string, final: boolean): void {
    if (this.found) return;
    let body = this.carry + text;
    let held = '';
    // A CR at the very end may be the first half of a CRLF.
    if (!final && body.endsWith('\r')) {
      body = body.slice(0, -1);
      held = '\r';
    }
    const lines = body.split(/\r\n|\r|\n/);
    const last = lines.pop() ?? '';
    for (const line of lines) {
      this.lines += 1;
      if (this.check(line, this.lines)) return;
    }
    if (final) {
      this.carry = '';
      if (last) {
        this.lines += 1;
        this.check(last, this.lines);
      }
      return;
    }
    this.carry = last + held;
    // A line with no end in sight — a file that is not really text — is
    // checked as far as it has come, and then kept only as far back as a
    // match could still start.
    if (this.carry.length > 65536) {
      if (this.check(this.carry, this.lines + 1)) return;
      this.carry = this.carry.slice(-this.needle.length);
    }
  }

  private check(line: string, number: number): boolean {
    if (!this.contains(line)) return false;
    const text = line.trim();
    this.found = { line: number, text: text.length > 200 ? `${text.slice(0, 200)}…` : text };
    this.onFound();
    return true;
  }

  private contains(line: string): boolean {
    return (this.caseSensitive ? line : line.toLowerCase()).includes(this.needle);
  }
}

/** Runs at most `size` tasks at once; `idle` waits for all of them. */
class Pool {
  private running = 0;
  private readonly queue: (() => Promise<void>)[] = [];
  private waiters: (() => void)[] = [];

  constructor(private readonly size: number) {}

  add(task: () => Promise<void>): void {
    this.queue.push(task);
    this.next();
  }

  /** Drops what has not started; what has is stopped by the signal it was given. */
  clear(): void {
    this.queue.length = 0;
    this.next();
  }

  idle(): Promise<void> {
    if (this.running === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private next(): void {
    while (this.running < this.size && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.running += 1;
      void task().catch(() => undefined).finally(() => {
        this.running -= 1;
        this.next();
      });
    }
    if (this.running === 0 && this.queue.length === 0) {
      const waiters = this.waiters;
      this.waiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}
