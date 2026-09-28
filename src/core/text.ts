import { Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
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
  const fit = new RecordFit(lrecl, longLines);
  const records = fit.feed(content) + fit.end();
  // Every record ends in a newline, so the split leaves one empty string behind.
  return records ? records.slice(0, -1).split('\n') : [];
}

/**
 * `fitToRecordLength` for a stream: text in, one newline-terminated record per
 * line out, without ever holding more than a record of it.
 *
 * Nothing reaches the output past a line that `abort` refuses — but everything
 * before it already has, so a caller that must not write half a dataset has to
 * let this run to the end before sending anything on.
 */
export class RecordFitter extends Transform {
  private readonly decoder = new StringDecoder('utf8');
  private readonly fit: RecordFit;

  constructor(lrecl: number, longLines: TransferOptions['longLines']) {
    super();
    this.fit = new RecordFit(lrecl, longLines);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    try {
      const out = this.fit.feed(this.decoder.write(chunk));
      done(null, out || undefined);
    } catch (err) {
      done(err as Error);
    }
  }

  override _flush(done: TransformCallback): void {
    try {
      const out = this.fit.feed(this.decoder.end()) + this.fit.end();
      done(null, out || undefined);
    } catch (err) {
      done(err as Error);
    }
  }
}

/**
 * The line splitting and fitting shared by both of the above.
 *
 * Text arrives in pieces that may end anywhere — halfway through a line, or
 * between the CR and LF of one line break — and the output has to be the same
 * as if it had arrived whole. What is kept between pieces is bounded by the
 * record length, so a file with no line breaks at all cannot fill memory.
 */
class RecordFit {
  /** The current line, cut down to what can still become a record. */
  private line = '';
  /** Its real length, which is more than `line` holds once it has overflowed. */
  private length = 0;
  /** Characters seen since the last line break — an empty line is still a line. */
  private open = false;
  /** 1-based number of the current line, for the message `abort` gives. */
  private number = 1;
  /** The last piece ended in a CR, so an LF at the start of the next belongs to it. */
  private afterCr = false;

  constructor(
    private readonly lrecl: number,
    private readonly longLines: TransferOptions['longLines'],
  ) {}

  feed(text: string): string {
    let start = this.afterCr && text.startsWith('\n') ? 1 : 0;
    this.afterCr = false;
    let out = '';
    const breaks = /\r\n?|\n/g;
    breaks.lastIndex = start;
    for (let match = breaks.exec(text); match; match = breaks.exec(text)) {
      out += this.append(text.slice(start, match.index)) + this.close();
      start = match.index + match[0].length;
      if (match[0] === '\r' && start === text.length) this.afterCr = true;
    }
    return out + this.append(text.slice(start));
  }

  /** The last line, if the text did not end with a line break. */
  end(): string {
    return this.open ? this.close() : '';
  }

  private append(piece: string): string {
    if (!piece) return '';
    this.open = true;
    this.length += piece.length;
    if (this.longLines !== 'wrap') {
      // Past the record length, `truncate` throws the rest away and `abort`
      // only needs to know how long the line was.
      if (this.line.length < this.lrecl) this.line += piece.slice(0, this.lrecl - this.line.length);
      return '';
    }
    this.line += piece;
    let out = '';
    // Strictly longer: a line of exactly the record length stays whole until
    // it ends, so an exact multiple does not leave an empty record behind.
    while (this.line.length > this.lrecl) {
      out += `${this.line.slice(0, this.lrecl)}\n`;
      this.line = this.line.slice(this.lrecl);
    }
    return out;
  }

  private close(): string {
    if (this.length > this.lrecl && this.longLines === 'abort') {
      throw new UserFacingError(
        `Line ${this.number} is ${this.length} characters, but the destination has LRECL ${this.lrecl}.`,
        'Choose Wrap or Truncate in the transfer dialog, or allocate the dataset with a larger LRECL.',
      );
    }
    const record = `${this.line}\n`;
    this.line = '';
    this.length = 0;
    this.open = false;
    this.number += 1;
    return record;
  }
}
