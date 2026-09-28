import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Session } from '@zowe/imperative';
import { describeError } from '../src/core/errors';
import type { PaneProvider } from '../src/core/provider';
import { DsProvider } from '../src/providers/dsProvider';
import type { DatasetSpec } from '../src/shared/protocol';
import type { SessionManager } from '../src/zowe/sessions';

/**
 * A z/OSMF whose SMS refuses any allocation in cylinders, as IBM Z Xplore's
 * does — measured there: one cylinder is refused, one track is not.
 */
async function zosmf() {
  const allocations: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET') {
        res.end(JSON.stringify({ items: [] })); // nothing there yet
        return;
      }
      const attributes = JSON.parse(body) as Record<string, unknown>;
      allocations.push(attributes);
      if (attributes.alcunit === 'CYL') {
        res.statusCode = 500;
        res.end(JSON.stringify({
          category: 4, rc: 8, reason: 0,
          message: 'Dynamic allocation Error - SMS or ACS services returned an error.  '
            + 'Ensure any specified storclas, dataclas, or mgmtclas values are defined.',
        }));
        return;
      }
      res.statusCode = 201;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const session = new Session({
    hostname: '127.0.0.1', port: (server.address() as AddressInfo).port,
    protocol: 'http', type: 'basic', user: 'user', password: 'p', rejectUnauthorized: false,
  });
  const sessions = {
    session: async () => session,
    fileService: <T>(_session: unknown, call: () => Promise<T>) => call(),
  };
  const ds = new DsProvider(sessions as unknown as SessionManager, {
    pageSize: () => 100, binaryExtensions: () => [], defaultFilter: () => '',
  });
  return { ds, allocations, close: () => server.close() };
}

const filter = { kind: 'ds' as const, profile: 'LPAR1', path: 'USER.*' };
const cylinders: DatasetSpec = {
  type: 'pdse', recfm: 'FB', lrecl: 80, blksize: 27920, alcunit: 'CYL', primary: 2, secondary: 1,
};

test('F7 without the dialog allocates in tracks, as the dialog would', async () => {
  // Left without a unit, the SDK used cylinders — refused on Z Xplore.
  const host = await zosmf();
  try {
    assert.equal(await host.ds.create(filter, 'NEW'), 'USER.NEW');
    assert.equal(host.allocations.length, 1);
    assert.equal(host.allocations[0]!.alcunit, 'TRK');
  } finally {
    host.close();
  }
});

test('a PDS copied in cylinders is allocated in tracks when SMS refuses cylinders', async () => {
  const host = await zosmf();
  try {
    const made = await (host.ds as PaneProvider).folder!(filter, 'USER.SRC', {
      from: 'ds', dataset: cylinders, files: 0, bytes: 0,
    });
    assert.deepEqual(made, { location: { ...filter, path: 'USER.SRC' }, created: true });
    assert.deepEqual(host.allocations.map((a) => [a.alcunit, a.primary, a.secondary]),
      [['CYL', 2, 1], ['TRK', 30, 15]], 'the same space, 15 tracks to a cylinder');
  } finally {
    host.close();
  }
});

test('cylinders the user chose in F7 are not changed behind their back, but explained', async () => {
  const host = await zosmf();
  try {
    await assert.rejects(host.ds.create(filter, 'NEW', cylinders), (err: unknown) => {
      const { message, detail } = describeError(err);
      assert.equal(message, 'SMS refused to allocate USER.NEW.');
      assert.match(detail ?? '', /Choose Tracks in the dialog/);
      assert.match(detail ?? '', /Dynamic allocation Error/, "SMS's own words stay underneath");
      return true;
    });
    assert.equal(host.allocations.length, 1, 'tried once, as asked');
  } finally {
    host.close();
  }
});
