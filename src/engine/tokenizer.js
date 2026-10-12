// Tokenizer for spreadsheet formulas (shared server/client, plain ESM).
// Supports: numbers, double-quoted strings, identifiers, cell refs are parsed
// later from identifiers, operators + - * / ^ ( ) , : and comparisons = <> < > <= >=

export const TokenType = {
  NUMBER: 'NUMBER',
  STRING: 'STRING',
  IDENT: 'IDENT',
  OP: 'OP',
  EOF: 'EOF',
};

export function tokenize(input) {
  const tokens = [];
  let i = 0;
  const n = input.length;

  const isDigit = (c) => c >= '0' && c <= '9';
  const isAlpha = (c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_' || c === '$';
  const isAlphaNum = (c) => isAlpha(c) || isDigit(c) || c === '.';

  while (i < n) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    // Number: 123, 12.34, .5
    if (isDigit(c) || (c === '.' && i + 1 < n && isDigit(input[i + 1]))) {
      let j = i;
      let seenDot = false;
      while (j < n && (isDigit(input[j]) || (!seenDot && input[j] === '.'))) {
        if (input[j] === '.') seenDot = true;
        j++;
      }
      // exponent? keep simple: no exponent for now
      tokens.push({ type: TokenType.NUMBER, value: input.slice(i, j), pos: i });
      i = j;
      continue;
    }

    // String: "..." with "" as escaped quote
    if (c === '"') {
      let j = i + 1;
      let val = '';
      let closed = false;
      while (j < n) {
        if (input[j] === '"') {
          if (j + 1 < n && input[j + 1] === '"') { val += '"'; j += 2; continue; }
          closed = true; j++; break;
        }
        val += input[j]; j++;
      }
      if (!closed) throw new FormulaSyntaxError('Unterminated string', i);
      tokens.push({ type: TokenType.STRING, value: val, pos: i });
      i = j;
      continue;
    }

    // Identifier (function name, TRUE/FALSE, or cell ref like A1 / $A$1)
    if (isAlpha(c)) {
      let j = i;
      while (j < n && (isAlphaNum(input[j]))) j++;
      tokens.push({ type: TokenType.IDENT, value: input.slice(i, j), pos: i });
      i = j;
      continue;
    }

    // Two-char comparison ops
    const two = input.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') {
      tokens.push({ type: TokenType.OP, value: two, pos: i });
      i += 2;
      continue;
    }

    if ('+-*/^(),:<>='.includes(c)) {
      tokens.push({ type: TokenType.OP, value: c, pos: i });
      i++;
      continue;
    }

    throw new FormulaSyntaxError(`Unexpected character '${c}'`, i);
  }
  tokens.push({ type: TokenType.EOF, value: '', pos: n });
  return tokens;
}

export class FormulaSyntaxError extends Error {
  constructor(message, pos) {
    super(message);
    this.name = 'FormulaSyntaxError';
    this.pos = pos;
  }
}
