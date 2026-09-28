import { AsyncLocalStorage } from 'node:async_hooks';
import * as diagnostics from 'node:diagnostics_channel';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { Readable, Writable } from 'node:stream';
import type { PaneProvider } from './provider';
import { describeError } from './errors';
import { log } from './log';

/**
 * Debug tracing: every provider call, and every HTTP request those calls make,
 * with how long each took — what someone chasing a z/OSMF problem needs to
 * see, and what would otherwise take a debugger.
 *
 * The extension host is shared with every other extension, Zowe Explorer
 * among them, so the HTTP side only reports requests made from inside one of
 * our provider calls. Only the method, host, path and status are written:
 * never a header, which is where the credentials are.
 */

const ours = new AsyncLocalStorage<true>();
let listening = false;

/** The provider methods that do something, as opposed to working something out. */
const TRACED = new Set<string>([
  'list', 'read', 'write', 'readTo', 'writeFrom', 'exists',
  'remove', 'rename', 'create', 'submit', 'folder', 'recall',
]);

/**
 * `provider`, with each of its calls traced at debug level. The calls are
 * the provider's own, unchanged: only when debug is on is anything written.
 */
export function traced(provider: PaneProvider): PaneProvider {
  listen();
  return new Proxy(provider, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string' || !TRACED.has(property)) return value;
      return (...args: unknown[]) => call(`${target.kind}.${property}`, args, () => value.apply(target, args));
    },
  });
}

async function call<T>(name: string, args: unknown[], run: () => Promise<T>): Promise<T> {
  if (!log.enabled('debug')) return run();
  const what = `${name}(${args.map(summarise).filter(Boolean).join(', ')})`;
  const started = performance.now();
  try {
    const result = await ours.run(true, run);
    log.debug(`${what} ${elapsed(started)}`);
    return result;
  } catch (err) {
    // The message only: whoever shows the error to the user logs it in full,
    // and a z/OSMF detail is too long to read twice.
    log.debug(`${what} failed ${elapsed(started)}: ${describeError(err).message}`);
    throw err;
  }
}

function listen(): void {
  if (listening) return;
  listening = true;
  diagnostics.subscribe('http.client.request.created', (message) => {
    if (!ours.getStore() || !log.enabled('debug')) return;
    const request = (message as { request: ClientRequest }).request;
    const started = performance.now();
    const what = `HTTP ${request.method} ${request.host}${request.path}`;
    request.once('response', (response: IncomingMessage) => {
      response.once('close', () => {
        const status = `${response.statusCode ?? '?'}${response.complete ? '' : ', cut off'}`;
        log.debug(`${what} → ${status} ${elapsed(started)}`);
      });
    });
    request.once('error', (err: Error) => log.debug(`${what} failed ${elapsed(started)}: ${err.message}`));
  });
}

/** One argument as it is worth reading in a log line; nothing for signals. */
function summarise(arg: unknown): string {
  if (arg === undefined || arg instanceof AbortSignal) return '';
  if (typeof arg === 'string') return JSON.stringify(arg);
  if (Buffer.isBuffer(arg)) return `${arg.length} bytes`;
  if (arg instanceof Readable || arg instanceof Writable) return 'stream';
  if (Array.isArray(arg)) return `[${arg.map(summarise).join(', ')}]`;
  if (typeof arg === 'object' && arg !== null) {
    const o = arg as Record<string, unknown>;
    // A location, an entry, transfer options — the three that come by.
    if (typeof o.kind === 'string' && 'path' in o) return `${o.kind}:${o.profile || '-'}:${String(o.path) || '/'}`;
    const dto = o.dto as { name?: string } | undefined;
    if (dto?.name !== undefined) return JSON.stringify(dto.name);
    if ('mode' in o && 'codepage' in o) return `${String(o.mode)}/${String(o.codepage)}`;
  }
  return '…';
}

function elapsed(started: number): string {
  return `(${Math.round(performance.now() - started)} ms)`;
}
