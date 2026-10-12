// DocManager: authoritative per-document state for the realtime spreadsheet.
// Plain ESM, no socket dependency so it is unit-testable.
//
// - One Workbook per doc id (sanitized).
// - Per-op versioning: the server assigns a monotonically increasing sequence
//   number to every applied op; concurrent edits are ordered deterministically
//   by arrival order (Node is single-threaded).
// - Undo/redo per user, server-side, as inverse ops so they broadcast like
//   normal edits and stay in sync for everyone.
// - Persistence: each doc saved as JSON under data/ (debounced), reloaded on start.
import fs from 'node:fs';
import path from 'node:path';
import { Workbook, normalizeCellRef, isCellRef } from '../engine/index.js';

export function sanitizeDocId(id) {
  if (typeof id !== 'string') return 'default';
  const t = id.trim();
  if (/^[A-Za-z0-9_-]{1,64}$/.test(t)) return t;
  return 'default';
}

export function normalizeRaw(raw) {
  if (raw === '' || raw === undefined) return null;
  return raw;
}

function snapshotCells(workbook) {
  return workbook.getAllCells();
}

// Diff two getAllCells() snapshots -> { ref: { raw, value, error } } for changes.
function diffCells(before, after) {
  const changes = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const ref of keys) {
    const b = before[ref];
    const a = after[ref];
    const bRaw = b ? b.raw : null;
    const aRaw = a ? a.raw : null;
    const bVal = b ? b.value : null;
    const aVal = a ? a.value : null;
    const bErr = b ? b.error : null;
    const aErr = a ? a.error : null;
    if (!Object.is(bRaw, aRaw) || !Object.is(bVal, aVal) || !Object.is(bErr, aErr)) {
      // Only broadcast cells that exist (have raw) or that changed from existing.
      // Placeholder dep cells (raw null) that never had content are skipped
      // unless they previously had content (cleared).
      if (aRaw !== null && aRaw !== undefined && aRaw !== '') {
        changes[ref] = { raw: aRaw, value: aVal, error: aErr };
      } else if (bRaw !== null && bRaw !== undefined && bRaw !== '') {
        changes[ref] = { raw: null, value: null, error: null };
      }
    }
  }
  return changes;
}

export class DocManager {
  constructor({ dataDir = 'data', saveDebounceMs = 1000 } = {}) {
    this.dataDir = dataDir;
    this.saveDebounceMs = saveDebounceMs;
    this.docs = new Map(); // docId -> doc
  }

  _docPath(docId) {
    return path.join(this.dataDir, `${docId}.json`);
  }

  getDoc(docId) {
    const id = sanitizeDocId(docId);
    let doc = this.docs.get(id);
    if (!doc) {
      doc = {
        id,
        workbook: new Workbook(),
        version: 0,
        history: new Map(), // userId -> { undo: [], redo: [] }
        saveTimer: null,
      };
      this.docs.set(id, doc);
    }
    return doc;
  }

  _hist(doc, userId) {
    let h = doc.history.get(userId);
    if (!h) {
      h = { undo: [], redo: [] };
      doc.history.set(userId, h);
    }
    return h;
  }

  // Load all persisted docs from dataDir. Call once at server start.
  loadAll() {
    let files = [];
    try {
      files = fs.readdirSync(this.dataDir).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }
    for (const f of files) {
      const docId = sanitizeDocId(path.basename(f, '.json'));
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.dataDir, f), 'utf8'));
        if (!data || typeof data.cells !== 'object') continue;
        const doc = this.getDoc(docId);
        for (const [ref, raw] of Object.entries(data.cells)) {
          if (!isCellRef(ref)) continue;
          try {
            doc.workbook.setCell(normalizeCellRef(ref), raw);
          } catch {
            /* skip bad cells */
          }
        }
        if (typeof data.version === 'number') doc.version = data.version;
      } catch {
        /* skip corrupt files */
      }
    }
  }

  _scheduleSave(doc) {
    if (this.saveDebounceMs < 0) return; // disabled (tests can use saveNow)
    if (doc.saveTimer) clearTimeout(doc.saveTimer);
    doc.saveTimer = setTimeout(() => {
      doc.saveTimer = null;
      this.saveNow(doc.id);
    }, this.saveDebounceMs);
    if (doc.saveTimer.unref) doc.saveTimer.unref();
  }

  saveNow(docId) {
    const doc = this.docs.get(sanitizeDocId(docId));
    if (!doc) return;
    const cells = {};
    for (const [ref, c] of Object.entries(doc.workbook.getAllCells())) {
      if (c.raw !== null && c.raw !== undefined && c.raw !== '') cells[ref] = c.raw;
    }
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this._docPath(doc.id), JSON.stringify({ version: doc.version, cells }, null, 2));
    } catch {
      /* best effort */
    }
  }

  // Full state for a newly joined client.
  getSnapshot(docId) {
    const doc = this.getDoc(docId);
    const cells = {};
    for (const [ref, c] of Object.entries(doc.workbook.getAllCells())) {
      if (c.raw !== null && c.raw !== undefined && c.raw !== '') {
        cells[ref] = { raw: c.raw, value: c.value, error: c.error };
      }
    }
    return { version: doc.version, cells };
  }

  // Apply a user cell edit. Returns { version, changes } or throws on bad ref.
  applySet(docId, userId, ref, raw) {
    const doc = this.getDoc(docId);
    const norm = normalizeCellRef(ref); // throws on invalid
    const clean = normalizeRaw(raw);
    const before = snapshotCells(doc.workbook);
    const prevRaw = doc.workbook.getCell(norm).raw;
    const prevClean = prevRaw === '' || prevRaw === undefined ? null : prevRaw;
    doc.workbook.setCell(norm, clean);
    const changes = diffCells(before, snapshotCells(doc.workbook));
    doc.version += 1;
    const h = this._hist(doc, userId);
    h.undo.push({ ref: norm, from: prevClean, to: clean });
    h.redo.length = 0;
    this._scheduleSave(doc);
    return { version: doc.version, changes };
  }

  // Undo the user's last op. Returns { version, changes } or null if nothing.
  undo(docId, userId) {
    const doc = this.getDoc(docId);
    const h = this._hist(doc, userId);
    const op = h.undo.pop();
    if (!op) return null;
    const before = snapshotCells(doc.workbook);
    doc.workbook.setCell(op.ref, op.from);
    const changes = diffCells(before, snapshotCells(doc.workbook));
    doc.version += 1;
    h.redo.push(op); // redo re-applies op (set to op.to)
    this._scheduleSave(doc);
    return { version: doc.version, changes, ref: op.ref };
  }

  // Redo the user's last undone op. Returns { version, changes } or null.
  redo(docId, userId) {
    const doc = this.getDoc(docId);
    const h = this._hist(doc, userId);
    const op = h.redo.pop();
    if (!op) return null;
    const before = snapshotCells(doc.workbook);
    doc.workbook.setCell(op.ref, op.to);
    const changes = diffCells(before, snapshotCells(doc.workbook));
    doc.version += 1;
    h.undo.push(op);
    this._scheduleSave(doc);
    return { version: doc.version, changes, ref: op.ref };
  }
}
