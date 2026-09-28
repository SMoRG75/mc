import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Session } from '@zowe/imperative';
import { UserFacingError } from '../src/core/errors';
import type { Entry, PaneProvider } from '../src/core/provider';
import { planCopy } from '../src/core/treeCopy';
import { DsProvider } from '../src/providers/dsProvider';
import { LocalProvider } from '../src/providers/localProvider';
import type { SessionManager } from '../src/zowe/sessions';

/**
 * A z/OSMF with one data set on it, migrated until `backAfter` checks after
 * the recall request — the way DFSMShsm hands it back some time later.
 */
async function zosmf(backAfter: number) {
  const requests: { method: string; url: string; body: string }[] = [];
  let recalled = false;
  let checks = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'PUT') {
        recalled = JSON.parse(body).request === 'hrecall';
        res.end('{}');
        return;
      }
      if (recalled) checks += 1;
      const back = recalled && checks > backAfter;
      res.end(JSON.stringify({
        items: [back
          ? { dsname: 'USER.OLD', dsorg: 'PS', recfm: 'FB', lrecl: '80', vol: 'VOL001', migr: 'NO' }
          : { dsname: 'USER.OLD', vol: 'MIGRAT', migr: 'YES' }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const session = new Session({
    hostname: '127.0.0.1', port: (server.address() as AddressInfo).port,
    protocol: 'http', type: 'basic', user: 'u', password: 'p', rejectUnauthorized: false,
  });
  const sessions = {
    session: async () => session,
    fileService: <T>(_session: unknown, call: () => Promise<T>) => call(),
  };
  const ds = (patienceMs = 5_000) => new DsProvider(sessions as unknown as SessionManager, {
    pageSize: () => 100, binaryExtensions: () => [], defaultFilter: () => '',
    recall: { pollMs: 5, patienceMs },
  });
  return { ds, requests, close: () => server.close() };
}

const loc = { kind: 'ds' as const, profile: 'LPAR1', path: 'USER.*' };
const migrated: Entry = {
  dto: { id: 'USER.OLD', name: 'USER.OLD', kind: 'file', attention: true, cells: {} },
  ref: { kind: 'dataset', dsname: 'USER.OLD', migrated: true },
};

test('a recall is queued at HSM, not waited on, and resolves once the data set is back', async () => {
  const host = await zosmf(3);
  try {
    await host.ds().recall(loc, migrated, new AbortController().signal);
    const put = host.requests.find((r) => r.method === 'PUT')!;
    assert.equal(put.url, '/zosmf/restfiles/ds/USER.OLD');
    // wait: false — a recall from tape must not hold the file-service queue.
    assert.deepEqual(JSON.parse(put.body), { request: 'hrecall', wait: false });
    assert.equal(host.requests.filter((r) => r.method === 'GET').length, 4, 'checked until it came back');
  } finally {
    host.close();
  }
});

test('a recall that never comes back is given up on, and says where to look', async () => {
  const host = await zosmf(Infinity);
  try {
    await assert.rejects(host.ds(60).recall(loc, migrated, new AbortController().signal), (err: unknown) => {
      assert.ok(err instanceof UserFacingError);
      assert.match(err.message, /USER\.OLD is still migrated after/);
      assert.match(err.detail ?? '', /HQUERY/);
      return true;
    });
  } finally {
    host.close();
  }
});

test('the waiting can be stopped; the recall request has already gone', async () => {
  const host = await zosmf(Infinity);
  try {
    const stop = new AbortController();
    const waiting = host.ds().recall(loc, migrated, stop.signal);
    setTimeout(() => stop.abort(), 30);
    await assert.rejects(waiting);
    assert.equal(host.requests.filter((r) => r.method === 'PUT').length, 1);
  } finally {
    host.close();
  }
});

test('a migrated data set says so, and a copy leaves it out instead of recalling it', async () => {
  const ds = new DsProvider({} as SessionManager, {
    pageSize: () => 100, binaryExtensions: () => [], defaultFilter: () => '',
  });
  assert.equal(ds.describe(loc, migrated).offline, 'migrated');

  const to = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-recall-'));
  const plan = await planCopy({
    source: ds as PaneProvider, sourceLoc: loc,
    target: new LocalProvider(() => 100), targetLoc: { kind: 'local', profile: '', path: to },
    entries: [migrated],
    options: { mode: 'auto', codepage: 'IBM-037', longLines: 'abort', onConflict: 'ask', destination: '*' },
    move: false,
    ask: async () => undefined,
    signal: new AbortController().signal,
  });
  assert.equal(plan.requests.length, 0);
  assert.deepEqual(plan.problems, ['USER.OLD: it is migrated — recall it first: Enter on it offers to.']);
});
