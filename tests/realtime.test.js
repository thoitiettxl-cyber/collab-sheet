// Integration tests: boot a real server on a random port and drive it with
// two WebSocket clients, covering the full client<->server protocol.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createServer } from '../src/server/server.js';

let dir;
let srv;
let port;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hardsite-int-'));
  srv = createServer({ port: 0, dataDir: dir, saveDebounceMs: 20 });
  await new Promise((res) => srv.server.once('listening', res));
  port = srv.port();
  assert.ok(port > 0, 'server picked a random port');
});

after(async () => {
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Buffered ws client: keeps every received message so waitFor can also match
// messages that arrived before the waiter was registered (no races).
function makeClient(qs) {
  const ws = new WebSocket(`ws://localhost:${port}/ws?${qs}`);
  const buf = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    buf.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) waiters.splice(i, 1)[0].res(m);
    }
  });
  return {
    open: new Promise((res, rej) => {
      ws.once('open', res);
      ws.once('error', rej);
    }),
    send: (o) => ws.send(JSON.stringify(o)),
    waitFor: (pred, timeout = 5000) => {
      const hit = buf.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('timeout waiting for message')), timeout);
        waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); } });
      });
    },
    close: () => ws.close(),
  };
}

async function twoClients(doc) {
  const a = makeClient(`doc=${doc}&name=Alice`);
  const b = makeClient(`doc=${doc}&name=Bob`);
  await Promise.all([a.open, b.open]);
  const initA = await a.waitFor((m) => m.type === 'init');
  const initB = await b.waitFor((m) => m.type === 'init');
  assert.equal(initA.you.name, 'Alice');
  assert.equal(initB.you.name, 'Bob');
  return { a, b };
}

const isUpdate = (op, ref) => (m) => m.type === 'update' && m.op === op && (!ref || m.ref === ref);

describe('integration: edit sync', () => {
  it('a remote edit is broadcast to the other client', async () => {
    const { a, b } = await twoClients('sync1');
    try {
      a.send({ type: 'set', ref: 'A1', raw: 'hello' });
      const u = await b.waitFor(isUpdate('set', 'A1'));
      assert.equal(u.changes['A1'].raw, 'hello');
      assert.equal(u.changes['A1'].value, 'hello');
      assert.equal(u.version, 1);
    } finally {
      a.close(); b.close();
    }
  });
});

describe('integration: formula recompute', () => {
  it('dependents recompute for the other client after a remote edit', async () => {
    const { a, b } = await twoClients('formula1');
    try {
      a.send({ type: 'set', ref: 'A1', raw: '3' });
      a.send({ type: 'set', ref: 'B1', raw: '=A1*2' });
      const u1 = await b.waitFor(isUpdate('set', 'B1'));
      assert.equal(u1.changes['B1'].value, 6);
      // Remote edit from the other client -> dependent must recompute.
      b.send({ type: 'set', ref: 'A1', raw: '10' });
      const u2 = await a.waitFor((m) => isUpdate('set', 'A1')(m) && m.changes['B1']);
      assert.equal(u2.changes['A1'].value, 10);
      assert.equal(u2.changes['B1'].value, 20);
    } finally {
      a.close(); b.close();
    }
  });
});

describe('integration: cycles', () => {
  it('a dependency cycle surfaces as #CYCLE! on the wire', async () => {
    const { a, b } = await twoClients('cycle1');
    try {
      a.send({ type: 'set', ref: 'A1', raw: '=B1' });
      await b.waitFor(isUpdate('set', 'A1'));
      a.send({ type: 'set', ref: 'B1', raw: '=A1' });
      const u = await b.waitFor(isUpdate('set', 'B1'));
      assert.equal(u.changes['B1'].error, '#CYCLE!');
      assert.equal(u.changes['A1'].error, '#CYCLE!');
    } finally {
      a.close(); b.close();
    }
  });
});

describe('integration: undo/redo', () => {
  it('undo and redo are broadcast to other clients', async () => {
    const { a, b } = await twoClients('undoredo1');
    try {
      a.send({ type: 'set', ref: 'A1', raw: '1' });
      await b.waitFor(isUpdate('set', 'A1'));

      a.send({ type: 'undo' });
      const u = await b.waitFor(isUpdate('undo'));
      assert.equal(u.changes['A1'].raw, null);
      assert.equal(u.ref, 'A1');

      a.send({ type: 'redo' });
      const r = await b.waitFor(isUpdate('redo'));
      assert.equal(r.changes['A1'].value, 1);
      assert.equal(r.ref, 'A1');
    } finally {
      a.close(); b.close();
    }
  });
});

describe('integration: persistence across restart', () => {
  it('cells survive a server restart from the same data dir', async () => {
    const doc = 'persist1';
    const { a, b } = await twoClients(doc);
    try {
      a.send({ type: 'set', ref: 'A1', raw: '42' });
      a.send({ type: 'set', ref: 'B1', raw: '=A1+8' });
      await b.waitFor(isUpdate('set', 'B1'));
    } finally {
      a.close(); b.close();
    }
    // Wait for the debounced save to hit disk, then restart the server.
    await new Promise((r) => setTimeout(r, 300));
    await srv.close();
    srv = createServer({ port: 0, dataDir: dir, saveDebounceMs: 20 });
    await new Promise((res) => srv.server.once('listening', res));
    port = srv.port();

    const c = makeClient(`doc=${doc}&name=Carol`);
    try {
      await c.open;
      const init = await c.waitFor((m) => m.type === 'init');
      assert.equal(init.cells['A1'].value, 42);
      assert.equal(init.cells['B1'].raw, '=A1+8');
      assert.equal(init.cells['B1'].value, 50);
    } finally {
      c.close();
    }
  });
});
