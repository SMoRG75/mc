import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable, Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { pacedDownload, pacedUpload } from '../src/zowe/flow';

const MB = 1024 * 1024;

/*
 * The clients below do what the Zowe SDK's REST client does, which is the
 * behaviour flow.ts exists to work around: every chunk is written the moment
 * it arrives, whatever `write()` returns, and the promise settles only on a
 * clean end — a response that breaks off leaves it pending for good.
 */

function sdkLikeUpload(port: number, body: Readable): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({ port, method: 'PUT', path: '/upload' }, (response) => {
      let text = '';
      response.on('data', (chunk: Buffer) => { text += chunk.toString(); });
      response.on('end', () => resolve(Number(text)));
    });
    request.on('error', reject);
    body.on('data', (chunk: Buffer) => { request.write(chunk); });
    body.on('error', reject);
    body.on('end', () => request.end());
  });
}

function sdkLikeDownload(port: number, sink: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = http.request({ port, path: '/download' }, (response) => {
      response.on('data', (chunk: Buffer) => { sink.write(chunk); });
      response.on('end', () => {
        sink.on('finish', resolve);
        sink.end();
      });
    });
    request.on('error', reject);
    request.end();
  });
}

/** A source of `total` bytes that counts how many it has been asked for. */
function counted(total: number): Readable & { produced: number } {
  const chunk = Buffer.alloc(64 * 1024, 0x41);
  const source = new Readable({
    read() {
      if (source.produced >= total) {
        this.push(null);
        return;
      }
      source.produced += chunk.length;
      this.push(chunk);
    },
  }) as Readable & { produced: number };
  source.produced = 0;
  return source;
}

async function serve(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** Stalls every upload until `release` is called, then counts what arrives. */
async function stallingUploadServer() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const server = await serve((req, res) => {
    req.pause();
    void released.then(() => {
      let received = 0;
      req.on('data', (chunk: Buffer) => { received += chunk.length; });
      req.on('end', () => res.end(String(received)));
      req.resume();
    });
  });
  return { ...server, release };
}

test('without pacing, an upload reads its whole source into memory', async () => {
  // The control for the test after it: proof that the client above really
  // does behave the way that makes pacing necessary.
  const server = await stallingUploadServer();
  try {
    const source = counted(64 * MB);
    const upload = sdkLikeUpload(server.port, source);
    await sleep(500);
    assert.equal(source.produced, 64 * MB);
    server.release();
    assert.equal(await upload, 64 * MB);
  } finally {
    await server.close();
  }
});

test('a paced upload reads no further ahead than the request can take', async () => {
  const server = await stallingUploadServer();
  try {
    const source = counted(64 * MB);
    const upload = pacedUpload(source, new AbortController().signal,
      (body) => sdkLikeUpload(server.port, body));
    await sleep(500);
    // Socket buffers hold some; the rest of the 64 MB must still be unread.
    assert.ok(source.produced < 16 * MB, `read ${source.produced / MB} MB ahead of a stalled server`);
    server.release();
    assert.equal(await upload, 64 * MB);
  } finally {
    await server.close();
  }
});

test('a paced download pauses the response while the sink is full', async () => {
  const body = Buffer.alloc(64 * MB, 0x42);
  const server = await serve((_req, res) => res.end(body));
  try {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    let received = 0;
    let peak = 0;
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        peak = Math.max(peak, this.writableLength);
        received += chunk.length;
        void opened.then(() => done());
      },
    });
    const download = pacedDownload(sink, new AbortController().signal,
      (stream) => sdkLikeDownload(server.port, stream));
    await sleep(500);
    assert.ok(sink.writableLength < 4 * MB, `${sink.writableLength / MB} MB queued in a stalled sink`);
    open();
    await download;
    assert.equal(received, 64 * MB);
    assert.ok(peak < 4 * MB, `the sink peaked at ${peak / MB} MB`);
  } finally {
    await server.close();
  }
});

test('aborting stops a transfer the SDK would never give up on', async () => {
  const server = await serve((_req, res) => {
    // Headers and a little, then nothing: a job that is still writing.
    res.writeHead(200);
    res.write('partial');
  });
  try {
    const stop = new AbortController();
    const sink = new Writable({ write: (_chunk, _encoding, done) => done() });
    const download = pacedDownload(sink, stop.signal, (stream) => sdkLikeDownload(server.port, stream));
    await sleep(100);
    stop.abort(new Error('cancelled by the user'));
    await assert.rejects(download, /cancelled by the user/);
  } finally {
    await server.close();
  }
});

test('a response that breaks off halfway fails instead of hanging', async () => {
  const server = await serve((_req, res) => {
    res.writeHead(200, { 'Content-Length': '1000' });
    res.write('only some of it');
    setTimeout(() => res.socket?.destroy(), 20);
  });
  try {
    const sink = new Writable({ write: (_chunk, _encoding, done) => done() });
    await assert.rejects(
      pacedDownload(sink, new AbortController().signal, (stream) => sdkLikeDownload(server.port, stream)),
      /closed before the transfer was complete/,
    );
  } finally {
    await server.close();
  }
});

test('concurrent uploads are each paced by their own request', async () => {
  // The request is found through the async context of the call that made it,
  // so two transfers at once must not end up gated by each other's socket.
  const stalled = await stallingUploadServer();
  const open = await serve((req, res) => {
    let received = 0;
    req.on('data', (chunk: Buffer) => { received += chunk.length; });
    req.on('end', () => res.end(String(received)));
  });
  try {
    const slow = counted(64 * MB);
    const fast = counted(32 * MB);
    const signal = new AbortController().signal;
    const slowUpload = pacedUpload(slow, signal, (body) => sdkLikeUpload(stalled.port, body));
    const fastUpload = pacedUpload(fast, signal, (body) => sdkLikeUpload(open.port, body));
    assert.equal(await fastUpload, 32 * MB);
    assert.ok(slow.produced < 16 * MB, `the stalled upload read ${slow.produced / MB} MB`);
    stalled.release();
    assert.equal(await slowUpload, 64 * MB);
  } finally {
    await stalled.close();
    await open.close();
  }
});
