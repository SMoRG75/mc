import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTsoReply } from '../src/zowe/tso';

test('a TSO answer comes back as lines, without the READY that ends it', () => {
  // As Z Xplore answered TIME.
  const reply = parseTsoReply({
    cmdResponse: [
      { message: 'IKJ56650I TIME-01:17:01 PM. CPU-00:00:00 SERVICE-1008 SESSION-00:00:01 OCTOBER 23,2026' },
      { message: 'READY ' },
    ],
    tsoPromptReceived: 'Y',
  });
  assert.deepEqual(reply.lines, [
    'IKJ56650I TIME-01:17:01 PM. CPU-00:00:00 SERVICE-1008 SESSION-00:00:01 OCTOBER 23,2026',
  ]);
  assert.equal(reply.waiting, false);
});

test('only the last READY is TSO being done', () => {
  // LISTCAT of a data set called READY is an answer, not the end of one.
  const reply = parseTsoReply({
    cmdResponse: [{ message: 'READY' }, { message: '  IN-CAT --- CATALOG.ZOSA  ' }, { message: 'READY' }],
  });
  assert.deepEqual(reply.lines, ['READY', '  IN-CAT --- CATALOG.ZOSA']);
  assert.equal(reply.waiting, false);
});

test('a message of several lines is split into them', () => {
  const reply = parseTsoReply({ cmdResponse: [{ message: 'A\r\nB\nC' }, { message: 'READY' }] });
  assert.deepEqual(reply.lines, ['A', 'B', 'C']);
});

test('a command that stopped to ask for something says so', () => {
  // `LU * TSO NORACF` on Z Xplore: no output, no READY, no prompt answered.
  const reply = parseTsoReply({ cmdResponse: [], tsoPromptReceived: 'N' });
  assert.deepEqual(reply.lines, []);
  assert.equal(reply.waiting, true);

  // What it wrote before it stopped is still worth showing.
  const partial = parseTsoReply({ cmdResponse: [{ message: 'ENTER PASSWORD' }], tsoPromptReceived: 'N' });
  assert.deepEqual(partial.lines, ['ENTER PASSWORD']);
  assert.equal(partial.waiting, true);
});
