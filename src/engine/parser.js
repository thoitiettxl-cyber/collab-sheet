// Recursive-descent parser -> AST. Shared server/client, plain ESM.
import { tokenize, TokenType, FormulaSyntaxError } from './tokenizer.js';
import { normalizeCellRef, isCellRef } from './cellAddress.js';

export { FormulaSyntaxError };

// AST node types:
// {type:'number', value}, {type:'string', value}, {type:'boolean', value},
// {type:'cell', ref}, {type:'range', start, end},
// {type:'unary', op, arg}, {type:'binary', op, left, right},
// {type:'call', name, args}, {type:'error', code}

export function parseFormula(input) {
  let src = input.trim();
  if (src.startsWith('=')) src = src.slice(1);
  const tokens = tokenize(src);
  const p = new Parser(tokens);
  const ast = p.parseExpression();
  p.expect(TokenType.EOF);
  return ast;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }
  expect(type, value) {
    const t = this.peek();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new FormulaSyntaxError(`Expected ${value ?? type} but got '${t.value}'`, t.pos);
    }
    return this.next();
  }
  matchOp(...ops) {
    const t = this.peek();
    if (t.type === TokenType.OP && ops.includes(t.value)) { this.next(); return t.value; }
    return null;
  }

  parseExpression() { return this.parseComparison(); }

  parseComparison() {
    let left = this.parseAdditive();
    for (;;) {
      const op = this.matchOp('=', '<>', '<', '>', '<=', '>=');
      if (!op) return left;
      const right = this.parseAdditive();
      left = { type: 'binary', op, left, right };
    }
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    for (;;) {
      const op = this.matchOp('+', '-');
      if (!op) return left;
      const right = this.parseMultiplicative();
      left = { type: 'binary', op, left, right };
    }
  }

  parseMultiplicative() {
    let left = this.parsePower();
    for (;;) {
      const op = this.matchOp('*', '/');
      if (!op) return left;
      const right = this.parsePower();
      left = { type: 'binary', op, left, right };
    }
  }

  // ^ is right-associative
  parsePower() {
    const base = this.parseUnary();
    if (this.matchOp('^')) {
      const exp = this.parsePower();
      return { type: 'binary', op: '^', left: base, right: exp };
    }
    return base;
  }

  parseUnary() {
    const op = this.matchOp('+', '-');
    if (op) return { type: 'unary', op, arg: this.parseUnary() };
    return this.parsePrimary();
  }

  parsePrimary() {
    const t = this.peek();
    if (t.type === TokenType.NUMBER) {
      this.next();
      return { type: 'number', value: parseFloat(t.value) };
    }
    if (t.type === TokenType.STRING) {
      this.next();
      return { type: 'string', value: t.value };
    }
    if (t.type === TokenType.IDENT) {
      return this.parseIdentOrCell();
    }
    if (t.type === TokenType.OP && t.value === '(') {
      this.next();
      const expr = this.parseExpression();
      this.expect(TokenType.OP, ')');
      return expr;
    }
    throw new FormulaSyntaxError(`Unexpected token '${t.value}'`, t.pos);
  }

  parseIdentOrCell() {
    const t = this.next(); // IDENT
    const name = t.value;
    // Function call?
    if (this.peek().type === TokenType.OP && this.peek().value === '(') {
      this.next(); // (
      const args = [];
      if (!(this.peek().type === TokenType.OP && this.peek().value === ')')) {
        for (;;) {
          args.push(this.parseExpression());
          if (this.matchOp(',')) continue;
          break;
        }
      }
      this.expect(TokenType.OP, ')');
      return { type: 'call', name: name.toUpperCase(), args };
    }
    // Boolean literals
    const upper = name.toUpperCase();
    if (upper === 'TRUE') return { type: 'boolean', value: true };
    if (upper === 'FALSE') return { type: 'boolean', value: false };
    // Cell ref? (allow $A$1, A1)
    if (isCellRef(name)) {
      const ref = normalizeCellRef(name);
      // Range? A1:B3
      if (this.peek().type === TokenType.OP && this.peek().value === ':') {
        this.next();
        const t2 = this.expect(TokenType.IDENT);
        if (!isCellRef(t2.value)) {
          throw new FormulaSyntaxError(`Invalid range end '${t2.value}'`, t2.pos);
        }
        const end = normalizeCellRef(t2.value);
        return { type: 'range', start: ref, end };
      }
      return { type: 'cell', ref };
    }
    // Looks like a cell ref but invalid (e.g. A0) -> #REF!
    if (/^\$?[A-Za-z]{1,3}\$?[0-9]+$/.test(name)) {
      return { type: 'error', code: '#REF!' };
    }
    // Unknown identifier -> let evaluator raise #NAME?
    return { type: 'name', name: upper };
  }
}

// Collect cell dependencies (including expanded ranges) from an AST.
// Returns Set of normalized cell refs like 'A1'.
export function collectDependencies(ast) {
  const deps = new Set();
  const visit = (node) => {
    if (!node) return;
    switch (node.type) {
      case 'cell': deps.add(node.ref); break;
      case 'range':
        for (const ref of expandRange(node.start, node.end)) deps.add(ref);
        break;
      case 'unary': visit(node.arg); break;
      case 'binary': visit(node.left); visit(node.right); break;
      case 'call': node.args.forEach(visit); break;
      default: break;
    }
  };
  visit(ast);
  return deps;
}

// Lazy import to avoid circular: cellAddress is standalone.
import { expandRange } from './cellAddress.js';
