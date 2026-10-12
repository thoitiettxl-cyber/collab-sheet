// Workbook: cell storage + dependency graph + incremental recalculation.
// Shared server/client, plain ESM. No Node-specific APIs.
import { parseFormula, collectDependencies, FormulaSyntaxError } from './parser.js';
import { evaluate, CellError, ERR } from './evaluator.js';
import { normalizeCellRef, isCellRef } from './cellAddress.js';

export { ERR };

const MAX_COLS = 18278; // ZZZ
const MAX_ROWS = 100000;

export class Workbook {
  constructor() {
    // Map ref -> { raw, ast|null, isFormula, value, error:null|string, deps:Set, dependents:Set }
    this.cells = new Map();
  }

  _ensure(ref) {
    const norm = normalizeCellRef(ref);
    if (!this.cells.has(norm)) {
      this.cells.set(norm, {
        raw: null, ast: null, isFormula: false,
        value: null, error: null,
        deps: new Set(), dependents: new Set(),
      });
    }
    return norm;
  }

  _getEntry(ref) {
    const norm = normalizeCellRef(ref);
    return this.cells.get(norm);
  }

  setCell(ref, raw) {
    const norm = this._ensure(ref);
    const entry = this.cells.get(norm);

    // Remove old reverse edges
    for (const d of entry.deps) {
      const depEntry = this.cells.get(d);
      if (depEntry) depEntry.dependents.delete(norm);
    }
    entry.deps = new Set();

    entry.raw = raw;
    entry.ast = null;
    entry.isFormula = false;
    entry.error = null;

    if (typeof raw === 'string' && raw.startsWith('=')) {
      entry.isFormula = true;
      try {
        const ast = parseFormula(raw);
        entry.ast = ast;
        const deps = collectDependencies(ast);
        entry.deps = deps;
        for (const d of deps) {
          const dn = this._ensure(d);
          this.cells.get(dn).dependents.add(norm);
        }
      } catch (e) {
        if (e instanceof FormulaSyntaxError) {
          entry.error = ERR.VALUE;
          entry.value = null;
        } else if (e instanceof CellError) {
          entry.error = e.code;
          entry.value = null;
        } else {
          entry.error = ERR.VALUE;
          entry.value = null;
        }
        // Still need recalc of dependents (they may depend on this broken cell)
        this._recalcFrom(norm);
        return this.getCell(norm);
      }
    } else {
      // Literal: numbers stay numbers, "true"/"false"? keep as-is except numeric strings?
      // We store raw; value computed below in recalc (literals need no eval).
      entry.value = coerceLiteral(raw);
      entry.error = null;
    }

    this._recalcFrom(norm);
    return this.getCell(norm);
  }

  getCell(ref) {
    const norm = normalizeCellRef(ref);
    const e = this.cells.get(norm);
    if (!e) return { ref: norm, raw: null, value: null, error: null, isFormula: false };
    return { ref: norm, raw: e.raw, value: e.value, error: e.error, isFormula: e.isFormula };
  }

  // Human-friendly: returns { value, error } ; error is like '#DIV/0!' or null.
  getValue(ref) {
    const c = this.getCell(ref);
    return { value: c.value, error: c.error };
  }

  // All cells (for sync / UI)
  getAllCells() {
    const out = {};
    for (const [ref, e] of this.cells) {
      out[ref] = { raw: e.raw, value: e.value, error: e.error, isFormula: e.isFormula };
    }
    return out;
  }

  // ---- incremental recalculation ----
  _recalcFrom(changedRef) {
    // Find affected: changed + transitive dependents
    const affected = new Set([changedRef]);
    const queue = [changedRef];
    while (queue.length) {
      const cur = queue.pop();
      const e = this.cells.get(cur);
      if (!e) continue;
      for (const dep of e.dependents) {
        if (!affected.has(dep)) { affected.add(dep); queue.push(dep); }
      }
    }

    // Cycle detection within affected subgraph (only formula cells with deps)
    const cycles = findCycleNodes(this.cells, affected);
    for (const ref of cycles) {
      const e = this.cells.get(ref);
      e.error = ERR.CYCLE;
      e.value = null;
    }

    // Topo order of non-cycle affected nodes (Kahn's), deps-first
    const order = topoSort(this.cells, affected, cycles);
    for (const ref of order) {
      if (cycles.has(ref)) continue;
      this._evaluateCell(ref);
    }
    // Any affected node not in order and not in cycles (shouldn't happen) -> evaluate
    for (const ref of affected) {
      if (!cycles.has(ref) && !order.includes(ref)) this._evaluateCell(ref);
    }
  }

  _evaluateCell(ref) {
    const e = this.cells.get(ref);
    if (!e) return;
    if (!e.isFormula) {
      // literal already set, but re-coerce in case
      if (e.raw === null || e.raw === undefined) { e.value = null; e.error = null; return; }
      if (typeof e.raw === 'string' && !e.raw.startsWith('=')) {
        e.value = coerceLiteral(e.raw);
        e.error = null;
      }
      return;
    }
    if (!e.ast) { e.value = null; e.error = e.error || ERR.VALUE; return; }
    const ctx = {
      getCellValue: (depRef) => {
        const dn = normalizeCellRef(depRef);
        const dep = this.cells.get(dn);
        if (!dep || dep.raw === null || dep.raw === undefined || dep.raw === '') return null;
        if (dep.error) throw new CellError(dep.error);
        return dep.value;
      },
    };
    try {
      const v = evaluate(e.ast, ctx);
      e.value = v;
      e.error = null;
    } catch (err) {
      if (err instanceof CellError) {
        e.value = null;
        e.error = err.code;
      } else {
        e.value = null;
        e.error = ERR.VALUE;
      }
    }
  }
}

function coerceLiteral(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return null;
    // Keep strings as strings; numeric coercion happens at evaluation time.
    // But a bare numeric literal cell should behave as number.
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return parseFloat(t);
    return raw;
  }
  return raw;
}

// Detect all nodes that are part of (or depend into?) cycles.
// We mark only nodes actually in a directed cycle. Dependents of cycles are
// handled by error propagation during evaluation.
function findCycleNodes(cells, affected) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const stack = [];
  const inCycle = new Set();

  for (const r of affected) color.set(r, WHITE);

  const dfs = (u) => {
    color.set(u, GRAY);
    stack.push(u);
    const e = cells.get(u);
    const deps = e ? [...e.deps].filter((d) => affected.has(d)) : [];
    for (const v of deps) {
      const c = color.get(v);
      if (c === GRAY) {
        // found cycle: everything from v to top of stack is in cycle
        const idx = stack.indexOf(v);
        for (let i = idx; i < stack.length; i++) inCycle.add(stack[i]);
      } else if (c === WHITE) {
        dfs(v);
      }
    }
    stack.pop();
    color.set(u, BLACK);
  };

  for (const r of affected) {
    if (color.get(r) === WHITE) dfs(r);
  }
  return inCycle;
}

function topoSort(cells, affected, exclude) {
  // Kahn's on affected minus exclude, edges dep -> node (evaluate deps first)
  const indeg = new Map();
  const nodes = [...affected].filter((r) => !exclude.has(r));
  for (const r of nodes) indeg.set(r, 0);
  for (const r of nodes) {
    const e = cells.get(r);
    if (!e) continue;
    for (const d of e.deps) {
      if (indeg.has(d)) indeg.set(r, indeg.get(r) + 1);
    }
  }
  const q = nodes.filter((r) => indeg.get(r) === 0);
  const order = [];
  while (q.length) {
    const u = q.shift();
    order.push(u);
    const ue = cells.get(u);
    if (!ue) continue;
    for (const depd of ue.dependents) {
      if (!indeg.has(depd)) continue;
      indeg.set(depd, indeg.get(depd) - 1);
      if (indeg.get(depd) === 0) q.push(depd);
    }
  }
  return order;
}

export function isValidAddress(ref) {
  if (!isCellRef(ref)) return false;
  const m = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$/.exec(ref.trim());
  if (!m) return false;
  return true;
}
