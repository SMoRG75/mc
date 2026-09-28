import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Entry } from '../src/core/provider';
import { DsProvider } from '../src/providers/dsProvider';
import type { SessionManager } from '../src/zowe/sessions';

// describe() reads only the listing's own attributes, so neither a session nor
// the settings are ever touched.
const ds = new DsProvider({} as SessionManager, {
  pageSize: () => 1000, binaryExtensions: () => [], defaultFilter: () => '',
});
const loc = { kind: 'ds' as const, profile: 'LPAR1', path: 'USER.*' };

function pds(attributes: Record<string, string | undefined>): Entry {
  return {
    dto: { id: 'USER.SRC', name: 'USER.SRC', kind: 'dir', cells: {} },
    ref: { kind: 'dataset', dsname: 'USER.SRC', migrated: false, ...attributes },
  };
}

test('a PDS/E is copied as a PDS/E with its record shape and its space', () => {
  const item = ds.describe(loc, pds({
    dsorg: 'PO-E', recfm: 'VB', lrecl: '255', blksz: '27998', spacu: 'TRACKS', sizex: '45',
  }));
  assert.deepEqual(item.dataset, {
    type: 'pdse', recfm: 'VB', lrecl: 255, blksize: 27998,
    alcunit: 'TRK', primary: 45, secondary: 12,
  });
});

test('an old-style PDS stays one, measured in cylinders if it was', () => {
  const item = ds.describe(loc, pds({
    dsorg: 'PO', recfm: 'FB', lrecl: '80', blksz: '27920', spacu: 'CYLINDERS', sizex: '3',
  }));
  assert.equal(item.dataset?.type, 'pds');
  assert.equal(item.dataset?.alcunit, 'CYL');
  assert.equal(item.dataset?.primary, 3);
  assert.equal(item.dataset?.secondary, 1);
});

test('a size in blocks is not guessed at', () => {
  const item = ds.describe(loc, pds({ dsorg: 'PO', recfm: 'FB', lrecl: '80', spacu: 'BLOCKS', sizex: '500' }));
  assert.equal(item.dataset?.alcunit, 'TRK');
  assert.equal(item.dataset?.primary, 10);
});

test('without attributes there is no shape to copy, rather than a made-up one', () => {
  // The listing falls back to names only when z/OSMF cannot give attributes;
  // a copy allocated as FB 80 from that would fit VB 255 text into the wrong
  // records.
  assert.equal(ds.describe(loc, pds({ dsorg: 'PO' })).dataset, undefined);
});

test('a member or a sequential data set carries no shape', () => {
  assert.equal(ds.describe(loc, pds({ dsorg: 'PS', recfm: 'FB', lrecl: '80' })).dataset, undefined);
  const member: Entry = {
    dto: { id: 'USER.SRC(A)', name: 'A', kind: 'file', cells: {} },
    ref: { kind: 'member', dsname: 'USER.SRC', member: 'A', lrecl: '80' },
  };
  assert.equal(ds.describe({ ...loc, path: 'USER.SRC' }, member).dataset, undefined);
});

test('inside a PDS, a name is compared as the member it becomes', () => {
  const inside = { ...loc, path: 'USER.SRC' };
  assert.equal(ds.nameKey(inside, 'hello.jcl'), 'HELLO');
  assert.equal(ds.nameKey(inside, 'my-long-name.txt'), 'MYLONGNA');
});
