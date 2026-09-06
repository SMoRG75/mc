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
