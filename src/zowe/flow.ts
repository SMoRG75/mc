import { AsyncLocalStorage } from 'node:async_hooks';
import * as diagnostics from 'node:diagnostics_channel';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { pipeline, Transform, type Readable, type TransformCallback, type Writable } from 'node:stream';

/**
 * Backpressure and cancellation for the Zowe SDK's streaming calls.
 *
 * The SDK can stream both ways — `Download.*` writes into a stream, and
 * `Upload.streamTo*` reads from one — but it never waits for either side:
 * upload chunks go into the HTTP request as fast as the source produces them,
 * and response chunks into the target stream as fast as the network delivers
 * them, with the return value of `write()` ignored in both places. Streaming
 * a 2 GB file from a local disk to a slower link would therefore still end up
 * with most of the file buffered in the request. Nor does it take an
 * AbortSignal, or notice a response that stops halfway: it waits for an end
 * that never comes.
 *
 * All three need the `ClientRequest` the SDK creates and keeps to itself. Node
 * announces every request as it is created on a diagnostics channel, and the
 * announcement runs synchronously inside the SDK's own call — so an
 * AsyncLocalStorage set around that call says which transfer each request
 * belongs to, even with several running at once.
 */

type Hook = (request: ClientRequest) => void;

const scope = new AsyncLocalStorage<Hook>();
let listening = false;

function listen(): void {
  if (listening) return;
  listening = true;
  diagnostics.subscribe('http.client.request.created', (message) => {
    scope.getStore()?.((message as { request: ClientRequest }).request);
  });
}

/**
 * Runs `call` — one SDK upload — with `source` as its body, sending the next
 * chunk only once the request has taken the previous one.
 */
export function pacedUpload<T>(
  source: Readable, signal: AbortSignal, call: (body: Readable) => Promise<T>,
): Promise<T> {
  const gate = new DrainGate();
  // pipeline rather than pipe: a source that fails has to fail the body too,
  // or the SDK would sit waiting for the rest of it.
  const body = pipeline(source, gate, () => undefined);
  return track(signal, (request) => {
    if (request.method !== 'GET') gate.follow(request);
  }, () => call(body));
}

/**
 * Runs `call` — one SDK download writing into `sink` — pausing the response
 * whenever `sink` has more than it can take.
 */
export function pacedDownload<T>(
  sink: Writable, signal: AbortSignal, call: (sink: Writable) => Promise<T>,
): Promise<T> {
  return track(signal, (request) => {
    request.once('response', (response: IncomingMessage) => pace(response, sink));
  }, () => call(sink));
}

/**
 * Runs `call` with every HTTP request it makes handed to `hook`, and settles
 * when the call does — or earlier, when the signal aborts or a response breaks
 * off before its end, which the SDK itself would wait on forever.
 */
function track<T>(signal: AbortSignal, hook: Hook, call: () => Promise<T>): Promise<T> {
  listen();
  const requests: ClientRequest[] = [];
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      outcome();
    };
    const fail = (err: unknown) => settle(() => {
      // Not ECONNRESET: the SDK retries a request that fails with that code on
      // a reused socket, which is the opposite of what cancelling means.
      for (const request of requests) request.destroy(new StoppedError());
      reject(err);
    });
    const onAbort = () => fail(signal.reason ?? new StoppedError());

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });

    scope.run((request) => {
      requests.push(request);
      request.once('response', (response: IncomingMessage) => {
        response.once('close', () => {
          if (!response.complete) fail(new Error('The connection closed before the transfer was complete.'));
        });
      });
      hook(request);
    }, call).then((value) => settle(() => resolve(value)), fail);
  });
}

class StoppedError extends Error {
  readonly code = 'MC_STOPPED';
  constructor() {
    super('The transfer was stopped.');
  }
}

/**
 * Passes chunks through, holding each one back while the request it feeds
 * still has the previous ones queued. The SDK writes a chunk the moment it is
 * emitted, so waiting here is the only place waiting can happen.
 */
class DrainGate extends Transform {
  private request?: ClientRequest;

  /** A retried request replaces the one before it. */
  follow(request: ClientRequest): void {
    this.request = request;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    const request = this.request;
    if (!request?.writableNeedDrain) {
      done(null, chunk);
      return;
    }
    // 'close' as well: a request that dies never drains, and the chunk has to
    // go somewhere for the SDK to see the failure.
    const go = () => {
      request.off('drain', go);
      request.off('close', go);
      done(null, chunk);
    };
    request.on('drain', go);
    request.on('close', go);
  }
}

/** Pauses `response` while `sink` is full. The SDK is reading it in flowing mode. */
function pace(response: IncomingMessage, sink: Writable): void {
  response.on('data', () => {
    if (!sink.writableNeedDrain || response.isPaused()) return;
    response.pause();
    const go = () => {
      sink.off('drain', go);
      sink.off('close', go);
      response.resume();
    };
    sink.on('drain', go);
    sink.on('close', go);
  });
}
