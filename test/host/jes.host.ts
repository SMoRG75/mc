import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PaneProvider } from '../../src/core/provider';
import { JesProvider } from '../../src/providers/jesProvider';
import type { PaneLocation } from '../../src/shared/protocol';
import { collector, options, PROFILE, records, sessions, signal } from './host';

/*
 * The JES provider against a real z/OSMF. Read-only: it lists the user's own
 * jobs and reads a spool file, and changes nothing.
 */

const jes: PaneProvider = new JesProvider(sessions, { defaultOwner: () => '' });
const queue: PaneLocation = { kind: 'jes', profile: PROFILE, path: '' };

test('the job queue lists, and a job opens as a folder of spool files that stream', async (t) => {
  const jobs = (await jes.list(queue, signal())).entries;
  const job = jobs.find((e) => e.dto.kind === 'dir');
  if (!job) {
    t.skip('no jobs on the queue to read');
    return;
  }
  const inside = jes.enter(queue, job);
  assert.ok(inside, 'a job is a folder');

  const spool = (await jes.list(inside, signal())).entries;
  assert.ok(spool.length > 0, `${job.dto.name} has spool files`);
  const names = spool.map((e) => jes.describe(inside, e).name);
  assert.equal(new Set(names).size, names.length, 'no two spool files get the same name');

  const sink = collector();
  await jes.readTo(inside, spool[0]!, options(), sink, signal());
  assert.ok(records(sink.bytes().toString('utf8')).length > 0, 'the spool file has lines');
});
