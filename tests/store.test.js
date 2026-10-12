import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DocManager, sanitizeDocId } from '../src/server/store.js';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hardsite-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeManager() {
  return new DocManager({ dataDir: dir, saveDebounceMs: -1 }); // no timers in tests
}

describe('sanitizeDocId', () => {
  it('allows safe ids', () => {
    assert.equal(sanitizeDocId('my-doc_1'), 'my-doc_1');
  });
  it('rejects traversal and blanks', () => {
    assert.equal(sanitizeDocId('../etc'), 'default');
    assert.equal(sanitizeDocId(''), 'default');
    assert.equal(sanitizeDocId('a/b'), 'default');
    assert.equal(sanitizeDocId(null), 'default');
  });
});

describe('DocManager versioning & broadcast', () => {
  it('assigns increasing versions per op', () => {
    const m = makeManager();
    const r1 = m.applySet('d1', 'u1', 'A1', 5);
    const r2 = m.applySet('d1', 'u1', 'A2', 6);
    assert.equal(r1.version, 1);
    assert.equal(r2.version, 2);
  });
  it('broadcast changes include recomputed dependents', () => {
    const m = makeManager();
    m.applySet('d1', 'u1', 'A1', 2);
    m.applySet('d1', 'u1', 'B1', '=A1*3');
    const r = m.applySet('d1', 'u1', 'A1', 5);
    assert.equal(r.changes['A1'].value, 5);
    assert.equal(r.changes['B1'].value, 15);
  });
  it('docs are isolated', () => {
    const m = makeManager();
    m.applySet('d1', 'u1', 'A1', 1);
    m.applySet('d2', 'u1', 'A1', 2);
    assert.equal(m.getSnapshot('d1').cells['A1'].value, 1);
    assert.equal(m.getSnapshot('d2').cells['A1'].value, 2);
  });
  it('clearing a cell broadcasts removal', () => {
    const m = makeManager();
    m.applySet('d1', 'u1', 'A1', 9);
    const r = m.applySet('d1', 'u1', 'A1', null);
    assert.equal(r.changes['A1'].raw, null);
    assert.ok(!('A1' in m.getSnapshot('d1').cells));
  });
  it('invalid ref throws', () => {
    const m = makeManager();
    assert.throws(() => m.applySet('d1', 'u1', 'nope!!', 1));
  });
});

describe('DocManager undo/redo', () => {
  it('undo restores previous raw and broadcasts dependents', () => {
    const m = makeManager();
    m.applySet('d1', 'u1', 'A1', 1);
    m.applySet('d1', 'u1', 'B1', '=A1+10');
    m.applySet('d1', 'u1', 'A1', 2);
    assert.equal(m.getSnapshot('d1').cells['B1'].value, 12);
    const u = m.undo('d1', 'u1');
    assert.ok(u);
    assert.equal(u.changes['A1'].value, 1);
    assert.equal(u.changes['B1'].value, 11);
    assert.equal(u.version, 4);
  });
  it('redo re-applies', () => {
    const m = makeManager();
    m.applySet('d1', 'u1', 'A1', 1);
    m.applySet('d1', 'u1', 'A1', 2);
    m.undo('d1', 'u1');
    const r = m.redo('d1', 'u1');
    assert.ok(r);
    assert.equal(m.getSnapshot('d1').cells['A1'].value, 2);
  });
  it('new edit clears redo stack', () => {
    const m = makeManager();
    m.applySet('d1', 'u1', 'A1', 1);
    m.applySet('d1', 'u1', 'A1', 2);
    m.undo('d1', 'u1');
    m.applySet('d1', 'u1', 'A1', 3);
    assert.equal(m.redo('d1', 'u1'), null);
    assert.equal(m.getSnapshot('d1').cells['A1'].value, 3);
  });
  it('undo with empty stack returns null', () => {
    const m = makeManager();
    assert.equal(m.undo('d1', 'u1'), null);
    assert.equal(m.redo('d1', 'u1'), null);
  });
  it('undo is per-user', () => {
    const m = makeManager();
    m.applySet('d1', 'alice', 'A1', 1);
    m.applySet('d1', 'bob', 'A1', 2);
    m.undo('d1', 'alice'); // alice undoes her own op: sets A1 back to null
    assert.equal(m.getSnapshot('d1').cells['A1'], undefined);
  });
});

describe('DocManager persistence', () => {
  it('saveNow writes JSON and loadAll restores', () => {
    const m = makeManager();
    m.applySet('budget', 'u1', 'A1', 10);
    m.applySet('budget', 'u1', 'B1', '=A1*2');
    m.saveNow('budget');
    const file = path.join(dir, 'budget.json');
    assert.ok(fs.existsSync(file));
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.cells['A1'], 10);
    assert.equal(saved.cells['B1'], '=A1*2');

    const m2 = makeManager();
    m2.loadAll();
    const snap = m2.getSnapshot('budget');
    assert.equal(snap.cells['A1'].value, 10);
    assert.equal(snap.cells['B1'].value, 20);
    assert.equal(snap.version, saved.version);
  });
  it('loadAll skips corrupt files', () => {
    fs.writeFileSync(path.join(dir, 'bad.json'), 'not json{{');
    const m = makeManager();
    m.loadAll(); // should not throw
    assert.equal(m.getSnapshot('bad').version, 0);
  });
});
