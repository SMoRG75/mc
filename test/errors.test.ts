import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeError, UserFacingError } from '../src/core/errors';

test('a UserFacingError is passed through as written', () => {
  const err = new UserFacingError('Dataset is migrated.', 'Run HRECALL first.');
  assert.deepEqual(describeError(err), {
    message: 'Dataset is migrated.', detail: 'Run HRECALL first.',
  });
});

test('the readable sentence is dug out of a z/OSMF body', () => {
  // What Imperative hands over: the useful text is in causeErrors, as a string
  // of JSON, and the message on the outside is the generic HTTP failure.
  const imperative = {
    message: 'Rest API failure with HTTP(S) status 500',
    errorCode: 500,
    mDetails: {
      msg: 'Rest API failure with HTTP(S) status 500',
      causeErrors: JSON.stringify({
        category: 1, rc: 8, reason: 28,
        message: 'Data set not found.',
        details: ['ISRZ002 Data set not cataloged'],
      }),
    },
  };
  const { message, detail } = describeError(imperative);
  assert.equal(message, 'Data set not found.');
  assert.match(detail ?? '', /Status 500/);
  assert.match(detail ?? '', /ISRZ002 Data set not cataloged/);
  assert.match(detail ?? '', /rc=8 reason=28/);
});

test('a causeErrors that is not JSON is still shown rather than swallowed', () => {
  const { message } = describeError({ mDetails: { causeErrors: 'connect ECONNREFUSED' } });
  assert.equal(message, 'connect ECONNREFUSED');
});

test('falling back through the layers, and never to nothing', () => {
  assert.equal(describeError({ message: 'plain' }).message, 'plain');
  assert.equal(describeError({ mDetails: { msg: 'from details' } }).message, 'from details');
  assert.equal(describeError({}).message, 'Unknown error');
  assert.equal(describeError('a string').message, 'a string');
  assert.equal(describeError(null).message, 'null');
});

test('a TSO address space stuck at a prompt is explained, wherever it surfaces', () => {
  // What z/OSMF answers a USS listing with when its TSO address space is
  // waiting at a prompt — nothing in it says what to do.
  const zosmf = {
    message: 'Rest API failure with HTTP(S) status 500',
    errorCode: 500,
    mDetails: {
      causeErrors: JSON.stringify({
        category: 9, rc: 8, reason: 0,
        message: 'ServletDispatcher failed - received TSO Prompt when expecting TSO_SERVLET_DISPATCHER_READY',
      }),
    },
  };
  const { message, detail } = describeError(zosmf);
  assert.match(message, /TSO address space .* stuck at a prompt/);
  assert.match(detail ?? '', /wait a few minutes and press F2/);
  assert.match(detail ?? '', /received TSO Prompt/, 'the original is kept for whoever has to look into it');
});

test('a TSO address space that does not answer is named, so an operator can find it', () => {
  const { message, detail } = describeError({
    message: 'receiveResponseHeader: timeout receiving response (>30 secs): '
      + 'TsoServerConnection(USER=Z29016, ASID=0x00df, QID=0x0033002c)',
  });
  assert.equal(message, "z/OSMF’s TSO address space for Z29016 (ASID X'00DF') is not answering.");
  assert.match(detail ?? '', /SDSF DA, the address space with ASID 00DF/);
});

test('a plain timeout is not mistaken for a stuck TSO address space', () => {
  assert.equal(describeError({ message: 'timeout receiving response from host' }).message,
    'timeout receiving response from host');
});
