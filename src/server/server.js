// Realtime spreadsheet server: static client + authoritative WebSocket sync.
// Plain node:http + ws. Run with `npm start` (PORT env, default 3000).
//
// Exported `createServer()` boots an instance on a chosen port/data dir;
// tests use it to spin up a real server on port 0 (random).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { DocManager, sanitizeDocId } from './store.js';
import { isCellRef, normalizeCellRef } from '../engine/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../../public');

const COLORS = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231',
  '#911eb4', '#0e9e9e', '#d62728', '#7b7b00',
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function createServer({ port = 3000, dataDir, saveDebounceMs } = {}) {
  const manager = new DocManager({
    dataDir: dataDir || path.resolve(process.cwd(), 'data'),
    ...(saveDebounceMs !== undefined ? { saveDebounceMs } : {}),
  });
  manager.loadAll();

  // docId -> Map(ws -> user)
  const docClients = new Map();
  let nextUserNum = 1;

  function clientsOf(docId) {
    let m = docClients.get(docId);
    if (!m) {
      m = new Map();
      docClients.set(docId, m);
    }
    return m;
  }

  function presenceList(docId) {
    return [...clientsOf(docId).values()].map((u) => ({
      id: u.id, name: u.name, color: u.color, sel: u.sel,
    }));
  }

  function broadcastPresence(docId) {
    const msg = JSON.stringify({ type: 'presence', users: presenceList(docId) });
    for (const ws of clientsOf(docId).keys()) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  function broadcastUpdate(docId, update, exceptWs = null) {
    const msg = JSON.stringify({ type: 'update', ...update });
    for (const ws of clientsOf(docId).keys()) {
      if (ws === exceptWs) continue;
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  function pickName(requested, docId) {
    const taken = new Set([...clientsOf(docId).values()].map((u) => u.name.toLowerCase()));
    let base = (requested || '').trim().slice(0, 20) || `User-${nextUserNum}`;
    let name = base;
    let i = 2;
    while (taken.has(name.toLowerCase())) {
      name = `${base} ${i++}`;
    }
    return name;
  }

  function serveStatic(req, res) {
    let urlPath = '/index.html';
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400); res.end('bad request'); return;
    }
    if (urlPath === '/') urlPath = '/index.html';
    const safe = path.normalize(urlPath).replace(/^\.\.(\\|\/)+/, '');
    const file = path.join(PUBLIC_DIR, safe);
    if (!file.startsWith(PUBLIC_DIR)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        // SPA fallback for unknown paths (but not for /ws)
        if (req.method === 'GET' && !path.extname(safe)) {
          fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
            if (e2) { res.writeHead(404); res.end('not found'); return; }
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(d2);
          });
          return;
        }
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  }

  function handleMessage(ws, user, docId, msg) {
    switch (msg.type) {
      case 'set': {
        const ref = String(msg.ref || '');
        if (!isCellRef(ref)) {
          ws.send(JSON.stringify({ type: 'error', message: `invalid cell ${ref}` }));
          return;
        }
        const { version, changes } = manager.applySet(docId, user.id, normalizeCellRef(ref), msg.raw ?? null);
        broadcastUpdate(docId, { version, changes, by: user.id, op: 'set', ref: normalizeCellRef(ref) });
        return;
      }
      case 'undo': {
        const r = manager.undo(docId, user.id);
        if (!r) {
          ws.send(JSON.stringify({ type: 'noop', op: 'undo' }));
          return;
        }
        broadcastUpdate(docId, { version: r.version, changes: r.changes, by: user.id, op: 'undo', ref: r.ref });
        return;
      }
      case 'redo': {
        const r = manager.redo(docId, user.id);
        if (!r) {
          ws.send(JSON.stringify({ type: 'noop', op: 'redo' }));
          return;
        }
        broadcastUpdate(docId, { version: r.version, changes: r.changes, by: user.id, op: 'redo', ref: r.ref });
        return;
      }
      case 'select': {
        const ref = String(msg.ref || '');
        user.sel = isCellRef(ref) ? normalizeCellRef(ref) : null;
        broadcastPresence(docId);
        return;
      }
      case 'rename': {
        const name = String(msg.name || '').trim().slice(0, 20);
        if (name) {
          user.name = pickName(name, docId);
          ws.send(JSON.stringify({ type: 'you', you: { id: user.id, name: user.name, color: user.color } }));
          broadcastPresence(docId);
        }
        return;
      }
      case 'sync': {
        const snap = manager.getSnapshot(docId);
        ws.send(JSON.stringify({ type: 'init', doc: docId, version: snap.version, cells: snap.cells, users: presenceList(docId) }));
        return;
      }
      default:
        return;
    }
  }

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/ws')) {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('websocket only');
      return;
    }
    serveStatic(req, res);
  });

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    let params;
    try {
      params = new URL(req.url, 'http://x').searchParams;
    } catch {
      ws.close(1008, 'bad url');
      return;
    }
    const docId = sanitizeDocId(params.get('doc') || 'default');
    const userId = `u${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const clients = clientsOf(docId);
    const user = {
      id: userId,
      name: pickName(params.get('name') || '', docId),
      color: COLORS[(nextUserNum++) % COLORS.length],
      sel: 'A1',
      ws,
    };
    clients.set(ws, user);

    const snap = manager.getSnapshot(docId);
    ws.send(JSON.stringify({
      type: 'init',
      you: { id: user.id, name: user.name, color: user.color },
      doc: docId,
      version: snap.version,
      cells: snap.cells,
      users: presenceList(docId),
    }));
    broadcastPresence(docId);

    ws.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }
      try {
        handleMessage(ws, user, docId, msg);
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: e.message || 'error' }));
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      broadcastPresence(docId);
    });

    ws.on('error', () => {});
  });

  // Heartbeat to drop dead connections.
  const heartbeat = setInterval(() => {
    for (const clients of docClients.values()) {
      for (const [ws] of clients) {
        if (ws.readyState === 1) ws.ping();
      }
    }
  }, 30000);
  if (heartbeat.unref) heartbeat.unref();

  server.listen(port);

  return {
    server,
    wss,
    manager,
    port: () => server.address()?.port,
    close: () => new Promise((resolve) => {
      clearInterval(heartbeat);
      for (const c of wss.clients) c.terminate();
      wss.close(() => server.close(resolve));
    }),
  };
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const port = parseInt(process.env.PORT || '3000', 10);
  const s = createServer({ port });
  s.server.on('listening', () => {
    console.log(`hard-site listening on http://localhost:${s.port()}`);
  });
}
