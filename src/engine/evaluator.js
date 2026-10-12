// Evaluator for formula AST. Shared server/client, plain ESM.
// Error codes: #DIV/0!, #REF!, #NAME?, #VALUE!, #CYCLE!
import { expandRange } from './cellAddress.js';

export const ERR = {
  DIV0: '#DIV/0!',
  REF: '#REF!',
  NAME: '#NAME?',
  VALUE: '#VALUE!',
  CYCLE: '#CYCLE!',
};

export class CellError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export const isCellError = (v) => v instanceof CellError;

// ctx: { getCellValue(ref) -> number|string|boolean|null | CellError }
// getCellValue returns the *computed* value of another cell, or null for empty.
// It throws CellError for error cells, or returns CellError? We standardize:
// getCellValue throws CellError on error, returns value|null otherwise.
export function evaluate(ast, ctx) {
  const ev = (node) => {
    switch (node.type) {
      case 'number': return node.value;
      case 'string': return node.value;
      case 'boolean': return node.value;
      case 'name': throw new CellError(ERR.NAME);
      case 'error': throw new CellError(node.code || ERR.VALUE);
      case 'cell': {
        return ctx.getCellValue(node.ref);
      }
      case 'range': {
        // Ranges only valid inside functions; evaluating standalone is #VALUE!
        throw new CellError(ERR.VALUE);
      }
      case 'unary': {
        const v = ev(node.arg);
        const n = toNumber(v);
        return node.op === '-' ? -n : n;
      }
      case 'binary': {
        const op = node.op;
        if (['=', '<>', '<', '>', '<=', '>='].includes(op)) {
          const l = ev(node.left);
          const r = ev(node.right);
          return compareValues(op, l, r);
        }
        const l = toNumber(ev(node.left));
        const r = toNumber(ev(node.right));
        switch (op) {
          case '+': return l + r;
          case '-': return l - r;
          case '*': return l * r;
          case '/':
            if (r === 0) throw new CellError(ERR.DIV0);
            return l / r;
          case '^': return Math.pow(l, r);
          default: throw new CellError(ERR.VALUE);
        }
      }
      case 'call': {
        return evalFunction(node.name, node.args, ctx, ev);
      }
      default:
        throw new CellError(ERR.NAME);
    }
  };
  return ev(ast);
}

function toNumber(v) {
  if (v === null || v === undefined) return 0; // empty cell
  if (typeof v === 'number') {
    if (Number.isNaN(v)) throw new CellError(ERR.VALUE);
    return v;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return 0;
    const n = Number(t);
    if (!Number.isNaN(n)) return n;
    throw new CellError(ERR.VALUE);
  }
  throw new CellError(ERR.VALUE);
}

function compareValues(op, l, r) {
  // null (empty) compares as 0 / ""
  const ln = l === null ? 0 : l;
  const rn = r === null ? 0 : r;
  // If both numeric-ish -> numeric compare; both strings -> lexicographic
  const lNum = tryNum(ln);
  const rNum = tryNum(rn);
  let cmp;
  if (lNum !== null && rNum !== null) {
    cmp = lNum < rNum ? -1 : lNum > rNum ? 1 : 0;
  } else {
    const ls = String(ln).toLowerCase();
    const rs = String(rn).toLowerCase();
    cmp = ls < rs ? -1 : ls > rs ? 1 : 0;
  }
  switch (op) {
    case '=': return cmp === 0;
    case '<>': return cmp !== 0;
    case '<': return cmp < 0;
    case '>': return cmp > 0;
    case '<=': return cmp <= 0;
    case '>=': return cmp >= 0;
  }
}

function tryNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  if (v === null) return 0;
  return null;
}

function isTruthy(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  return true;
}

// Flatten function args into a list of raw values.
// Handles nested ranges, cell refs, scalars. Throws CellError on error refs.
function flattenArgs(args, ctx, ev) {
  const out = [];
  const pushValue = (v) => out.push(v);
  for (const arg of args) {
    if (arg.type === 'range') {
      for (const ref of expandRange(arg.start, arg.end)) {
        pushValue(ctx.getCellValue(ref)); // may throw
      }
    } else if (arg.type === 'cell') {
      pushValue(ctx.getCellValue(arg.ref));
    } else if (arg.type === 'call' || arg.type === 'binary' || arg.type === 'unary' ||
               arg.type === 'number' || arg.type === 'string' || arg.type === 'boolean') {
      // A nested expression could itself contain ranges only via function calls;
      // evaluate normally.
      pushValue(ev(arg));
    } else {
      pushValue(ev(arg));
    }
  }
  return out;
}

function numericValues(values) {
  const nums = [];
  for (const v of values) {
    if (v === null || v === undefined) continue; // skip empty
    if (typeof v === 'number') nums.push(v);
    else if (typeof v === 'boolean') nums.push(v ? 1 : 0);
    else if (typeof v === 'string') {
      const t = v.trim();
      if (t !== '' && !Number.isNaN(Number(t))) nums.push(Number(t));
      // ignore non-numeric text like Excel
    }
  }
  return nums;
}

function evalFunction(name, args, ctx, ev) {
  switch (name) {
    case 'SUM': {
      const vals = flattenArgs(args, ctx, ev);
      return numericValues(vals).reduce((a, b) => a + b, 0);
    }
    case 'AVERAGE':
    case 'AVG': {
      const vals = flattenArgs(args, ctx, ev);
      const nums = numericValues(vals);
      if (nums.length === 0) throw new CellError(ERR.DIV0);
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    }
    case 'MIN': {
      const vals = flattenArgs(args, ctx, ev);
      const nums = numericValues(vals);
      if (nums.length === 0) return 0;
      return Math.min(...nums);
    }
    case 'MAX': {
      const vals = flattenArgs(args, ctx, ev);
      const nums = numericValues(vals);
      if (nums.length === 0) return 0;
      return Math.max(...nums);
    }
    case 'COUNT': {
      const vals = flattenArgs(args, ctx, ev);
      return numericValues(vals).length;
    }
    case 'IF': {
      if (args.length < 2 || args.length > 3) throw new CellError(ERR.VALUE);
      const cond = ev(args[0]);
      if (isTruthy(cond)) return ev(args[1]);
      return args.length === 3 ? ev(args[2]) : false;
    }
    default:
      throw new CellError(ERR.NAME);
  }
}
