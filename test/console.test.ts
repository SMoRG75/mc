import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectLate, parseConsoleResponse } from '../src/zowe/console';

const noPause = async (): Promise<void> => {};

test('a console answer is split at the bare carriage returns z/OSMF puts between messages', () => {
  const lines = parseConsoleResponse(
    ' VTS1      10:11:12\rIEE254I  IPLINFO DISPLAY\r SYSTEM IPLED AT 08.00.00 ON 10/24/2026\r',
  );
  assert.deepEqual(lines, [
    ' VTS1      10:11:12',
    'IEE254I  IPLINFO DISPLAY',
    ' SYSTEM IPLED AT 08.00.00 ON 10/24/2026',
  ], 'leading blanks are kept: console output is laid out in columns');
});

test('empty lines around an answer go, empty lines inside it stay', () => {
  assert.deepEqual(parseConsoleResponse('\r\rA\r\rB   \r\r'), ['A', '', 'B']);
  assert.deepEqual(parseConsoleResponse(''), []);
  assert.deepEqual(parseConsoleResponse(undefined), []);
});

test('later messages are collected until the console has been quiet twice in a row', async () => {
  const answers = [['$HASP890 JOB(A)'], [], ['$HASP890 JOB(B)'], [], [], ['never asked for']];
  const written: string[][] = [];
  let asks = 0;
  await collectLate(async () => answers[asks++]!, (lines) => written.push(lines), noPause);
  assert.deepEqual(written, [['$HASP890 JOB(A)'], ['$HASP890 JOB(B)']]);
  assert.equal(asks, 5, 'one quiet ask is not the end; two in a row are');
});

test('a console that never goes quiet is asked a limited number of times', async () => {
  let asks = 0;
  await collectLate(async () => { asks++; return ['more']; }, () => {}, noPause);
  assert.equal(asks, 10);
});

test('a failed ask for later messages ends the collecting without failing the command', async () => {
  const written: string[][] = [];
  let asks = 0;
  await collectLate(async () => {
    asks++;
    if (asks === 2) throw Object.assign(new Error('Rest API failure with HTTP(S) status 404'), { errorCode: 404 });
    return ['late'];
  }, (lines) => written.push(lines), noPause);
  assert.equal(asks, 2);
  assert.deepEqual(written, [['late']]);
});
