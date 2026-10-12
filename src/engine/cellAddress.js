// Cell address utilities: A1 <-> {col,row}, ranges. Shared server/client.

// Matches A1, $A$1, a1 etc. Column letters 1..3 chars, row 1..7 digits.
const CELL_RE = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$/;

export function isCellRef(text) {
  return CELL_RE.test(text.trim());
}

export function normalizeCellRef(text) {
  const m = CELL_RE.exec(text.trim());
  if (!m) throw new Error(`Invalid cell ref: ${text}`);
  return `${m[1].toUpperCase()}${parseInt(m[2], 10)}`;
}

export function colLettersToIndex(letters) {
  let idx = 0;
  const up = letters.toUpperCase();
  for (let i = 0; i < up.length; i++) {
    idx = idx * 26 + (up.charCodeAt(0 + i) - 64); // A=1
  }
  return idx; // 1-based
}

export function colIndexToLetters(idx) {
  let s = '';
  let n = idx;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function cellRefToCoords(ref) {
  const norm = normalizeCellRef(ref);
  const m = /^([A-Z]+)([0-9]+)$/.exec(norm);
  return { col: colLettersToIndex(m[1]), row: parseInt(m[2], 10) };
}

export function coordsToCellRef(col, row) {
  return `${colIndexToLetters(col)}${row}`;
}

export function expandRange(startRef, endRef) {
  const a = cellRefToCoords(startRef);
  const b = cellRefToCoords(endRef);
  const c1 = Math.min(a.col, b.col), c2 = Math.max(a.col, b.col);
  const r1 = Math.min(a.row, b.row), r2 = Math.max(a.row, b.row);
  const out = [];
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      out.push(coordsToCellRef(c, r));
    }
  }
  return out;
}
