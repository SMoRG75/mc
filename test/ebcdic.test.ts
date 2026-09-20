import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeEbcdic, ebcdicCodepages, ebcdicToText, isEbcdicCodepage, looksLikeText,
} from '../src/core/ebcdic';
import { UserFacingError } from '../src/core/errors';

const bytes = (...values: number[]) => Uint8Array.from(values);

/** 'HELLO' in EBCDIC. Letters sit at x'C1'..x'C9' and x'D1'.., not contiguously. */
const HELLO = bytes(0xc8, 0xc5, 0xd3, 0xd3, 0xd6);

test('every codepage builds a table of exactly 256 characters', () => {
  // A delta with a bad offset would quietly lengthen the table, and every byte
  // past the damage would then decode as the wrong character.
  for (const page of ebcdicCodepages()) {
    assert.equal(
      decodeEbcdic(Uint8Array.from({ length: 256 }, (_, i) => i), page).length,
      256,
      `${page} does not map 256 bytes to 256 characters`,
    );
  }
});

test('the invariant character set is the same in every codepage', () => {
  // A-Z, a-z and 0-9 are the part of EBCDIC that national pages may not move.
  // If a delta ever lands on one of them, source read on the wrong page would
  // come back subtly wrong rather than obviously wrong.
  const invariant = [
    ...range(0xc1, 0xc9), ...range(0xd1, 0xd9), ...range(0xe2, 0xe9), // A-Z
    ...range(0x81, 0x89), ...range(0x91, 0x99), ...range(0xa2, 0xa9), // a-z
    ...range(0xf0, 0xf9), // 0-9
    0x40, // space
  ];
  const reference = decodeEbcdic(Uint8Array.from(invariant), 'IBM-037');
  assert.equal(reference, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ');
  for (const page of ebcdicCodepages()) {
    assert.equal(decodeEbcdic(Uint8Array.from(invariant), page), reference, `${page} moves a letter or digit`);
  }
});

test('decodes the letters that national pages disagree about', () => {
  // x'5B' is the dollar sign on IBM-037 and Å on the Danish page: the same
  // bytes, a different reading. This is the whole reason the codepage is part
  // of the question rather than a default.
  assert.equal(decodeEbcdic(bytes(0x5b), 'IBM-037'), '$');
  assert.equal(decodeEbcdic(bytes(0x5b), 'IBM-277'), 'Å');
  assert.equal(decodeEbcdic(bytes(0x7b, 0x7c, 0xc0, 0xd0), 'IBM-277'), 'ÆØæå');
  assert.equal(decodeEbcdic(bytes(0x7b, 0x7c, 0xc0, 0xd0), 'IBM-037'), '#@{}');
  // IBM-1142 is IBM-277 with the euro put where the currency sign was;
  // everything else about the page must still match.
  assert.equal(decodeEbcdic(bytes(0x5a), 'IBM-277'), '¤');
  assert.equal(decodeEbcdic(bytes(0x5a), 'IBM-1142'), '€');
  assert.equal(decodeEbcdic(bytes(0x7b, 0x7c, 0xc0, 0xd0), 'IBM-1142'), 'ÆØæå');
});

test('codepage names are matched case-insensitively and trimmed', () => {
  assert.ok(isEbcdicCodepage('ibm-277'));
  assert.ok(isEbcdicCodepage('IBM-037'));
  assert.ok(!isEbcdicCodepage('UTF-8'));
  assert.equal(decodeEbcdic(HELLO, ' ibm-277 '), 'HELLO');
});

test('an unknown codepage is refused with a readable error', () => {
  assert.throws(() => decodeEbcdic(HELLO, 'ISO8859-1'), (err: unknown) => {
    assert.ok(err instanceof UserFacingError);
    assert.match(err.message, /not an EBCDIC codepage/);
    return true;
  });
});

test('looksLikeText tells ASCII from EBCDIC', () => {
  const ascii = new TextEncoder().encode('Licensed Materials - Property of IBM');
  assert.ok(looksLikeText(ascii));
  // The same sentence in EBCDIC is mostly high bytes, so it is not text.
  const ebcdic = Uint8Array.from(
    'Licensed Materials - Property of IBM',
    (ch) => toEbcdic037(ch),
  );
  assert.ok(!looksLikeText(ebcdic));
  // Too short to judge: guessing on a handful of bytes is worse than not.
  assert.ok(!looksLikeText(new TextEncoder().encode('short')));
});

test('ebcdicToText splits on x\'15\' when the bytes carry it', () => {
  const data = bytes(0xc8, 0xc5, 0xd3, 0xd3, 0xd6, 0x15, 0xc2, 0xd6, 0xd7, 0xc5, 0x15);
  assert.equal(ebcdicToText(data, 'IBM-037', 80), 'HELLO\nBOPE');
});

test('ebcdicToText falls back to the record length, and trims the padding', () => {
  // A dataset pulled down in binary has no separator at all: the LRECL is the
  // separator. Trailing blanks are padding, not content.
  const record = (text: string, width: number) => text.padEnd(width, ' ');
  const data = Uint8Array.from(
    [...record('HI', 4), ...record('YO', 4)].map(toEbcdic037),
  );
  assert.equal(ebcdicToText(data, 'IBM-037', 4), 'HI\nYO');
  // The wrong record length is visible as wrongly broken lines, not as loss.
  assert.equal(ebcdicToText(data, 'IBM-037', 8), 'HI  YO');
});

test('ebcdicToText refuses bytes that are already text', () => {
  const ascii = new TextEncoder().encode('# z/OSMF properties file, stored as it reads');
  assert.throws(() => ebcdicToText(ascii, 'IBM-037', 80), UserFacingError);
});

test('control characters are shown as dots, but a tab is left alone', () => {
  // Printed raw, a control character would rearrange the record on screen, so
  // ISPF browse shows them as dots and so does this. Tab is the exception the
  // regex carves out: it is how real source is indented, and a column of dots
  // where the indentation was is not an improvement.
  assert.equal(ebcdicToText(bytes(0xc8, 0x06, 0xc9, 0x15), 'IBM-037', 80), 'H.I');
  assert.equal(ebcdicToText(bytes(0xc8, 0x05, 0xc9, 0x15), 'IBM-037', 80), 'H	I');
});

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** The inverse of the IBM-037 table, for building fixtures. */
function toEbcdic037(ch: string): number {
  const all = decodeEbcdic(Uint8Array.from({ length: 256 }, (_, i) => i), 'IBM-037');
  const at = all.indexOf(ch);
  assert.notEqual(at, -1, `${ch} is not in IBM-037`);
  return at;
}
