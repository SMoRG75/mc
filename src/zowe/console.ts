import { ZosmfRestClient } from '@zowe/core-for-zowe-sdk';
import type { AbstractSession } from '@zowe/imperative';
import { isNotFound, UserFacingError } from '../core/errors';
import { log } from '../core/log';

/**
 * The console z/OSMF issues commands through. `defcn` is z/OSMF's own name for
 * the user's default EMCS console, so nobody has to know what it is called.
 */
const CONSOLE = 'defcn';
const RESOURCE = `/zosmf/restconsoles/consoles/${CONSOLE}`;

/** How long to wait between asking for messages that came after the first answer. */
const FOLLOW_UP_MS = 1000;
/** Asking stops after this many asks in a row that brought nothing… */
const QUIET_FOLLOW_UPS = 2;
/** …or after this many asks in all, whatever is still coming. */
const MAX_FOLLOW_UPS = 10;

/**
 * One operator command, through z/OSMF's console service.
 *
 * A console answers in pieces: z/OSMF returns what has come when it answers
 * the command, and JES and subsystem commands often reply a moment later. So
 * after the first answer mc keeps asking for more under the same response key
 * until it has been quiet for a couple of seconds, and hands each piece to
 * `write` as it comes, rather than making the user wait for the whole of it.
 *
 * Called directly, like TSO, rather than through `@zowe/zos-console-for-zowe-sdk`,
 * which would be a dependency for two requests.
 */
export async function issueConsole(
  session: AbstractSession,
  command: string,
  write: (lines: string[]) => void,
  pause: (ms: number) => Promise<void> = delay,
): Promise<void> {
  let body: ConsoleResponse;
  try {
    body = await ZosmfRestClient.putExpectJSON<ConsoleResponse>(
      session, RESOURCE, [{ 'Content-Type': 'application/json' }],
      { cmd: command, async: 'N' },
    );
  } catch (err) {
    throw consoleTrouble(err);
  }
  write(parseConsoleResponse(body['cmd-response']));
  const key = body['cmd-response-key'];
  if (!key) return;
  const uri = body['cmd-response-uri']?.startsWith('/zosmf/')
    ? body['cmd-response-uri']
    : `${RESOURCE}/solmsgs/${encodeURIComponent(key)}`;
  await collectLate(async () => {
    const more = await ZosmfRestClient.getExpectJSON<ConsoleResponse>(session, uri);
    return parseConsoleResponse(more['cmd-response']);
  }, write, pause);
}

interface ConsoleResponse {
  'cmd-response'?: string;
  'cmd-response-key'?: string;
  'cmd-response-uri'?: string;
}

/**
 * The messages in one answer, a line each. z/OSMF separates them with a bare
 * carriage return. Leading blanks are kept — console output is laid out in
 * columns — and the empty lines around the whole are not.
 */
export function parseConsoleResponse(text = ''): string[] {
  const lines = text.split(/\r\n|\r|\n/).map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Asks `next` for what came after the first answer, until it has been quiet
 * for QUIET_FOLLOW_UPS asks or MAX_FOLLOW_UPS have been made. A failed ask
 * ends it: the command has been answered already, and what is lost is at
 * most a late message, which is logged rather than shown as a failure.
 */
export async function collectLate(
  next: () => Promise<string[]>,
  write: (lines: string[]) => void,
  pause: (ms: number) => Promise<void> = delay,
): Promise<void> {
  let quiet = 0;
  for (let ask = 0; ask < MAX_FOLLOW_UPS && quiet < QUIET_FOLLOW_UPS; ask++) {
    await pause(FOLLOW_UP_MS);
    let lines: string[];
    try {
      lines = await next();
    } catch (err) {
      // A z/OSMF that has forgotten the key, or never kept one, says 404.
      if (isNotFound(err)) log.debug('The console has no later messages for this command.');
      else log.warn(`Could not ask the console for later messages: ${(err as Error).message ?? err}`);
      return;
    }
    if (lines.length > 0) {
      write(lines);
      quiet = 0;
    } else {
      quiet++;
    }
  }
}

/**
 * z/OSMF's console service answers a refusal with `reason` rather than the
 * `message` the file services use, which `describeError` would miss.
 */
function consoleTrouble(err: unknown): unknown {
  if (isNotFound(err)) {
    return new UserFacingError(
      'This z/OSMF has no console service.',
      'mc uses /zosmf/restconsoles, which needs the z/OS Operator Consoles plug-in of z/OSMF.',
    );
  }
  const cause = (err as { mDetails?: { causeErrors?: unknown } }).mDetails?.causeErrors;
  let body: unknown = cause;
  if (typeof cause === 'string') {
    try {
      body = JSON.parse(cause);
    } catch {
      return err;
    }
  }
  const b = (body ?? {}) as { reason?: unknown; msgid?: unknown; 'return-code'?: unknown; 'reason-code'?: unknown };
  if (typeof b.reason !== 'string' || !b.reason) return err;
  const codes = [
    b.msgid !== undefined ? String(b.msgid) : undefined,
    b['return-code'] !== undefined ? `rc=${b['return-code']}` : undefined,
    b['reason-code'] !== undefined ? `reason=${b['reason-code']}` : undefined,
  ].filter(Boolean).join(' ');
  return new UserFacingError(b.reason, codes || undefined);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
