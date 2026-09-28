import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { log, type LogLevel } from '../src/core/log';
import type { PaneProvider } from '../src/core/provider';
import { traced } from '../src/core/trace';

/** Points the log at an array, at `level`, and hands back what it collects. */
function capture(level: LogLevel): string[] {
  const lines: string[] = [];
  log.configure({ appendLine: (line) => lines.push(line) }, () => level);
  return lines;
}

test('a line is written at its level and below, not above', () => {
  const lines = capture('warn');
  log.error('broken');
  log.warn('wobbly');
  log.info('fine');
  log.debug('detail');
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} \[error\] broken$/);
  assert.match(lines[1]!, /\[warn\] wobbly$/);
});

test('a detail of several lines stays with the entry it belongs to', () => {
  const lines = capture('info');
  log.error('z/OSMF said no', 'Status 500\nrc=8 reason=28');
  assert.deepEqual(lines.slice(1).join('\n').split('\n'), ['    Status 500', '    rc=8 reason=28']);
});

test('a level the setting does not know falls back to info', () => {
  const lines = capture('verbose' as LogLevel);
  log.info('shown');
  log.debug('not shown');
  assert.equal(lines.length, 1);
});

test('at debug, a provider call is traced with its arguments, its HTTP and its time', async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const lines = capture('debug');
    const provider = traced({
      kind: 'uss',
      list: () => new Promise((resolve, reject) => {
        http.get({
          host: '127.0.0.1', port, path: '/zosmf/restfiles/fs?path=%2Fu%2Fme',
          headers: { Authorization: 'Basic c2VjcmV0OnBhc3N3b3Jk' },
        }, (res) => res.resume().on('end', () => resolve({}))).on('error', reject);
      }),
    } as unknown as PaneProvider);

    await provider.list({ kind: 'uss', profile: 'LPAR1', path: '/u/me' }, new AbortController().signal);
    await new Promise((resolve) => setImmediate(resolve));

    const text = lines.join('\n');
    assert.match(text, /\[debug\] HTTP GET 127\.0\.0\.1\/zosmf\/restfiles\/fs\?path=%2Fu%2Fme → 200 \(\d+ ms\)/);
    assert.match(text, /\[debug\] uss\.list\(uss:LPAR1:\/u\/me\) \(\d+ ms\)/);
    assert.doesNotMatch(text, /Basic|c2VjcmV0/, 'headers, and the credentials in them, are never written');
  } finally {
    server.close();
  }
});

test('HTTP made outside our own calls is not ours to log', async () => {
  // Zowe Explorer runs in the same extension host, on the same channel.
  const server = http.createServer((_req, res) => res.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    traced({ kind: 'local' } as unknown as PaneProvider);
    const lines = capture('debug');
    await new Promise<void>((resolve) => {
      http.get({ port: (server.address() as AddressInfo).port, path: '/someone-else' }, (res) => {
        res.resume().on('end', () => setImmediate(resolve));
      });
    });
    assert.deepEqual(lines, []);
  } finally {
    server.close();
  }
});

test('a failed call is traced with the reason', async () => {
  const lines = capture('debug');
  const provider = traced({
    kind: 'ds',
    exists: async () => { throw new Error('not catalogued'); },
  } as unknown as PaneProvider);
  await assert.rejects(provider.exists({ kind: 'ds', profile: 'P', path: 'A.*' }, 'A.B'), /not catalogued/);
  assert.match(lines.join('\n'), /ds\.exists\(ds:P:A\.\*, "A\.B"\) failed \(\d+ ms\): not catalogued/);
});

test('below debug, nothing is traced and the call is left alone', async () => {
  const lines = capture('info');
  const provider = traced({ kind: 'local', exists: async () => true } as unknown as PaneProvider);
  assert.equal(await provider.exists({ kind: 'local', profile: '', path: '/' }, 'x'), true);
  assert.deepEqual(lines, []);
});
