/**
 * One call at a time per key, in the order they were asked for.
 *
 * For z/OSMF's file services: they run in a TSO address space of the user's,
 * and when two requests arrive at once z/OSMF starts a second one. That one
 * logs on with ISPF too, finds the user's ISPF profile (ISPSPROF) held by the
 * first, and stops at `ISPT036 Table in use` — which z/OSMF reports as
 * "received TSO Prompt when expecting TSO_SERVLET_DISPATCHER_READY". Measured
 * on IBM's Z Xplore with nothing but Zowe CLI: four listings at once failed 3
 * times in 12, the same four one after another never.
 */
export class Serializer {
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Runs `call` once every call queued for `key` before it has finished.
   * A call whose `signal` has aborted while it waited is not run at all: a
   * listing for a folder the user has already left is only in the way.
   */
  async run<T>(key: string, call: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const before = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = before.then(() => new Promise<void>((resolve) => { release = resolve; }));
    this.tails.set(key, tail);
    try {
      await before;
      signal?.throwIfAborted();
      return await call();
    } finally {
      // `before` has settled by now, so `release` has been set.
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
