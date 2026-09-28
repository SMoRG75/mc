import { Readable, Writable } from 'node:stream';
import { log } from '../../src/core/log';
import type { TransferOptions } from '../../src/shared/protocol';
import { SessionManager } from '../../src/zowe/sessions';

/**
 * What the host tests share: the connection, the PDS they may write into, and
 * a way to collect what a provider streams out.
 */

export const PDS = (process.env.MC_HOST_PDS ?? '').toUpperCase();
export const USS_DIR = (process.env.MC_HOST_USS_DIR ?? '').replace(/\/+$/, '');
export const PROFILE = process.env.MC_HOST_PROFILE ?? '';

/** Every member a test makes starts with this, and only those are ever removed. */
export const PREFIX = 'MCT';
/** The same for USS, where case is kept. */
export const USS_PREFIX = 'mct';

export const sessions = new SessionManager();

if (process.env.MC_HOST_DEBUG) {
  log.configure({ appendLine: (line) => console.log(line) }, () => 'debug');
}

export const signal = () => new AbortController().signal;

export function options(over: Partial<TransferOptions> = {}): TransferOptions {
  return {
    mode: 'text', codepage: 'IBM-277', longLines: 'wrap', onConflict: 'overwrite', destination: '*',
    ...over,
  };
}

/** A sink that keeps everything written to it. */
export function collector(): Writable & { bytes(): Buffer } {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  }) as Writable & { bytes(): Buffer };
  sink.bytes = () => Buffer.concat(chunks);
  return sink;
}

export function streamOf(text: string): Readable {
  return Readable.from([Buffer.from(text, 'utf8')]);
}

/**
 * Text as records: line endings evened out and trailing blanks dropped, since
 * a fixed-length record pads with them and z/OSMF gives them back or not
 * depending on the service — neither is a difference in the content.
 */
export function records(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
