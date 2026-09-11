/**
 * The pointer that says something is happening.
 *
 * Three things can say it, and all three are needed:
 *
 *  - the webview itself, the moment it asks for something. A listing over
 *    z/OSMF is slow enough that waiting for the host's own answer before
 *    reacting would leave the keypress looking ignored, which is the thing this
 *    is here to fix.
 *  - the host, which is the only side that knows when the work actually ended.
 *  - the transfer queue, which runs on after the message that started it has
 *    long since been answered.
 */

let expected = false;
let hostWorking = false;
let transfers = false;
let guard = 0;

/**
 * Longest the pointer is allowed to stay in its waiting state on the webview's
 * word alone. The host clears it far sooner in the normal case; this is only so
 * that a message that never comes back cannot leave the pointer lying about it.
 */
const GUARD_MS = 30_000;

function apply(): void {
  document.body.classList.toggle('working', expected || hostWorking || transfers);
}

/** Called on the way out, before the host has heard anything about it. */
export function expectWork(): void {
  expected = true;
  window.clearTimeout(guard);
  guard = window.setTimeout(() => {
    expected = false;
    apply();
  }, GUARD_MS);
  apply();
}

export function setHostWorking(working: boolean): void {
  hostWorking = working;
  // The host has answered, so the guess the webview made on the way out has
  // served its purpose either way.
  if (!working) {
    expected = false;
    window.clearTimeout(guard);
  }
  apply();
}

export function setTransfersRunning(running: boolean): void {
  transfers = running;
  apply();
}
