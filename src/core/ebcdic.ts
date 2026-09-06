import { UserFacingError } from './errors';

/**
 * Local EBCDIC decoding, for Shift+F3.
 *
 * Everywhere else the conversion is z/OSMF's: the pane asks for a codepage and
 * gets UTF-8 back. That only works for content the host agrees is text. A load
 * module, a dataset read in binary, a spool dump saved to disk, or an EBCDIC
 * file that was FTP'd down in binary all arrive as raw bytes with no service
 * left to convert them — and those are exactly the files a person needs to look
 * at in EBCDIC.
 *
 * The tables are generated from ICU's `ibm-*_P100` mappings (charset/data/ucm
 * in unicode-org/icu-data), which are IBM's own CDRA data. IBM-037 is written
 * out in full and every other page as the bytes where it differs, because the
 * national pages move about a dozen characters each and listing 24 full tables
 * would hide that.
 */

const IBM_037 =
  '\u0000\u0001\u0002\u0003\u009c\u0009\u0086\u007f\u0097\u008d\u008e\u000b\u000c\u000d\u000e\u000f\u0010\u0011\u0012\u0013\u009d\u0085\u0008\u0087\u0018\u0019\u0092\u008f\u001c\u001d\u001e\u001f' +
  '\u0080\u0081\u0082\u0083\u0084\u000a\u0017\u001b\u0088\u0089\u008a\u008b\u008c\u0005\u0006\u0007\u0090\u0091\u0016\u0093\u0094\u0095\u0096\u0004\u0098\u0099\u009a\u009b\u0014\u0015\u009e\u001a' +
  ' \u00a0âäàáãåçñ¢.<(+|&éêëèíîïìß!$*);¬' +
  '-/ÂÄÀÁÃÅÇÑ¦,%_>?øÉÊËÈÍÎÏÌ`:#@\'="' +
  'Øabcdefghi«»ðýþ±°jklmnopqrªºæ¸Æ¤' +
  'µ~stuvwxyz¡¿ÐÝÞ®^£¥·©§¶¼½¾[]¯¨´×' +
  '{ABCDEFGHI\u00adôöòóõ}JKLMNOPQR¹ûüùúÿ' +
  '\\÷STUVWXYZ²ÔÖÒÓÕ0123456789³ÛÜÙÚ\u009f';

/** `<2 hex digits><character>` per byte that differs from IBM-037. */
const DELTAS: Record<string, string> = {
  'IBM-273': '43{4AÄ4F!59~5AÜ5F^63[6Aö7C§A1ßB0¢B5@BA¬BB|C0äCC¦D0üDC}E0ÖEC\\FC]',
  'IBM-277': '47}4A#4F!5A¤5BÅ5F^67$6Aø70¦7BÆ7CØ80@9C{9E[9F]A1üB0¢BA¬BB|C0æD0åDC~',
  'IBM-278': '43{47}4A§4F!51`5A¤5BÅ5F^63#67$6Aö71\\79é7BÄ7CÖ9F]A1üB0¢B5[BA¬BB|C0äCC¦D0åDC~E0ÉEC@',
  'IBM-280': '44{48\\4A°4F!51]54}58~5Aé5F^6Aò79ù7B£7C§90[A1ìB0¢B1#B5@BA¬BB|C0àCD¦D0èDD`E0ç',
  'IBM-284': '49¦4A[5A]69#6Añ7BÑA1¨B0¢BA^BB!BD~',
  'IBM-285': '4A$5B£A1¯B0¢B1[BA^BC~',
  'IBM-297': '44@48\\4A°4F!51{54}5A§5F^6Aù79µ7B£7Cà90[A0`A1¨B0¢B1#B5]BA¬BB|BD~C0éD0èDD¦E0ç',
  'IBM-500': '4A[4F!5A]5F^B0¢BA¬BB|',
  'IBM-870': '44ţ46ă47č49ć4A[4F!52ę54ů57ľ58ĺ5A]5F^64˝66Ă67Č69Ć6A|70ˇ72Ę74Ů77Ľ78Ĺ80˘8Aś8Bň8Cđ8Eř8Fş9Ał9Bń9Cš9E˛A0ąAAŚABŇACĐAEŘAFŞB0˙B1ĄB2żB3ŢB4ŻB6žB7źB8ŽB9ŹBAŁBBŃBCŠCDŕCFőDAĚDBűDDťDFěEAďEDŔEFŐFAĎFBŰFDŤ',
  'IBM-871': '4AÞ4F!5AÆ5FÖ79ð7CÐ8C`8E{9C}9E]A1öAC@AE[B0¢BA¬BB|BE\\C0þCC~D0æE0´EC^',
  'IBM-1025': '42ђ43ѓ44ё45є46ѕ47і48ї49ј4A[4F!51љ52њ53ћ54ќ55ў56џ57Ъ58№59Ђ5A]5F^62Ѓ63Ё64Є65Ѕ66І67Ї68Ј69Љ6A|70Њ71Ћ72Ќ73\u00ad74Ў75Џ76ю77а78б80ц8Aд8Bе8Cф8Dг8Eх8Fи90й9Aк9Bл9Cм9Dн9Eо9FпA0яAAрABсACтADуAEжAFвB0ьB1ыB2зB3шB4эB5щB6чB7ъB8ЮB9АBAБBBЦBCДBDЕBEФBFГCAХCBИCCЙCDКCEЛCFМDAНDBОDCПDDЯDEРDFСE1§EAТEBУECЖEDВEEЬEFЫFAЗFBШFCЭFDЩFEЧ',
  'IBM-1026': '48{4AÇ4F!5AĞ5Bİ5F^68[6Aş79ı7BÖ7CŞ7FÜ8C}8D`8E¦9A₺A1öAC]AD$AE@B0¢BA¬BB|C0çCC~D0ğDC\\E0üEC#FC"',
  'IBM-1047': '5F^AD[B0¬BAÝBB¨BD]',
  'IBM-1140': '9F€',
  'IBM-1141': '43{4AÄ4F!59~5AÜ5F^63[6Aö7C§9F€A1ßB0¢B5@BA¬BB|C0äCC¦D0üDC}E0ÖEC\\FC]',
  'IBM-1142': '47}4A#4F!5A€5BÅ5F^67$6Aø70¦7BÆ7CØ80@9C{9E[9F]A1üB0¢BA¬BB|C0æD0åDC~',
  'IBM-1143': '43{47}4A§4F!51`5A€5BÅ5F^63#67$6Aö71\\79é7BÄ7CÖ9F]A1üB0¢B5[BA¬BB|C0äCC¦D0åDC~E0ÉEC@',
  'IBM-1144': '44{48\\4A°4F!51]54}58~5Aé5F^6Aò79ù7B£7C§90[9F€A1ìB0¢B1#B5@BA¬BB|C0àCD¦D0èDD`E0ç',
  'IBM-1145': '49¦4A[5A]69#6Añ7BÑ9F€A1¨B0¢BA^BB!BD~',
  'IBM-1146': '4A$5B£9F€A1¯B0¢B1[BA^BC~',
  'IBM-1147': '44@48\\4A°4F!51{54}5A§5F^6Aù79µ7B£7Cà90[9F€A0`A1¨B0¢B1#B5]BA¬BB|BD~C0éD0èDD¦E0ç',
  'IBM-1148': '4A[4F!5A]5F^9F€B0¢BA¬BB|',
  'IBM-1149': '4AÞ4F!5AÆ5FÖ79ð7CÐ8C`8E{9C}9E]9F€A1öAC@AE[B0¢BA¬BB|BE\\C0þCC~D0æE0´EC^',
};

/** EBCDIC's own end-of-record bytes: NL and LF. */
const NL = 0x15;
const LF = 0x25;
const CR = 0x0d;

const tables = new Map<string, string>();

/** The pages Shift+F3 can decode, in the order the settings list them. */
export function ebcdicCodepages(): string[] {
  return ['IBM-037', ...Object.keys(DELTAS)];
}

export function isEbcdicCodepage(codepage: string): boolean {
  return codepage.toUpperCase() === 'IBM-037' || DELTAS[codepage.toUpperCase()] !== undefined;
}

/** One byte to one character, with no interpretation of what the character means. */
function tableFor(codepage: string): string {
  const name = codepage.trim().toUpperCase();
  const cached = tables.get(name);
  if (cached) return cached;

  if (name === 'IBM-037') {
    tables.set(name, IBM_037);
    return IBM_037;
  }
  const delta = DELTAS[name];
  if (delta === undefined) {
    throw new UserFacingError(
      `${codepage} is not an EBCDIC codepage this view can decode.`,
      'Shift+F3 converts the bytes itself, so it needs a single-byte EBCDIC page. '
      + `Set 'mc.view.ebcdicCodepage' to one of: ${ebcdicCodepages().join(', ')}.`,
    );
  }
  const chars = [...IBM_037];
  for (let at = 0; at < delta.length; at += 3) {
    chars[parseInt(delta.slice(at, at + 2), 16)] = delta[at + 2]!;
  }
  const table = chars.join('');
  tables.set(name, table);
  return table;
}

/**
 * Whether these bytes are already text, and so have no EBCDIC left in them.
 *
 * Worth a check because the failure is silent otherwise: ASCII decoded as
 * EBCDIC comes out as page after page of accented letters that look for all the
 * world like a wrong codepage rather than like the wrong question. 'Licensed
 * Materials' arrives as '<ÑÄÁ>ËÁÀ (/ÈÁÊÑ/%Ë', and nothing on screen says the
 * bytes were never EBCDIC to begin with.
 *
 * The tell is the letters. EBCDIC puts them at x'81' and above, so any real
 * EBCDIC text is mostly high bytes; text that is instead a fifth ASCII letters
 * with nothing above x'7F' is ASCII, whatever it was expected to be. USS files
 * are the usual case — a file tagged ISO8859-1 or UTF-8 is stored as it reads,
 * and z/OSMF's own `.properties` files are exactly that.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  let high = 0;
  let letters = 0;
  for (const byte of bytes) {
    if (byte >= 0x80) high += 1;
    else if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)) letters += 1;
  }
  return high / bytes.length < 0.05 && letters / bytes.length > 0.2;
}

export function decodeEbcdic(bytes: Uint8Array, codepage: string): string {
  const table = tableFor(codepage);
  let out = '';
  for (const byte of bytes) out += table[byte];
  return out;
}

/**
 * Raw EBCDIC bytes as the text a person can read.
 *
 * Records come out one per line, which is the only part that needs a decision:
 * a USS file or anything that went through a text-mode download separates its
 * records with x'15', while a dataset pulled down in binary has no separator at
 * all — the record length is the separator. So the bytes are asked first, and
 * `recordLength` only decides the case where they say nothing.
 *
 * Trailing blanks are cut from fixed-length records because they are padding,
 * not content; a record that ends with x'15' keeps whatever it has.
 */
export function ebcdicToText(
  bytes: Uint8Array, codepage: string, recordLength: number,
): string {
  const table = tableFor(codepage);
  if (looksLikeText(bytes)) {
    throw new UserFacingError(
      'These bytes are not EBCDIC — they are already text.',
      'Nothing here is above x\'7F\' and a fifth of it is ASCII letters, so there is '
      + `no EBCDIC left to decode; reading it as ${codepage} would only produce `
      + 'convincing-looking nonsense.\n\n'
      + 'F3 shows this file correctly. A USS file tagged ISO8859-1 or UTF-8 is stored '
      + "the way it reads — z/OSMF's own .properties files are — and F3 follows the tag.\n\n"
      + 'Shift+F3 is for content no service will convert: a load module, a data set read '
      + 'in binary, or an EBCDIC file that came down to the PC untranslated.',
    );
  }
  const separated = bytes.some((byte) => byte === NL || byte === LF);
  const records: string[] = [];

  if (separated) {
    let record = '';
    for (const byte of bytes) {
      if (byte === NL || byte === LF) {
        records.push(record);
        record = '';
      } else if (byte !== CR) {
        record += table[byte];
      }
    }
    if (record !== '') records.push(record);
  } else {
    const width = recordLength > 0 ? recordLength : 80;
    for (let at = 0; at < bytes.length; at += width) {
      records.push(decodeEbcdic(bytes.subarray(at, at + width), codepage).replace(/ +$/, ''));
    }
  }

  return records.map(printable).join('\n');
}

/**
 * Control characters have no glyph and a few of them move the cursor, which
 * would rearrange the record on screen. ISPF browse shows them as dots and so
 * does this.
 */
function printable(record: string): string {
  // eslint-disable-next-line no-control-regex
  return record.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g, '.');
}
