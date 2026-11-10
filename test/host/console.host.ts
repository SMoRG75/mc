import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, sessions } from './host';

/*
 * Console commands against a real host. Read-only: D T changes nothing, and
 * needs no more than the INFO console authority Z Xplore users have.
 */

test('D T answers through the console service', async () => {
  const host = await sessions.host('ds', PROFILE);
  const lines: string[] = [];
  const run = () => sessions.console(host.session, () => host.console('D T', (more) => lines.push(...more)));
  if (host.type === 'rse') {
    // RSE API has no console; what matters is that it says so.
    await assert.rejects(run, /RSE API has no console service/);
    return;
  }
  await run();
  assert.ok(lines.some((line) => /\bIEE136I\b/.test(line)), lines.join('\n'));
});
