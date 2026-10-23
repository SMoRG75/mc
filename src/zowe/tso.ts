import { ZosmfRestClient } from '@zowe/core-for-zowe-sdk';
import type { AbstractSession } from '@zowe/imperative';
import { UserFacingError } from '../core/errors';

/**
 * One TSO command, through z/OSMF's stateless TSO API (z/OS 2.4 and later).
 *
 * Stateless rather than a session of our own: it needs no account number,
 * leaves no address space behind for anyone to stop, and after the first call
 * it answers as fast as a held session does (~150 ms on Z Xplore). Measured
 * there not to collide with the file services over the ISPF profile, so it
 * does not queue behind them — see docs/tso-commands.md.
 *
 * Called directly rather than through `IssueTso.issueTsoCmd`, which asks
 * /zosmf/info for the z/OS level on every call and throws away
 * `tsoPromptReceived` — the one thing that says why a reply is empty.
 */
export async function issueTso(session: AbstractSession, command: string): Promise<TsoReply> {
  try {
    const body = await ZosmfRestClient.putExpectJSON<StatelessResponse>(
      session, '/zosmf/tsoApp/v1/tso', [{ 'Content-Type': 'application/json' }],
      { tsoCmd: command, cmdState: 'stateless' },
    );
    return parseTsoReply(body);
  } catch (err) {
    if (isNotFound(err)) {
      throw new UserFacingError(
        'This z/OSMF has no TSO command service.',
        'mc uses /zosmf/tsoApp/v1/tso, which came with z/OS 2.4.',
      );
    }
    throw err;
  }
}

export interface TsoReply {
  /** What TSO wrote, one entry per line, without the READY that ends it. */
  lines: string[];
  /**
   * The command stopped to ask for something. The stateless service cannot
   * answer, so it gives up and returns what it had — often nothing.
   */
  waiting: boolean;
}

interface StatelessResponse {
  cmdResponse?: { message?: string }[];
  tsoPromptReceived?: string;
}

export function parseTsoReply(body: StatelessResponse): TsoReply {
  const lines = (body.cmdResponse ?? [])
    .flatMap((item) => (item.message ?? '').split(/\r?\n/))
    .map((line) => line.trimEnd());
  // READY is TSO saying it is done, not part of the answer — and the only
  // sign that it is done, so it is taken off the end and nowhere else.
  const ready = lines.length > 0 && lines[lines.length - 1]!.trim() === 'READY';
  if (ready) lines.pop();
  return { lines, waiting: body.tsoPromptReceived === 'N' && !ready };
}

function isNotFound(err: unknown): boolean {
  const e = err as { errorCode?: unknown; message?: unknown };
  return String(e.errorCode) === '404' || /status 404\b/.test(String(e.message ?? ''));
}
