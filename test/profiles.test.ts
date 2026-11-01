import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultProfileFor, profilesFor, type ProfileDto } from '../src/shared/protocol';
import { applyTag } from '../src/zowe/rse';
import { SessionManager } from '../src/zowe/sessions';

const profile = (name: string, type: string, isDefault = false): ProfileDto => ({ name, type, isDefault });

const config = [
  profile('test', 'zosmf'),
  profile('prod', 'zosmf', true),
  profile('test-rse', 'rse', true),
  profile('tso', 'tso', true),
];

/** A session manager whose profiles come from a list instead of zowe.config.json. */
class ListedProfiles extends SessionManager {
  constructor(private readonly listed: ProfileDto[]) {
    super();
  }

  override profiles(): Promise<ProfileDto[]> {
    return Promise.resolve(this.listed);
  }
}

test('a z/OS world lists its z/OSMF and RSE profiles, and none of another type', () => {
  assert.deepEqual(profilesFor('ds', config).map((p) => p.name), ['test', 'prod', 'test-rse']);
});

test('the local disk lists no profiles', () => {
  assert.deepEqual(profilesFor('local', config), []);
});

test('the default of a z/OS world is the z/OSMF default, and the RSE one without it', () => {
  assert.equal(defaultProfileFor('jes', config)?.name, 'prod');
  assert.equal(defaultProfileFor('jes', [profile('test', 'zosmf'), profile('test-rse', 'rse', true)])?.name, 'test-rse');
  assert.equal(defaultProfileFor('jes', [profile('tso', 'tso', true)]), undefined);
  assert.equal(defaultProfileFor('local', config), undefined);
});

test('a world keeps a profile it can be on, and the default and unknown names', async () => {
  const sessions = new ListedProfiles(config);
  assert.equal(await sessions.fits('uss', 'test'), true);
  assert.equal(await sessions.fits('uss', 'test-rse'), true);
  assert.equal(await sessions.fits('uss', ''), true);
  assert.equal(await sessions.fits('uss', 'gone'), true);
});

test('a world does not take over a profile of a type it cannot use', async () => {
  const sessions = new ListedProfiles(config);
  assert.equal(await sessions.fits('local', 'test'), false);
  assert.equal(await sessions.fits('local', 'test-rse'), false);
});

test('a USS tag read over RSE decides binary and codepage the way z/OSMF\'s does', () => {
  const read = (tag: string) => {
    const options: { binary?: boolean; encoding?: string } = { encoding: 'IBM-277' };
    applyTag(tag, options);
    return options;
  };
  assert.deepEqual(read('b binary  T=off /u/x'), { encoding: 'IBM-277', binary: true });
  assert.deepEqual(read('t ISO8859-1   T=on  /u/x'), { encoding: 'IBM-277', binary: true });
  assert.deepEqual(read('t IBM-1047    T=on  /u/x'), { encoding: 'IBM-1047' });
  assert.deepEqual(read('- untagged    T=off /u/x'), { encoding: 'IBM-277' });
});
