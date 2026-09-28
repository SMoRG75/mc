import { after, before, test as always } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { decodeEbcdic } from '../../src/core/ebcdic';
import { UserFacingError } from '../../src/core/errors';
import type { Entry, PaneProvider } from '../../src/core/provider';
import { search } from '../../src/core/search';
import { TransferQueue, type TransferRequest } from '../../src/core/transferQueue';
import { planCopy } from '../../src/core/treeCopy';
import { DsProvider } from '../../src/providers/dsProvider';
import { LocalProvider } from '../../src/providers/localProvider';
import type { PaneLocation, SearchHitDto } from '../../src/shared/protocol';
import { collector, options, PDS, PREFIX, PROFILE, records, sessions, signal, streamOf } from './host';

/*
 * The data set provider against a real z/OSMF, writing members into MC_HOST_PDS.
 * Every member made here is named MCT…, and removed again at the end.
 */

// Through the interface, as the panes use it.
// Skipped, all of it, without a PDS to write into.
const test = PDS ? always : always.skip;

const ds: PaneProvider = new DsProvider(sessions, {
  pageSize: () => 1000, binaryExtensions: () => ['.bin'], defaultFilter: () => '',
});
const local: PaneProvider = new LocalProvider(() => 1000);
const inside: PaneLocation = { kind: 'ds', profile: PROFILE, path: PDS };

async function members(): Promise<Map<string, Entry>> {
  const listing = await ds.list(inside, signal(), { all: true });
  return new Map(listing.entries.map((entry) => [entry.dto.name, entry]));
}

async function member(name: string): Promise<Entry> {
  const entry = (await members()).get(name);
  assert.ok(entry, `${name} is in ${PDS}`);
  return entry;
}

async function removeOurs(): Promise<void> {
  const ours = [...(await members()).values()].filter((e) => e.dto.name.startsWith(PREFIX));
  if (ours.length > 0) await ds.remove(inside, ours);
}

async function readText(name: string): Promise<string[]> {
  return records((await ds.read(inside, await member(name), options(), signal())).toString('utf8'));
}

before(async () => {
  if (!PDS) return;
  const listing = await ds.list(inside, signal(), { all: true });
  assert.ok(listing.title.startsWith(PDS), `${PDS} lists as a PDS`);
  // Left over from a run that was stopped halfway.
  await removeOurs();
});

after(async () => {
  if (PDS) await removeOurs();
});

test('a member written as text reads back as written', async () => {
  const text = '//MCTJOB  JOB (ACCT),CLASS=A\n//STEP1    EXEC PGM=IEFBR14\n';
  await ds.write(inside, 'MCTTEXT', Buffer.from(text), options(), signal());
  assert.deepEqual(await readText('MCTTEXT'), records(text));
});

test('national characters survive the codepage, both ways, and are EBCDIC on the host', async () => {
  // IBM-277 is Danish/Norwegian: æøå are where US EBCDIC has other letters,
  // so a wrong or missing conversion shows up here and nowhere in ASCII.
  const text = 'æøå ÆØÅ #@$ Blåbærgrød\n';
  await ds.write(inside, 'MCTDK', Buffer.from(text), options(), signal());
  assert.deepEqual(await readText('MCTDK'), records(text));

  const raw = await ds.read(inside, await member('MCTDK'), options({ mode: 'binary' }), signal());
  assert.equal(raw.length % 80, 0, 'FB 80 comes back in whole records');
  assert.equal(decodeEbcdic(raw.subarray(0, 80), 'IBM-277').trimEnd(), text.trimEnd());
});

test('streamed in and out, a member of many records is the same at both ends', async () => {
  const lines = Array.from({ length: 100 }, (_, i) => `LINE ${String(i + 1).padStart(4, '0')} ${'X'.repeat(60)}`);
  await ds.writeFrom(inside, 'MCTSTRM', streamOf(`${lines.join('\n')}\n`), options(), signal());
  const sink = collector();
  await ds.readTo(inside, await member('MCTSTRM'), options(), sink, signal());
  assert.deepEqual(records(sink.bytes().toString('utf8')), lines);
});

test('a line too long for LRECL: abort leaves the member as it was, wrap and truncate fit it', async () => {
  await ds.write(inside, 'MCTLONG', Buffer.from('the old version\n'), options(), signal());
  const long = `${'A'.repeat(80)}${'B'.repeat(20)}\n`;

  // Streamed: the abort check is spooled first, so nothing reaches the host.
  await assert.rejects(
    ds.writeFrom(inside, 'MCTLONG', streamOf(long), options({ longLines: 'abort' }), signal()),
    (err: unknown) => err instanceof UserFacingError && /Line 1 is 100 characters/.test(err.message),
  );
  assert.deepEqual(await readText('MCTLONG'), ['the old version']);

  await ds.writeFrom(inside, 'MCTLONG', streamOf(long), options({ longLines: 'wrap' }), signal());
  assert.deepEqual(await readText('MCTLONG'), ['A'.repeat(80), 'B'.repeat(20)]);

  await ds.writeFrom(inside, 'MCTLONG', streamOf(long), options({ longLines: 'truncate' }), signal());
  assert.deepEqual(await readText('MCTLONG'), ['A'.repeat(80)]);
});

test('binary goes in and comes out byte for byte', async () => {
  // Two whole records, so there is no padding to argue about.
  const bytes = Buffer.from(Array.from({ length: 160 }, (_, i) => i));
  await ds.write(inside, 'MCTBIN', bytes, options({ mode: 'binary' }), signal());
  const back = await ds.read(inside, await member('MCTBIN'), options({ mode: 'binary' }), signal());
  assert.deepEqual(back, bytes);
});

test('exists, rename and delete do what they say', async () => {
  await ds.write(inside, 'MCTOLD', Buffer.from('x\n'), options(), signal());
  assert.equal(await ds.exists(inside, 'MCTOLD'), true);
  assert.equal(await ds.exists(inside, 'MCTNEW'), false);

  await ds.rename(inside, await member('MCTOLD'), 'MCTNEW');
  assert.equal(await ds.exists(inside, 'MCTOLD'), false);
  assert.equal(await ds.exists(inside, 'MCTNEW'), true);

  await ds.remove(inside, [await member('MCTNEW')]);
  assert.equal(await ds.exists(inside, 'MCTNEW'), false);
});

test('listings at once no longer collide over the ISPF profile', async () => {
  // Before the per-user queue, four at once failed about one time in four on
  // Z Xplore with ISPT036. Through the provider they now take turns.
  const filter: PaneLocation = { ...inside, path: `${PDS}*` };
  const results = await Promise.allSettled([
    ds.list(inside, signal()), ds.list(filter, signal()),
    ds.list(inside, signal()), ds.list(filter, signal()),
  ]);
  const failures = results.filter((r) => r.status === 'rejected');
  assert.deepEqual(failures, []);
});

// Also the only test that catches the read being stopped after its response
// has ended: z/OSMF answers gzipped and the SDK inflates on the thread pool, so
// the hit arrives late, and stopping then destroyed a pooled TLS socket with no
// listener — an uncaught error. It would not reproduce without the real client
// and host, which is why this lives here and not in test/flow.test.ts.
test('Alt+F7 finds text in a member, with the line it is on', async () => {
  await ds.write(inside, 'MCTFIND', Buffer.from('hay\nthe NEEDLE is here\nhay\n'), options(), signal());
  const hits: SearchHitDto[] = [];
  await search({
    provider: ds, root: inside, options: options({ mode: 'auto' }), binaryExtensions: [],
    concurrency: 3, signal: signal(),
    query: { names: `${PREFIX}*`, text: 'needle', caseSensitive: false, subfolders: false },
    onHit: (hit) => hits.push(hit), onProgress: () => undefined,
  });
  const hit = hits.find((h) => h.name === 'MCTFIND');
  assert.ok(hit, 'found');
  assert.equal(hit.line, 2);
});

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

test('F5 of local files into the PDS catches two that would be one member, and copies the rest', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-host-'));
  await fs.writeFile(path.join(dir, 'mcta.jcl'), '//A JOB\n');
  await fs.writeFile(path.join(dir, 'mcta.txt'), 'would land on MCTA as well\n');
  await fs.writeFile(path.join(dir, 'mctb.jcl'), '//B JOB\n');
  const listing = await local.list({ kind: 'local', profile: '', path: dir }, signal(), { all: true });

  const plan = await planCopy({
    source: local, sourceLoc: { kind: 'local', profile: '', path: dir },
    target: ds, targetLoc: inside, entries: listing.entries,
    options: options({ mode: 'auto' }), move: false,
    ask: async () => ({ answer: 'overwrite', all: true }), signal: signal(),
  });
  assert.equal(plan.problems.length, 1, plan.problems.join('\n'));
  assert.deepEqual(await runAll(plan.requests), []);
  assert.deepEqual(await readText('MCTA'), ['//A JOB']);
  assert.deepEqual(await readText('MCTB'), ['//B JOB']);
});

test('F5 of the PDS to local disk makes a folder with a file per member', async () => {
  await ds.write(inside, 'MCTDIR1', Buffer.from('one\n'), options(), signal());
  await ds.write(inside, 'MCTDIR2', Buffer.from('two\n'), options(), signal());
  const filter: PaneLocation = { ...inside, path: `${PDS}*` };
  const entry = (await ds.list(filter, signal(), { all: true })).entries.find((e) => e.dto.name === PDS);
  assert.ok(entry, `${PDS} is in its own filter`);

  const to = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-host-'));
  const plan = await planCopy({
    source: ds, sourceLoc: filter, target: local, targetLoc: { kind: 'local', profile: '', path: to },
    entries: [entry], options: options({ mode: 'auto' }), move: false,
    ask: async () => undefined, signal: signal(),
  });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(await runAll(plan.requests), []);
  const folder = path.join(to, PDS);
  assert.deepEqual(records(await fs.readFile(path.join(folder, 'MCTDIR1'), 'utf8')), ['one']);
  assert.deepEqual(records(await fs.readFile(path.join(folder, 'MCTDIR2'), 'utf8')), ['two']);
});
