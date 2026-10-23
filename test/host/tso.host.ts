import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZosmfRestClient } from '@zowe/core-for-zowe-sdk';
import { issueTso } from '../../src/zowe/tso';
import { PDS, PROFILE, sessions, USS_DIR } from './host';

/*
 * TSO commands against a real z/OSMF. Read-only: TIME changes nothing.
 */

test('TIME answers through the stateless TSO service', async () => {
  const session = await sessions.session(PROFILE);
  const reply = await sessions.tso(session, () => issueTso(session, 'TIME'));
  assert.equal(reply.waiting, false);
  assert.ok(reply.lines.some((line) => line.startsWith('IKJ56650I')), reply.lines.join('\n'));
  assert.ok(!reply.lines.includes('READY'), 'READY is taken off');
});

test('a TSO command next to three listings at once makes none of them fail', async () => {
  // Why TSO commands do not queue behind the file services: three listings at
  // once never collided on Z Xplore, and a TSO command alongside them did not
  // change that. Four listings at once do collide — the file services' own
  // trouble, which `sessions.fileService` is there for — so three it is.
  // Straight to z/OSMF, past the providers, which would queue the listings.
  const session = await sessions.session(PROFILE);
  const listing = (): Promise<unknown> => (PDS
    ? ZosmfRestClient.getExpectJSON(session, `/zosmf/restfiles/ds/${encodeURIComponent(PDS)}/member`,
      [{ 'X-IBM-Max-Items': '50' }])
    : ZosmfRestClient.getExpectJSON(session, `/zosmf/restfiles/fs?path=${encodeURIComponent(USS_DIR)}`,
      [{ 'X-IBM-Max-Items': '50' }]));

  for (let round = 0; round < 3; round++) {
    const [reply] = await Promise.all([issueTso(session, 'TIME'), listing(), listing(), listing()]);
    assert.ok(reply.lines.some((line) => line.startsWith('IKJ56650I')), reply.lines.join('\n'));
  }
});
