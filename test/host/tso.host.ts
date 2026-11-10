import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZosmfRestClient } from '@zowe/core-for-zowe-sdk';
import { PDS, PROFILE, sessions, USS_DIR } from './host';

/*
 * TSO commands against a real host, through the profile's own way in —
 * z/OSMF's stateless TSO service or RSE API's. Read-only: TIME changes nothing.
 */

test('TIME answers through the TSO service', async () => {
  const host = await sessions.host('ds', PROFILE);
  const reply = await sessions.tso(host.session, () => host.tso('TIME'));
  assert.equal(reply.waiting, false);
  assert.ok(reply.lines.some((line) => line.startsWith('IKJ56650I')), reply.lines.join('\n'));
  assert.ok(!reply.lines.includes('READY'), 'READY is taken off');
});

test('a TSO command next to three listings at once makes none of them fail', async (t) => {
  // Why TSO commands do not queue behind the file services: three listings at
  // once never collided on Z Xplore, and a TSO command alongside them did not
  // change that. Four listings at once do collide — the file services' own
  // trouble, which `sessions.fileService` is there for — so three it is.
  // Straight to z/OSMF, past the providers, which would queue the listings.
  // RSE API keeps no ISPF profile of the user's open, so there is nothing to measure.
  const host = await sessions.host('ds', PROFILE);
  if (host.type !== 'zosmf') {
    t.skip('only z/OSMF shares a TSO address space with its file services');
    return;
  }
  const { session } = host;
  const listing = (): Promise<unknown> => (PDS
    ? ZosmfRestClient.getExpectJSON(session, `/zosmf/restfiles/ds/${encodeURIComponent(PDS)}/member`,
      [{ 'X-IBM-Max-Items': '50' }])
    : ZosmfRestClient.getExpectJSON(session, `/zosmf/restfiles/fs?path=${encodeURIComponent(USS_DIR)}`,
      [{ 'X-IBM-Max-Items': '50' }]));

  for (let round = 0; round < 3; round++) {
    const [reply] = await Promise.all([host.tso('TIME'), listing(), listing(), listing()]);
    assert.ok(reply.lines.some((line) => line.startsWith('IKJ56650I')), reply.lines.join('\n'));
  }
});
