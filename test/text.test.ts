import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitToRecordLength, isBinary, resolveMode } from '../src/core/text';
import { UserFacingError } from '../src/core/errors';
import type { TransferOptions } from '../src/shared/protocol';

const options = (over: Partial<TransferOptions> = {}): TransferOptions => ({
  mode: 'auto', codepage: 'IBM-037', longLines: 'abort', onConflict: 'ask', destination: '*',
  ...over,
});

test('lines that fit are passed through untouched', () => {
  assert.deepEqual(fitToRecordLength('ABC\nDEF', 80, 'abort'), ['ABC', 'DEF']);
  // Exactly LRECL is a fit, not an overflow.
  assert.deepEqual(fitToRecordLength('A'.repeat(80), 80, 'abort'), ['A'.repeat(80)]);
});

test('a trailing newline does not become an empty record', () => {
  // A text file ends with a newline; a dataset has no such record, and an
  // empty last line is a real difference once it is on the host.
  assert.deepEqual(fitToRecordLength('ABC\n', 80, 'abort'), ['ABC']);
  assert.deepEqual(fitToRecordLength('', 80, 'abort'), []);
  // Only the last one: a blank line in the middle is content.
  assert.deepEqual(fitToRecordLength('A\n\nB\n', 80, 'abort'), ['A', '', 'B']);
});

test('CRLF and lone CR are normalised', () => {
  assert.deepEqual(fitToRecordLength('A\r\nB\rC\n', 80, 'abort'), ['A', 'B', 'C']);
});

test('abort refuses the transfer and names the line', () => {
  // The default, and the point of it: a 132-character line going into FB 80 is
  // the classic way to lose data, so nothing happens until the user chooses.
  assert.throws(() => fitToRecordLength(`ok\n${'X'.repeat(132)}`, 80, 'abort'), (err: unknown) => {
    assert.ok(err instanceof UserFacingError);
    assert.match(err.message, /Line 2 is 132 characters/);
    assert.match(err.message, /LRECL 80/);
    return true;
  });
});

test('truncate cuts at the record length', () => {
  assert.deepEqual(fitToRecordLength('X'.repeat(100), 80, 'truncate'), ['X'.repeat(80)]);
});

test('wrap carries the overflow onto the next record', () => {
  assert.deepEqual(fitToRecordLength('ABCDEFG', 3, 'wrap'), ['ABC', 'DEF', 'G']);
  // An exact multiple must not produce a trailing empty record.
  assert.deepEqual(fitToRecordLength('ABCDEF', 3, 'wrap'), ['ABC', 'DEF']);
  // Wrapping is per line, so the lines around a long one keep their identity.
  assert.deepEqual(fitToRecordLength('AB\nCDEFG\nHI', 3, 'wrap'), ['AB', 'CDE', 'FG', 'HI']);
});

test('binary is only ever guessed from a listed extension', () => {
  const exts = ['.zip', '.PNG'];
  assert.ok(isBinary('archive.zip', exts));
  assert.ok(isBinary('ARCHIVE.ZIP', exts), 'the comparison is case-insensitive both ways');
  assert.ok(isBinary('logo.png', exts));
  assert.ok(!isBinary('readme.md', exts));
  assert.ok(!isBinary('NOEXTENSION', exts));
  assert.ok(!isBinary('zip', exts), 'the extension has to be a suffix, dot and all');
});

test('auto falls back to text, because text is the recoverable mistake', () => {
  const exts = ['.zip'];
  // Treating a binary as text is visible and fixable; treating text as binary
  // skips the EBCDIC conversion and ruins it silently.
  assert.equal(resolveMode(options(), 'unknown.xyz', exts), 'text');
  assert.equal(resolveMode(options(), 'archive.zip', exts), 'binary');
  // An explicit choice is never second-guessed by the extension list.
  assert.equal(resolveMode(options({ mode: 'text' }), 'archive.zip', exts), 'text');
  assert.equal(resolveMode(options({ mode: 'binary' }), 'readme.md', exts), 'binary');
});
