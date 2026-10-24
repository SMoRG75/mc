import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueConsole } from '../../src/zowe/console';
import { PROFILE, sessions } from './host';

/*
 * Console commands against a real z/OSMF. Read-only: D T changes nothing, and
 * needs no more than the INFO console authority Z Xplore users have.
 */

test('D T answers through the console service', async () => {
  const session = await sessions.session(PROFILE);
  const lines: string[] = [];
  await sessions.console(session, () => issueConsole(session, 'D T', (more) => lines.push(...more)));
  assert.ok(lines.some((line) => /\bIEE136I\b/.test(line)), lines.join('\n'));
});
