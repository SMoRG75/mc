import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Writable } from 'node:stream';
import { TransferQueue, type TransferRequest } from '../src/core/transferQueue';
import type { Entry, PaneProvider } from '../src/core/provider';
import { LocalProvider } from '../src/providers/localProvider';
import type { PaneLocation, TransferJobDto, TransferOptions } from '../src/shared/protocol';

const options: TransferOptions = {
  mode: 'binary', codepage: 'IBM-037', longLines: 'abort', onConflict: 'overwrite', destination: '*',
};

const local = new LocalProvider(() => 1000);

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mc-test-'));
}

function at(dir: string): PaneLocation {
  return { kind: 'local', profile: '', path: dir };
}

async function entryFor(dir: string, file: string): Promise<Entry> {
  const listing = await local.list(at(dir), new AbortController().signal);
  const entry = listing.entries.find((e) => e.dto.id === path.join(dir, file));
  assert.ok(entry, `${file} is listed`);
  return entry;
}

/** Runs one transfer to the end and returns what the queue last said about it. */
function run(request: Omit<TransferRequest, 'options' | 'move'>, onStart?: (queue: TransferQueue, id: string) => void): Promise<TransferJobDto> {
  return new Promise((resolve) => {
    let last: TransferJobDto | undefined;
    let started = false;
    const queue = new TransferQueue(
      () => 1,
      (jobs) => {
        last = jobs[0] ?? last;
        if (!started && last?.state === 'running') {
          started = true;
          onStart?.(queue, last.id);
        }
      },
      () => setImmediate(() => resolve(last!)),
    );
    queue.enqueue([{ ...request, options, move: false }]);
  });
}

/**
 * A source that sends `before` bytes and then either fails or waits to be
 * stopped — the half of a copy that the other half must not be left behind by.
 */
function brokenSource(before: number, then: 'fail' | 'hang'): PaneProvider & { stopped: boolean } {
  const source = {
    kind: 'uss',
    stopped: false,
    describe: () => ({ name: 'broken.bin', size: before * 2, text: false }),
    readTo: async (_loc: PaneLocation, _entry: Entry, _options: TransferOptions, sink: Writable, signal: AbortSignal) => {
      sink.write(Buffer.alloc(before, 0x43));
      if (then === 'fail') throw new Error('the host went away');
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      source.stopped = true;
      throw signal.reason;
    },
  };
  return source as unknown as PaneProvider & { stopped: boolean };
}

const someEntry = { dto: { id: 'x', name: 'x', kind: 'file', cells: {} }, ref: undefined } as Entry;

test('a copy streams the file across and reports the bytes', async () => {
  const from = await tempDir();
  const to = await tempDir();
  const content = Buffer.alloc(3 * 1024 * 1024, 0x44);
  await fs.writeFile(path.join(from, 'big.bin'), content);

  const job = await run({
    source: local, sourceLoc: at(from), target: local, targetLoc: at(to),
    entry: await entryFor(from, 'big.bin'), name: 'big.bin',
  });

  assert.equal(job.state, 'done', `the copy failed: ${job.error}`);
  assert.equal(job.progress, 1);
  assert.equal(job.bytes, content.length);
  assert.deepEqual(await fs.readFile(path.join(to, 'big.bin')), content);
  assert.deepEqual(await fs.readdir(to), ['big.bin'], 'nothing is left over beside it');
});

test('a source that fails halfway leaves the existing target as it was', async () => {
  const to = await tempDir();
  await fs.writeFile(path.join(to, 'keep.bin'), 'the old version');

  const job = await run({
    source: brokenSource(256 * 1024, 'fail'), sourceLoc: at(to), target: local, targetLoc: at(to),
    entry: someEntry, name: 'keep.bin',
  });

  assert.equal(job.state, 'failed');
  assert.equal(job.error, 'the host went away', 'the cause is reported, not what it did to the target');
  assert.equal(await fs.readFile(path.join(to, 'keep.bin'), 'utf8'), 'the old version');
  assert.deepEqual(await fs.readdir(to), ['keep.bin'], 'the partial file is cleaned up');
});

test('a target that fails stops the source instead of leaving it running', async () => {
  const source = brokenSource(1024, 'hang');
  const target = {
    kind: 'ds',
    writeFrom: async () => { throw new Error('the dataset is in use'); },
  } as unknown as PaneProvider;

  const job = await run({
    source, sourceLoc: at('/'), target, targetLoc: at('/'), entry: someEntry, name: 'x',
  });

  assert.equal(job.state, 'failed');
  assert.equal(job.error, 'the dataset is in use');
  assert.ok(source.stopped, 'the source was told to stop');
});

test('cancelling a running copy stops both sides and leaves no partial file', async () => {
  const to = await tempDir();
  const source = brokenSource(128 * 1024, 'hang');

  const job = await run({
    source, sourceLoc: at(to), target: local, targetLoc: at(to), entry: someEntry, name: 'never.bin',
  }, (queue, id) => setTimeout(() => queue.cancel(id), 50));

  assert.equal(job.state, 'cancelled');
  assert.ok(source.stopped);
  assert.deepEqual(await fs.readdir(to), []);
});
