import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Reads `source` to the end into a temporary file, then hands `use` a stream
 * of that file.
 *
 * For the one case where streaming straight through would be wrong: a check
 * that can refuse the transfer halfway. Everything before the refusal would
 * already be on the host, and a member that is half replaced is worse than one
 * that was never touched. Disk is the price of keeping memory flat as well.
 */
export async function spooled<T>(
  source: Readable, signal: AbortSignal, use: (replay: Readable) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-'));
  try {
    const file = path.join(dir, 'spool');
    await pipeline(source, createWriteStream(file), { signal });
    const replay = createReadStream(file);
    try {
      return await use(replay);
    } finally {
      // Closed before the directory goes: Windows will not delete a file that
      // is still open, and a failed upload can leave it half read.
      if (!replay.closed) {
        await new Promise<void>((resolve) => replay.once('close', () => resolve()).destroy());
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
