import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AbstractSession } from '@zowe/imperative';
import { describeError } from '../src/core/errors';
import { Serializer } from '../src/core/serial';
import { SessionManager } from '../src/zowe/sessions';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A call that records when it runs, so overlap shows up in the log. */
function recorder() {
  const events: string[] = [];
  let running = 0;
  let most = 0;
  const call = (name: string, fail = false) => async () => {
    running += 1;
    most = Math.max(most, running);
    events.push(`start ${name}`);
    await tick();
    events.push(`end ${name}`);
    running -= 1;
    if (fail) throw new Error(`${name} failed`);
    return name;
  };
  return { events, call, most: () => most };
}

test('calls for one key run one at a time, in the order they were asked for', async () => {
  const serial = new Serializer();
  const r = recorder();
  const results = await Promise.all(['a', 'b', 'c'].map((name) => serial.run('user', r.call(name))));
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.equal(r.most(), 1);
  assert.deepEqual(r.events, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

test('different keys do not wait for each other', async () => {
  const serial = new Serializer();
  const r = recorder();
  await Promise.all([serial.run('one', r.call('a')), serial.run('two', r.call('b'))]);
  assert.equal(r.most(), 2);
});

test('a call that fails does not hold up the ones behind it', async () => {
  const serial = new Serializer();
  const r = recorder();
  const [first, second] = await Promise.allSettled([
    serial.run('user', r.call('a', true)),
    serial.run('user', r.call('b')),
  ]);
  assert.equal(first.status, 'rejected');
  assert.deepEqual(second, { status: 'fulfilled', value: 'b' });
});

test('a call given up on while it waited is not made at all', async () => {
  // Arrowing through a list of data sets queues a listing per stop; only the
  // one the pane ends up on is worth sending to the host.
  const serial = new Serializer();
  const r = recorder();
  const left = new AbortController();
  const busy = serial.run('user', r.call('busy'));
  const stale = serial.run('user', r.call('stale'), left.signal);
  const current = serial.run('user', r.call('current'));
  left.abort();
  await busy;
  await assert.rejects(stale);
  assert.equal(await current, 'current');
  assert.deepEqual(r.events, ['start busy', 'end busy', 'start current', 'end current']);
});

test('two profiles for one user on one host share the queue; another user does not', async () => {
  const sessions = new SessionManager();
  const session = (user: string) => ({ ISession: { hostname: 'h', port: 443, user } }) as unknown as AbstractSession;
  const r = recorder();
  await Promise.all([
    sessions.fileService(session('z29016'), r.call('a')),
    sessions.fileService(session('Z29016'), r.call('b')),
  ]);
  assert.equal(r.most(), 1, 'the ISPF profile is the user\'s, whatever the profile is called');
  const other = recorder();
  await Promise.all([
    sessions.fileService(session('Z29016'), other.call('a')),
    sessions.fileService(session('Z11111'), other.call('b')),
  ]);
  assert.equal(other.most(), 2);
});

test('ISPT036 is explained as the collision it is', () => {
  // What z/OSMF answered on Z Xplore with two listings at once.
  const { message, detail } = describeError({
    message: 'ServletDispatcher failed - received TSO Prompt when expecting TSO_SERVLET_DISPATCHER_READY',
    mDetails: {
      additionalDetails: '  ISPT036 Table in use  -/-TBOPEN issued for table ISPSPROF that is in use, '
        + 'ENQUEUE failed.\nREADY',
    },
  });
  assert.equal(message, 'z/OSMF could not open your ISPF profile: another request of yours was using it.');
  assert.match(detail ?? '', /Zowe Explorer, Zowe CLI, or an ISPF session of your own/);
  assert.match(detail ?? '', /TBOPEN issued for table ISPSPROF/, 'the original stays underneath');
});
