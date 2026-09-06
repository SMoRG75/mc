import type { TransferOptions } from '../shared/protocol';
import { UserFacingError } from './errors';

/**
 * Decides text vs binary for `mode: 'auto'`. Getting this wrong is the classic
 * way to corrupt a transfer, so 'auto' only ever says "binary" for extensions
 * the user has listed — anything unrecognised is treated as text, which is
 * recoverable, rather than binary, which silently ruins EBCDIC conversion.
 */
export function isBinary(name: string, binaryExtensions: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return binaryExtensions.some((ext) => lower.endsWith(ext.toLowerCase()));
}

export function resolveMode(
  options: TransferOptions, name: string, binaryExtensions: readonly string[],
): 'text' | 'binary' {
  if (options.mode !== 'auto') return options.mode;
  return isBinary(name, binaryExtensions) ? 'binary' : 'text';
}

/**
 * Fits text into a fixed-record dataset.
 *
 * A 132-character line going into FB 80 is the single most common way to lose
 * data on upload, so the caller must choose deliberately: wrap onto the next
 * record, truncate, or refuse the whole transfer.
 */
export function fitToRecordLength(
  content: string, lrecl: number, longLines: TransferOptions['longLines'],
): string[] {
  const out: string[] = [];
  for (const [index, line] of content.replace(/\r\n?/g, '\n').split('\n').entries()) {
    if (line.length <= lrecl) {
      out.push(line);
      continue;
    }
    switch (longLines) {
      case 'truncate':
        out.push(line.slice(0, lrecl));
        break;
      case 'wrap':
        for (let at = 0; at < line.length; at += lrecl) out.push(line.slice(at, at + lrecl));
        break;
      case 'abort':
        throw new UserFacingError(
          `Line ${index + 1} is ${line.length} characters, but the destination has LRECL ${lrecl}.`,
          'Choose Wrap or Truncate in the transfer dialog, or allocate the dataset with a larger LRECL.',
        );
    }
  }
  // A trailing newline produces an empty final element; a dataset has no such record.
  if (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}
