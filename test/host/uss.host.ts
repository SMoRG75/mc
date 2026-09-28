import { after, before, test as always } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { ebcdicToText } from '../../src/core/ebcdic';
import { UserFacingError } from '../../src/core/errors';
import type { Entry, PaneProvider } from '../../src/core/provider';
import { search } from '../../src/core/search';
import { TransferQueue, type TransferRequest } from '../../src/core/transferQueue';
import { planCopy } from '../../src/core/treeCopy';
import { LocalProvider } from '../../src/providers/localProvider';
import { UssProvider } from '../../src/providers/ussProvider';
import type { PaneLocation, SearchHitDto } from '../../src/shared/protocol';
import { collector, options, PROFILE, records, sessions, signal, USS_DIR, USS_PREFIX } from './host';

/*
 * The USS provider against a real z/OSMF, writing into MC_HOST_USS_DIR. Every
 * file and directory made here is named mct…, and removed again at the end.
 */

// Skipped, all of it, without a directory to write into.
const test = USS_DIR ? always : always.skip;

const settings = { pageSize: () => 1000, binaryExtensions: () => ['.bin'] };
const uss: PaneProvider = new UssProvider(sessions, settings);
const local: PaneProvider = new LocalProvider(() => 1000);
const here: PaneLocation = { kind: 'uss', profile: PROFILE, path: USS_DIR };
const at = (dir: string): PaneLocation => ({ ...here, path: dir });
const localAt = (dir: string): PaneLocation => ({ kind: 'local', profile: '', path: dir });

async function entries(loc: PaneLocation = here): Promise<Map<string, Entry>> {
  const listing = await uss.list(loc, signal(), { all: true });
  return new Map(listing.entries.map((entry) => [entry.dto.name, entry]));
}

async function entry(name: string, loc: PaneLocation = here): Promise<Entry> {
  const found = (await entries(loc)).get(name);
  assert.ok(found, `${name} is in ${loc.path}`);
  return found;
}

async function removeOurs(): Promise<void> {
  const ours = [...(await entries()).values()].filter((e) => e.dto.name.startsWith(USS_PREFIX));
  if (ours.length > 0) await uss.remove(here, ours);
}

async function readText(name: string, loc: PaneLocation = here): Promise<string[]> {
  return records((await uss.read(loc, await entry(name, loc), options(), signal())).toString('utf8'));
}

/** Runs planned transfers to the end, returning the errors of any that failed. */
function runAll(requests: TransferRequest[]): Promise<string[]> {
  if (requests.length === 0) return Promise.resolve([]);
  return new Promise((resolve) => {
    let finished = 0;
    let errors: string[] = [];
    const queue = new TransferQueue(
      () => 3,
      (jobs) => { errors = jobs.filter((j) => j.state === 'failed').map((j) => `${j.label}: ${j.error}`); },
      () => { if (++finished === requests.length) setImmediate(() => resolve(errors)); },
    );
    queue.enqueue(requests);
  });
}

before(async () => {
  if (!USS_DIR) return;
  await uss.list(here, signal());
  // Left over from a run that was stopped halfway.
  await removeOurs();
});

after(async () => {
  if (USS_DIR) await removeOurs();
});

test('a file written as text reads back as written, and is EBCDIC on the host', async () => {
  const text = 'æøå ÆØÅ #@$ Blåbærgrød\nsecond line\n';
  await uss.write(here, 'mct-text.txt', Buffer.from(text), options(), signal());
  // Read through the file's own tag, which the write set to IBM-277.
  assert.deepEqual(await readText('mct-text.txt'), records(text));

  const raw = await uss.read(here, await entry('mct-text.txt'), options({ mode: 'binary' }), signal());
  assert.deepEqual(records(ebcdicToText(raw, 'IBM-277', 80)), records(text));
});

test('binary goes in and comes out byte for byte', async () => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  await uss.write(here, 'mct-all.bin', bytes, options({ mode: 'binary' }), signal());
  const back = await uss.read(here, await entry('mct-all.bin'), options({ mode: 'binary' }), signal());
  assert.deepEqual(back, bytes);
});

test('streamed in and out, a bigger file is the same at both ends', async () => {
  // Several of the SDK's chunks each way, and binary so every byte counts.
  const bytes = Buffer.alloc(512 * 1024);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + (i >> 9)) & 0xff;
  await uss.writeFrom(here, 'mct-big.bin', Readable.from([bytes]), options({ mode: 'binary' }), signal());
  const sink = collector();
  await uss.readTo(here, await entry('mct-big.bin'), options({ mode: 'binary' }), sink, signal());
  assert.equal(sink.bytes().length, bytes.length);
  assert.ok(sink.bytes().equals(bytes), 'the same bytes');
});

test('a folder is made once, reused after that, and a file in the way is said to be one', async () => {
  const first = await uss.folder!(here, 'mct-dir', { from: 'local', files: 0, bytes: 0 });
  assert.deepEqual(first, { location: at(`${USS_DIR}/mct-dir`), created: true });
  const again = await uss.folder!(here, 'mct-dir', { from: 'local', files: 0, bytes: 0 });
  assert.equal(again.created, false);

  await uss.write(here, 'mct-file', Buffer.from('x\n'), options(), signal());
  await assert.rejects(
    uss.folder!(here, 'mct-file', { from: 'local', files: 0, bytes: 0 }),
    (err: unknown) => err instanceof UserFacingError && /is a file, not a directory/.test(err.message),
  );
});

test('exists, rename and delete do what they say, a folder with what is in it', async () => {
  await uss.write(here, 'mct-old.txt', Buffer.from('x\n'), options(), signal());
  assert.equal(await uss.exists(here, 'mct-old.txt'), true);
  await uss.rename(here, await entry('mct-old.txt'), 'mct-new.txt');
  assert.equal(await uss.exists(here, 'mct-old.txt'), false);
  assert.equal(await uss.exists(here, 'mct-new.txt'), true);

  const { location } = await uss.folder!(here, 'mct-full', { from: 'local', files: 1, bytes: 2 });
  await uss.write(location, 'inside.txt', Buffer.from('y\n'), options(), signal());
  await uss.remove(here, [await entry('mct-new.txt'), await entry('mct-full')]);
  assert.equal(await uss.exists(here, 'mct-new.txt'), false);
  assert.equal(await uss.exists(here, 'mct-full'), false);
});

test('a pane gets no more than a page, and knows there was more', async () => {
  const { location } = await uss.folder!(here, 'mct-page', { from: 'local', files: 5, bytes: 0 });
  for (let i = 1; i <= 5; i += 1) {
    await uss.write(location, `f${i}.txt`, Buffer.from(`${i}\n`), options(), signal());
  }
  const small = new UssProvider(sessions, { ...settings, pageSize: () => 3 });
  const page = await small.list(location, signal());
  assert.equal(page.entries.length, 3);
  assert.equal(page.truncated, true);
  const everything = await small.list(location, signal(), { all: true });
  assert.equal(everything.entries.length, 5, "'.' and '..' are not among them");
  assert.equal(everything.truncated, false);
});

test('a local tree copies to USS and back unchanged, folders and all', async () => {
  const from = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-host-'));
  await fs.mkdir(path.join(from, 'mct-tree', 'deep', 'deeper'), { recursive: true });
  await fs.mkdir(path.join(from, 'mct-tree', 'empty'));
  await fs.writeFile(path.join(from, 'mct-tree', 'a.txt'), 'æøå\n');
  await fs.writeFile(path.join(from, 'mct-tree', 'deep', 'b.txt'), 'b\n');
  await fs.writeFile(path.join(from, 'mct-tree', 'deep', 'deeper', 'c.bin'), Buffer.from([0, 1, 2, 255]));

  const source = (await local.list(localAt(from), signal(), { all: true })).entries;
  const up = await planCopy({
    source: local, sourceLoc: localAt(from), target: uss, targetLoc: here, entries: source,
    options: options({ mode: 'auto' }), move: false, ask: async () => undefined, signal: signal(),
  });
  assert.deepEqual(up.problems, []);
  assert.deepEqual(await runAll(up.requests), []);

  const back = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-host-'));
  const down = await planCopy({
    source: uss, sourceLoc: here, target: local, targetLoc: localAt(back),
    entries: [await entry('mct-tree')], options: options({ mode: 'auto' }), move: false,
    ask: async () => undefined, signal: signal(),
  });
  assert.deepEqual(down.problems, []);
  assert.deepEqual(await runAll(down.requests), []);

  const tree = path.join(back, 'mct-tree');
  assert.deepEqual(records(await fs.readFile(path.join(tree, 'a.txt'), 'utf8')), ['æøå']);
  assert.deepEqual(records(await fs.readFile(path.join(tree, 'deep', 'b.txt'), 'utf8')), ['b']);
  assert.deepEqual(await fs.readFile(path.join(tree, 'deep', 'deeper', 'c.bin')), Buffer.from([0, 1, 2, 255]));
  assert.deepEqual(await fs.readdir(path.join(tree, 'empty')), [], 'the empty folder came along');
});

test('Alt+F7 finds names and text below a USS directory', async () => {
  const { location } = await uss.folder!(here, 'mct-find', { from: 'local', files: 0, bytes: 0 });
  const { location: deep } = await uss.folder!(location, 'deep', { from: 'local', files: 0, bytes: 0 });
  await uss.write(deep, 'hit.txt', Buffer.from('hay\nthe NEEDLE is here\n'), options(), signal());
  await uss.write(location, 'miss.txt', Buffer.from('only hay\n'), options(), signal());

  const hits: SearchHitDto[] = [];
  await search({
    provider: uss, root: location, options: options({ mode: 'auto' }), binaryExtensions: ['.bin'],
    concurrency: 3, signal: signal(),
    query: { names: '*.txt', text: 'needle', caseSensitive: false, subfolders: true },
    onHit: (hit) => hits.push(hit), onProgress: () => undefined,
  });
  assert.deepEqual(hits.map((h) => `${h.where}/${h.name}:${h.line}`), ['deep/hit.txt:2']);
});
