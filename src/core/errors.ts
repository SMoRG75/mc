/**
 * Errors the user is meant to read.
 *
 * z/OSMF reports failures as an HTTP status plus a JSON body whose useful part
 * is buried; Imperative wraps that again. `describeError` digs the readable
 * sentence back out so the pane can show it without a stack trace.
 */
export class UserFacingError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

interface ImperativeLike {
  message?: string;
  mDetails?: { msg?: string; causeErrors?: unknown; additionalDetails?: string };
  errorCode?: number | string;
}

export function describeError(err: unknown): { message: string; detail?: string } {
  if (err instanceof UserFacingError) {
    return { message: err.message, detail: err.detail };
  }
  const described = describeRaw(err);
  return tsoTrouble(described) ?? described;
}

/**
 * z/OSMF runs its file services in a TSO address space of the user's own. When
 * that address space stops — at a prompt, or by not answering at all — every
 * request that needs it fails, a USS listing as much as a data set one, however
 * unrelated the request is to what caused it. z/OSMF's messages name its own
 * internals and nothing the user can do, so they are replaced with what is
 * going on and who can clear it; the original stays at the bottom.
 */
function tsoTrouble(described: { message: string; detail?: string }): { message: string; detail: string } | undefined {
  const original = [described.message, described.detail].filter(Boolean).join('\n');
  const prompt = /TSO Prompt when expecting/i.test(original);
  const silent = /timeout receiving response[\s\S]*TsoServerConnection/i.test(original);
  if (!prompt && !silent) return undefined;

  // TsoServerConnection(USER=Z29016, ASID=0x00df, ...) says exactly which one.
  const user = /USER=([A-Z0-9$#@]+)/i.exec(original)?.[1]?.toUpperCase();
  const asid = /ASID=0x([0-9a-f]+)/i.exec(original)?.[1]?.toUpperCase().padStart(4, '0');
  const which = user && asid ? ` for ${user} (ASID X'${asid}')` : ' for your user';

  return {
    message: prompt
      ? `z/OSMF’s TSO address space${which} is stuck at a prompt.`
      : `z/OSMF’s TSO address space${which} is not answering.`,
    detail: 'The request itself is not the problem — z/OSMF runs file services in a TSO '
      + 'address space, and that one has stopped. Usually an earlier request made TSO ask '
      + 'something nobody can answer, such as DFSMShsm asking whether to recall a migrated '
      + 'data set, and it then answers nothing else either.\n\n'
      + 'z/OSMF ends it after its own timeout, and the next request gets a new one: wait a '
      + 'few minutes and press F2. Sooner than that, an operator can cancel it'
      + (asid ? ` — in SDSF DA, the address space with ASID ${asid}` : '')
      + '.\n\n'
      + 'If it comes back every time, the logon procedure z/OSMF starts TSO with (IZUFPROC '
      + 'unless changed) or your TSO profile prompts on every logon — a missing account '
      + 'number, for instance — and a system programmer has to look at it.\n\n'
      + original,
  };
}

function describeRaw(err: unknown): { message: string; detail?: string } {
  if (typeof err === 'object' && err !== null) {
    const e = err as ImperativeLike;
    const cause = parseCause(e.mDetails?.causeErrors);
    const message = cause?.message ?? e.mDetails?.msg ?? e.message ?? 'Unknown error';
    const detail = [
      e.errorCode !== undefined ? `Status ${e.errorCode}` : undefined,
      cause?.reason,
      e.mDetails?.additionalDetails,
    ].filter(Boolean).join('\n') || undefined;
    return { message, detail };
  }
  return { message: String(err) };
}

/**
 * z/OSMF puts the interesting text in `details[]` or in `message`, and
 * Imperative hands it over as either a string or an already-parsed object.
 */
function parseCause(cause: unknown): { message: string; reason?: string } | undefined {
  let body: unknown = cause;
  if (typeof cause === 'string') {
    try {
      body = JSON.parse(cause);
    } catch {
      return { message: cause };
    }
  }
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as { message?: string; details?: unknown; reason?: number; rc?: number };
  const details = Array.isArray(b.details) ? b.details.join('\n') : undefined;
  const message = b.message ?? details;
  if (!message) return undefined;
  const reason = b.rc !== undefined || b.reason !== undefined
    ? `rc=${b.rc ?? '?'} reason=${b.reason ?? '?'}`
    : undefined;
  return { message, reason: [details && b.message ? details : undefined, reason].filter(Boolean).join('\n') || undefined };
}
