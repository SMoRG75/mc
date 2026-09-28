import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Writable } from 'node:stream';
import type { Entry, PaneProvider } from '../src/core/provider';
import { nameMatcher, search, type SearchOutcome, type SearchRequest } from '../src/core/search';
import { LocalProvider } from '../src/providers/localProvider';
import type { PaneLocation, SearchHitDto, SearchQuery, TransferOptions } from '../src/shared/protocol';

// A page of two, so every folder here is more than a pane shows.
const local = new LocalProvider(() => 2);
const options: TransferOptions = {
  mode: 'auto', codepage: 'IBM-037', longLines: 'abort', onConflict: 'ask', destination: '*',
};

async function tree(files: Record<string, string | Buffer>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-search-'));
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  return root;
}

function at(dir: string): PaneLocation {
  return { kind: 'local', profile: '', path: dir };
}

async function find(
  root: PaneLocation, query: Partial<SearchQuery>, over: Partial<SearchRequest> = {},
): Promise<{ hits: SearchHitDto[]; outcome: SearchOutcome }> {
  const hits: SearchHitDto[] = [];
  const outcome = await search({
    provider: local, root, options, binaryExtensions: ['.zip'], concurrency: 3,
    signal: new AbortController().signal,
    query: { names: '', text: '', caseSensitive: false, subfolders: true, ...query },
    onHit: (hit) => hits.push(hit),
    onProgress: () => undefined,
    ...over,
  });
  hits.sort((a, b) => `${a.where}/${a.name}`.localeCompare(`${b.where}/${b.name}`));
  return { hits, outcome };
}

const where = (hits: SearchHitDto[]) => hits.map((h) => (h.where ? `${h.where}/${h.name}` : h.name));

test('names are matched with * and ?, several at once, and without regard to case', () => {
  const matches = nameMatcher('*.jcl; PAY??.cbl');
  assert.ok(matches('BUILD.JCL'));
  assert.ok(matches('pay01.CBL'));
  assert.ok(!matches('PAY001.cbl'), '? is one character');
  assert.ok(!matches('build.jclx'), 'a pattern with * is the whole name');
  // Total Commander's rule: no wildcard, found anywhere in the name.
  assert.ok(nameMatcher('PAY')('XPAYROLL'));
  assert.ok(nameMatcher('')('anything'), 'no pattern is every name');
});

test('a search by name walks every folder, and finds folders too', async () => {
  const root = await tree({
    'a.jcl': '', 'b.txt': '', 'src/c.jcl': '', 'src/deep/d.JCL': '', 'jcl/readme': '',
  });
  const { hits, outcome } = await find(at(root), { names: '*.jcl;jcl' });
  assert.deepEqual(where(hits), ['a.jcl', 'jcl', 'src/c.jcl', 'src/deep/d.JCL']);
  assert.deepEqual(outcome, { stopped: false, notes: [] });
  const folder = hits.find((h) => h.name === 'jcl')!;
  assert.equal(folder.kind, 'dir');
  assert.deepEqual(folder.location, at(root), 'a hit points at the folder it is in');
});

test('without subfolders only the folder itself is searched', async () => {
  const root = await tree({ 'a.jcl': '', 'src/b.jcl': '' });
  const { hits } = await find(at(root), { names: '*.jcl', subfolders: false });
  assert.deepEqual(where(hits), ['a.jcl']);
});

test('text is found with the line it is on, once per file', async () => {
  const root = await tree({
    'one.jcl': '//JOB1 JOB\r\n//STEP1 EXEC PGM=IEFBR14\r\n//STEP2 EXEC PGM=IEFBR14\r\n',
    'two.jcl': '//JOB2 JOB\n//STEP1 EXEC PGM=SORT\n',
    'src/three.jcl': 'nothing here',
  });
  const { hits } = await find(at(root), { names: '*.jcl', text: 'iefbr14' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.name, 'one.jcl');
  assert.equal(hits[0]!.line, 2, 'the first line it is on, counted across CRLF');
  assert.equal(hits[0]!.text, '//STEP1 EXEC PGM=IEFBR14');
});

test('match case is honoured for the text, and only for the text', async () => {
  const root = await tree({ 'A.JCL': 'PGM=IEFBR14', 'b.jcl': 'pgm=iefbr14' });
  const { hits } = await find(at(root), { names: '*.JCL', text: 'IEFBR14', caseSensitive: true });
  assert.deepEqual(where(hits), ['A.JCL']);
});

test('text is found however the file is cut into chunks, far past the first one', async () => {
  // Local reads come in 64 KB; the match is 3 MB in, on a line split by the
  // chunk boundary, after a CRLF that is split too.
  const filler = 'x'.repeat(99) + '\r\n';
  const lines = Math.floor(3 * 1024 * 1024 / filler.length);
  const root = await tree({ 'big.txt': `${filler.repeat(lines)}the needle is here\r\ntail\r\n` });
  const { hits } = await find(at(root), { text: 'NEEDLE' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.line, lines + 1);
});

test('a binary file is not searched for text, and the user is told', async () => {
  const root = await tree({ 'a.zip': 'needle', 'b.txt': 'needle' });
  const { hits, outcome } = await find(at(root), { text: 'needle' });
  assert.deepEqual(where(hits), ['b.txt']);
  assert.match(outcome.notes.join('\n'), /1 binary file was not searched/);
});

/** A provider over one folder of fake entries, reading `content` for each. */
function fakeProvider(entries: { name: string; offline?: boolean }[], readTo: PaneProvider['readTo']): PaneProvider {
  const entry = (name: string): Entry => ({ dto: { id: name, name, kind: 'file', cells: {} }, ref: name });
  return {
    kind: 'ds',
    label: () => 'LPAR1',
    list: async () => ({ title: '', columns: [], entries: entries.map((e) => entry(e.name)), status: '', truncated: false }),
    describe: (_loc: PaneLocation, e: Entry) => ({
      name: e.dto.name, text: true,
      offline: entries.find((f) => f.name === e.dto.name)?.offline ? 'migrated' : undefined,
    }),
    enter: () => undefined,
    readTo,
  } as unknown as PaneProvider;
}

const ds = { kind: 'ds' as const, profile: 'LPAR1', path: 'USER.*' };

test('a migrated data set is never read: reading it would start a recall', async () => {
  const read: string[] = [];
  const provider = fakeProvider([{ name: 'USER.OLD', offline: true }, { name: 'USER.NEW' }],
    async (_loc, entry, _options, sink: Writable) => {
      read.push(entry.dto.name);
      sink.end('text');
    });
  const { outcome } = await find(ds, { text: 'text' }, { provider });
  assert.deepEqual(read, ['USER.NEW']);
  assert.match(outcome.notes.join('\n'), /1 migrated data set was not searched/);
});

test('a read stops at the first hit instead of reading on to the end', async () => {
  let written = 0;
  const provider = fakeProvider([{ name: 'USER.BIG' }], async (_loc, _entry, _options, sink: Writable, signal) => {
    // A big data set arriving a line at a time, the hit near the top.
    for (let line = 1; line <= 100_000; line += 1) {
      if (signal.aborted) throw signal.reason;
      sink.write(line === 3 ? 'the needle\n' : 'hay\n');
      written += 1;
      if (line % 100 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    sink.end();
  });
  const { hits } = await find(ds, { text: 'needle' }, { provider });
  assert.equal(hits[0]?.line, 3);
  assert.ok(written < 1000, `read ${written} lines of 100,000`);
});

test('stopping ends the search and says so', async () => {
  const stop = new AbortController();
  const provider = fakeProvider([{ name: 'A' }, { name: 'B' }, { name: 'C' }], async (_loc, _entry, _options, sink, signal) => {
    stop.abort();
    if (signal.aborted) throw signal.reason;
    sink.end('x');
  });
  const { outcome } = await find(ds, { text: 'x' }, { provider, signal: stop.signal, concurrency: 1 });
  assert.equal(outcome.stopped, true);
});

test('a folder that cannot be listed is noted, and the rest is still searched', async () => {
  const root = await tree({ 'a.jcl': '' });
  const broken = {
    ...local,
    kind: 'local',
    label: () => 'This PC',
    describe: local.describe.bind(local),
    enter: local.enter.bind(local),
    list: async (loc: PaneLocation, signal: AbortSignal, o?: { all?: boolean }) => {
      if (loc.path.endsWith('gone')) throw new Error('permission denied');
      return local.list(loc, signal, o);
    },
  } as unknown as PaneProvider;
  await fs.mkdir(path.join(root, 'gone'));
  const { hits, outcome } = await find(at(root), { names: '*.jcl' }, { provider: broken });
  assert.deepEqual(where(hits), ['a.jcl']);
  assert.match(outcome.notes.join('\n'), /1 folder could not be searched:\n {2}gone: permission denied/);
});
