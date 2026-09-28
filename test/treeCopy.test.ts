import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Entry, PaneProvider } from '../src/core/provider';
import { TransferQueue, type TransferRequest } from '../src/core/transferQueue';
import { planCopy, type ConflictAnswer, type CopyRequest } from '../src/core/treeCopy';
import { LocalProvider } from '../src/providers/localProvider';
import type { PaneLocation, TransferOptions } from '../src/shared/protocol';

const options = (over: Partial<TransferOptions> = {}): TransferOptions => ({
  mode: 'binary', codepage: 'IBM-037', longLines: 'abort', onConflict: 'ask', destination: '*',
  ...over,
});

// A page size of 2, so every folder below is bigger than one pane-full: a copy
// has to see past what the pane would show.
const local = new LocalProvider(() => 2);

function at(dir: string): PaneLocation {
  return { kind: 'local', profile: '', path: dir };
}

/** Writes `files` (relative path → content) under a new temporary directory. */
async function tree(files: Record<string, string> = {}, dirs: string[] = []): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-tree-'));
  for (const dir of dirs) await fs.mkdir(path.join(root, dir), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  return root;
}

/** Everything under `root`, as sorted `relative/path` → content, `dir/` for folders. */
async function contents(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const dirent of await fs.readdir(root, { withFileTypes: true, recursive: true })) {
    const full = path.join(dirent.parentPath, dirent.name);
    const relative = path.relative(root, full).split(path.sep).join('/');
    out[dirent.isDirectory() ? `${relative}/` : relative] = dirent.isDirectory() ? '' : await fs.readFile(full, 'utf8');
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

async function entries(dir: string, ...names: string[]): Promise<Entry[]> {
  const listing = await local.list(at(dir), new AbortController().signal, { all: true });
  return names.map((name) => {
    const entry = listing.entries.find((e) => path.basename(e.dto.id) === name);
    assert.ok(entry, `${name} is in ${dir}`);
    return entry;
  });
}

function request(over: Partial<CopyRequest> & Pick<CopyRequest, 'sourceLoc' | 'targetLoc' | 'entries'>): CopyRequest {
  return {
    source: local, target: local, options: options(), move: false,
    ask: async () => assert.fail('nothing should have been asked'),
    signal: new AbortController().signal,
    ...over,
  };
}

/** Runs the planned transfers to the end; resolves with how many failed. */
function runAll(requests: TransferRequest[]): Promise<string[]> {
  if (requests.length === 0) return Promise.resolve([]);
  return new Promise((resolve) => {
    let finished = 0;
    let errors: string[] = [];
    const queue = new TransferQueue(
      () => 4,
      (jobs) => { errors = jobs.filter((j) => j.state === 'failed').map((j) => `${j.label}: ${j.error}`); },
      () => { if (++finished === requests.length) setImmediate(() => resolve(errors)); },
    );
    queue.enqueue(requests);
  });
}

test('a folder is copied with everything in it, empty folders included', async () => {
  const from = await tree({
    'src/a.txt': 'A', 'src/b.txt': 'B', 'src/c.txt': 'C',
    'src/deep/d.txt': 'D', 'src/deep/deeper/e.txt': 'E',
  }, ['src/empty']);
  const to = await tree();

  const plan = await planCopy(request({ sourceLoc: at(from), targetLoc: at(to), entries: await entries(from, 'src') }));
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.foldersMade, 1);
  assert.deepEqual(await runAll(plan.requests), []);

  assert.deepEqual(await contents(to), {
    'src/': '', 'src/a.txt': 'A', 'src/b.txt': 'B', 'src/c.txt': 'C',
    'src/deep/': '', 'src/deep/d.txt': 'D', 'src/deep/deeper/': '', 'src/deep/deeper/e.txt': 'E',
    'src/empty/': '',
  });
});

test('copying into a folder that is there merges, and asks only about what exists', async () => {
  const from = await tree({ 'src/a.txt': 'new A', 'src/b.txt': 'new B', 'src/c.txt': 'new C' });
  const to = await tree({ 'src/a.txt': 'old A', 'src/b.txt': 'old B', 'src/keep.txt': 'mine' });
  const asked: string[] = [];

  const plan = await planCopy(request({
    sourceLoc: at(from), targetLoc: at(to), entries: await entries(from, 'src'),
    ask: async (name, _where, many): Promise<ConflictAnswer> => {
      asked.push(name);
      assert.ok(many, 'a folder is more than one thing, so "all" is offered');
      return { answer: 'skip', all: true };
    },
  }));
  assert.deepEqual(await runAll(plan.requests), []);

  assert.equal(asked.length, 1, 'Skip All answers for the rest');
  assert.equal(plan.foldersMade, 0, 'the folder was already there');
  assert.deepEqual(await contents(to), {
    'src/': '', 'src/a.txt': 'old A', 'src/b.txt': 'old B', 'src/c.txt': 'new C', 'src/keep.txt': 'mine',
  });
});

test('a folder is never copied into itself', async () => {
  const root = await tree({ 'src/a.txt': 'A' }, ['src/inner']);
  const plan = await planCopy(request({
    sourceLoc: at(root), targetLoc: at(path.join(root, 'src', 'inner')), entries: await entries(root, 'src'),
  }));
  assert.equal(plan.requests.length, 0);
  assert.match(plan.problems.join(), /cannot be copied into itself/);
  assert.deepEqual(await fs.readdir(path.join(root, 'src', 'inner')), [], 'nothing was made on the way');
});

test('a file is never copied onto itself, whatever the overwrite answer', async () => {
  // Both panes in one folder: the source would be read while it is rewritten.
  const root = await tree({ 'a.txt': 'A' });
  const plan = await planCopy(request({
    sourceLoc: at(root), targetLoc: at(root), entries: await entries(root, 'a.txt'),
    options: options({ onConflict: 'overwrite' }),
  }));
  assert.equal(plan.requests.length, 0);
  assert.match(plan.problems.join(), /onto itself/);
});

test('two files that would be stored under one name are caught before either is written', async () => {
  // A stand-in for a PDS: folders become members' homes, names become members.
  const from = await tree({ 'jcl/a.jcl': '1', 'jcl/a.txt': '2', 'jcl/b.jcl': '3' });
  const made: string[] = [];
  const pds = {
    kind: 'ds',
    label: () => 'LPAR1',
    parent: () => undefined,
    folder: async (loc: PaneLocation, name: string) => {
      made.push(name);
      return { location: { ...loc, path: `USER.${name.toUpperCase()}` }, created: true };
    },
    nameKey: (_loc: PaneLocation, name: string) => name.replace(/\..*$/, '').toUpperCase(),
    exists: async () => assert.fail('a folder this copy made has nothing to ask about'),
  } as unknown as PaneProvider;

  const plan = await planCopy(request({
    target: pds, sourceLoc: at(from), targetLoc: { kind: 'ds', profile: 'LPAR1', path: 'USER.*' },
    entries: await entries(from, 'jcl'),
  }));

  assert.deepEqual(made, ['jcl']);
  assert.deepEqual(plan.requests.map((r) => `${r.targetLoc.path}(${r.name})`).sort(),
    ['USER.JCL(a.jcl)', 'USER.JCL(b.jcl)']);
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0]!, /^a: it would land on the same name as 'a'/);
});

test('what cannot be copied is left out with a reason, and the rest still goes', async () => {
  const from = await tree({ 'one.txt': '1', 'dir/two.txt': '2' });
  const flat = {
    kind: 'jes',
    label: () => 'JES',
    exists: async () => false,
  } as unknown as PaneProvider;

  const plan = await planCopy(request({
    target: flat, sourceLoc: at(from), targetLoc: { kind: 'jes', profile: '', path: '' },
    entries: await entries(from, 'one.txt', 'dir'),
  }));
  assert.deepEqual(plan.requests.map((r) => r.name), ['one.txt']);
  assert.deepEqual(plan.problems, ['dir: JES cannot hold folders.']);
});

test('moving a folder is refused rather than half done', async () => {
  const from = await tree({ 'dir/a.txt': 'A' });
  const to = await tree();
  const plan = await planCopy(request({
    sourceLoc: at(from), targetLoc: at(to), entries: await entries(from, 'dir'), move: true,
  }));
  assert.equal(plan.requests.length, 0);
  assert.match(plan.problems.join(), /not moved yet/);
  assert.deepEqual(await fs.readdir(to), []);
});
