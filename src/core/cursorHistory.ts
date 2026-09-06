import type { PaneLocation } from '../shared/protocol';

/**
 * Where the cursor was in each listing a pane has visited.
 *
 * This is what makes stepping into a PDS and back out land on the member you
 * came from rather than at the top — the one thing that separates a file
 * manager you can navigate by feel from one you have to read.
 *
 * Kept for the session only. Persisting it would mean carrying a few hundred
 * dataset names between restarts to answer a question the user has almost
 * certainly stopped asking; the one position that does survive a restart is the
 * pane's own, which is remembered separately.
 */
export class CursorHistory {
  private readonly rows = new Map<string, string>();

  /**
   * `limit` bounds a session that walks a large catalogue. The oldest entry is
   * the least recently visited location, which is the one worth losing.
   */
  constructor(private readonly limit = 200) {}

  remember(location: PaneLocation, entryId: string): void {
    const key = keyOf(location);
    // Deleting first re-inserts at the end, so Map's insertion order becomes
    // least-recently-used order and the eviction below picks the right victim.
    this.rows.delete(key);
    this.rows.set(key, entryId);
    for (const oldest of this.rows.keys()) {
      if (this.rows.size <= this.limit) break;
      this.rows.delete(oldest);
    }
  }

  recall(location: PaneLocation): string | undefined {
    return this.rows.get(keyOf(location));
  }

  get size(): number {
    return this.rows.size;
  }
}

/**
 * Identity of a listing. Joined on NUL because a USS path or a Windows path may
 * contain anything else, and two different locations must never collide.
 */
function keyOf(location: PaneLocation): string {
  return `${location.kind}\u0000${location.profile}\u0000${location.path}`;
}
