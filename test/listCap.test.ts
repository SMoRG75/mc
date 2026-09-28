import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Session } from '@zowe/imperative';
import { redact } from '../src/core/log';
import { UssProvider } from '../src/providers/ussProvider';
import type { SessionManager } from '../src/zowe/sessions';

/**
 * A z/OSMF that answers USS listings from a directory of `size` entries, the
 * way the real one does: '.' and '..' first, and no more than X-IBM-Max-Items
 * asks for, where 0 means all of them.
 */
async function zosmf(size: number) {
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    const max = Number(req.headers['x-ibm-max-items'] ?? 0);
    asked.push(String(req.headers['x-ibm-max-items']));
    const all = ['.', '..', ...Array.from({ length: size }, (_, i) => `f${i}`)];
    const items = (max > 0 ? all.slice(0, max) : all).map((name) => ({ name, mode: '-rw-r--r--', size: 1 }));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ items, returnedRows: items.length, totalRows: all.length }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const session = new Session({
    hostname: '127.0.0.1', port: (server.address() as AddressInfo).port,
    protocol: 'http', type: 'basic', user: 'u', password: 'p', rejectUnauthorized: false,
  });
  const uss = new UssProvider({ session: async () => session } as unknown as SessionManager, {
    pageSize: () => 10, binaryExtensions: () => [],
  });
  return { uss, asked, close: () => server.close() };
}

const here = { kind: 'uss' as const, profile: 'LPAR1', path: '/z' };
const signal = new AbortController().signal;

test('a pane asks z/OSMF for no more than it shows, and still knows there was more', async () => {
  // /z on Z Xplore: listed in full it takes longer than z/OSMF's 30 seconds.
  const host = await zosmf(5000);
  try {
    const listing = await host.uss.list(here, signal);
    assert.deepEqual(host.asked, ['13'], "ten to show, '.' and '..', and one to see if there is more");
    assert.equal(listing.entries.length, 10);
    assert.equal(listing.truncated, true);
  } finally {
    host.close();
  }
});

test('a directory that fits is not reported as cut off', async () => {
  const host = await zosmf(10);
  try {
    const listing = await host.uss.list(here, signal);
    assert.equal(listing.entries.length, 10);
    assert.equal(listing.truncated, false, "'.' and '..' are not entries");
  } finally {
    host.close();
  }
});

test('a copy still asks for everything', async () => {
  const host = await zosmf(50);
  try {
    const listing = await host.uss.list(here, signal, { all: true });
    assert.deepEqual(host.asked, ['0']);
    assert.equal(listing.entries.length, 50);
    assert.equal(listing.truncated, false);
  } finally {
    host.close();
  }
});

test('whatever writes to the log, a credential does not get through', () => {
  assert.equal(redact('Authorization: Basic c2VjcmV0OnBhc3N3b3Jk'), 'Authorization: ***');
  assert.equal(redact('[{"Authorization":"Bearer eyJhbGciOiJIUzI1NiJ9.x.y"}]'), '[{"Authorization":"***"}]');
  assert.equal(redact('Cookie: LtpaToken2=abc123def456; Path=/'), 'Cookie: ***');
  assert.equal(redact('set jwtToken=eyJabc.def.ghi and more'), 'set jwtToken=*** and more');
  // What Imperative actually writes stays readable.
  const dump = 'Headers:           [{"Accept-Encoding":"gzip"},{"X-IBM-Max-Items":"0"}]\n'
    + 'Available creds:   user,password';
  assert.equal(redact(dump), dump);
});
