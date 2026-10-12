import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/engine/tokenizer.js';
import { parseFormula } from '../src/engine/parser.js';
import { ERR } from '../src/engine/evaluator.js';
import { Workbook } from '../src/engine/workbook.js';
import { normalizeCellRef, expandRange } from '../src/engine/cellAddress.js';

// Evaluate a formula in cell Z99 of a fresh workbook preloaded with pairs.
function wbEval(pairs, formula) {
  const wb = new Workbook();
  for (const [ref, raw] of Object.entries(pairs)) wb.setCell(ref, raw);
  wb.setCell('Z99', formula);
  return wb.getValue('Z99');
}

describe('tokenizer', () => {
  it('tokenizes numbers, ops, parens', () => {
    const toks = tokenize('1 + 2.5 * (3 - .5)');
    assert.equal(toks[0].value, '1');
    assert.equal(toks[1].value, '+');
    assert.equal(toks[2].value, '2.5');
  });
  it('tokenizes strings with escaped quotes', () => {
    const toks = tokenize('"a""b"');
    assert.equal(toks[0].value, 'a"b');
  });
  it('tokenizes comparisons', () => {
    const toks = tokenize('A1<=B2');
    const ops = toks.filter((t) => t.type === 'OP').map((t) => t.value);
    assert.deepEqual(ops, ['<=']);
    const toks2 = tokenize('A1<>B1');
    assert.equal(toks2[1].value, '<>');
  });
  it('rejects unterminated string', () => {
    assert.throws(() => tokenize('"abc'), /Unterminated/);
  });
});

describe('cellAddress', () => {
  it('normalizes refs', () => {
    assert.equal(normalizeCellRef('a1'), 'A1');
    assert.equal(normalizeCellRef('$B$12'), 'B12');
  });
  it('expands ranges', () => {
    assert.deepEqual(expandRange('A1', 'B2'), ['A1', 'B1', 'A2', 'B2']);
    assert.deepEqual(expandRange('B2', 'A1'), ['A1', 'B1', 'A2', 'B2']);
  });
});

describe('parser', () => {
  it('parses precedence: 1+2*3 = 7', () => {
    assert.equal(wbEval({}, '=1+2*3').value, 7);
  });
  it('parses parentheses', () => {
    assert.equal(wbEval({}, '=(1+2)*3').value, 9);
  });
  it('parses power right-assoc: 2^3^2 = 512', () => {
    assert.equal(wbEval({}, '=2^3^2').value, 512);
  });
  it('parses unary minus', () => {
    assert.equal(wbEval({}, '=-5+3').value, -2);
    assert.equal(wbEval({}, '=--5').value, 5);
  });
  it('parses cell ref and range', () => {
    const ast = parseFormula('=A1+B2');
    assert.equal(ast.type, 'binary');
    const r = parseFormula('=SUM(A1:B3)');
    assert.equal(r.args[0].type, 'range');
  });
});

describe('evaluator arithmetic & comparisons', () => {
  it('adds/subtracts/multiplies/divides', () => {
    assert.equal(wbEval({}, '=10-4').value, 6);
    assert.equal(wbEval({}, '=6*7').value, 42);
    assert.equal(wbEval({}, '=8/2').value, 4);
  });
  it('division by zero -> #DIV/0!', () => {
    assert.equal(wbEval({}, '=1/0').error, ERR.DIV0);
    assert.equal(wbEval({}, '=0/0').error, ERR.DIV0);
  });
  it('comparisons', () => {
    assert.equal(wbEval({}, '=1<2').value, true);
    assert.equal(wbEval({}, '=2<>2').value, false);
    assert.equal(wbEval({}, '=3>=3').value, true);
    assert.equal(wbEval({}, '=1=1').value, true);
    assert.equal(wbEval({}, '="a"<"b"').value, true);
  });
  it('cell refs resolve', () => {
    assert.equal(wbEval({ A1: 5 }, '=A1*2').value, 10);
  });
  it('empty cell ref is 0 in arithmetic', () => {
    assert.equal(wbEval({}, '=A1+5').value, 5);
  });
  it('string arithmetic coerces numeric strings', () => {
    assert.equal(wbEval({ A1: '3' }, '=A1*2').value, 6);
  });
  it('non-numeric string in arithmetic -> #VALUE!', () => {
    assert.equal(wbEval({ A1: 'hello' }, '=A1+1').error, ERR.VALUE);
  });
});

describe('functions', () => {
  it('SUM with args and ranges', () => {
    assert.equal(wbEval({}, '=SUM(1,2,3)').value, 6);
    assert.equal(wbEval({ A1: 1, A2: 2, A3: 3 }, '=SUM(A1:A3)').value, 6);
    assert.equal(wbEval({ A1: 1, A2: 'x', A3: 3 }, '=SUM(A1:A3)').value, 4);
  });
  it('AVG and AVERAGE alias', () => {
    assert.equal(wbEval({}, '=AVG(2,4)').value, 3);
    assert.equal(wbEval({}, '=AVERAGE(2,4)').value, 3);
    assert.equal(wbEval({ A1: 1, A2: 2, A3: 3 }, '=AVG(A1:A3)').value, 2);
  });
  it('AVG of empty -> #DIV/0!', () => {
    assert.equal(wbEval({}, '=AVG()').error, ERR.DIV0);
  });
  it('MIN/MAX', () => {
    assert.equal(wbEval({}, '=MIN(3,1,2)').value, 1);
    assert.equal(wbEval({}, '=MAX(3,1,2)').value, 3);
    assert.equal(wbEval({ A1: 5, A2: 9 }, '=MIN(A1:A2)').value, 5);
    assert.equal(wbEval({ A1: 5, A2: 9 }, '=MAX(A1:A2)').value, 9);
    assert.equal(wbEval({}, '=MIN()').value, 0);
  });
  it('COUNT counts numbers', () => {
    assert.equal(wbEval({ A1: 1, A2: 'x', A3: 3 }, '=COUNT(A1:A3)').value, 2);
    assert.equal(wbEval({}, '=COUNT(1,"a",2)').value, 2);
  });
  it('IF with comparisons', () => {
    assert.equal(wbEval({}, '=IF(1<2, "yes", "no")').value, 'yes');
    assert.equal(wbEval({}, '=IF(1>2, "yes", "no")').value, 'no');
    assert.equal(wbEval({ A1: 10 }, '=IF(A1>=10, 1, 0)').value, 1);
    assert.equal(wbEval({}, '=IF(TRUE, 1, 0)').value, 1);
    assert.equal(wbEval({}, '=IF(FALSE, 1, 0)').value, 0);
  });
  it('IF with <> and =', () => {
    assert.equal(wbEval({ A1: 'x' }, '=IF(A1<>"y", 1, 0)').value, 1);
    assert.equal(wbEval({ A1: 'y' }, '=IF(A1="y", 1, 0)').value, 1);
  });
  it('unknown function -> #NAME?', () => {
    assert.equal(wbEval({}, '=FOO(1)').error, ERR.NAME);
  });
  it('unknown identifier -> #NAME?', () => {
    assert.equal(wbEval({}, '=hello+1').error, ERR.NAME);
  });
  it('invalid ref A0 -> #REF!', () => {
    assert.equal(wbEval({}, '=A0+1').error, ERR.REF);
  });
});

describe('workbook dependency & recalc', () => {
  it('chains recalc transitively', () => {
    const wb = new Workbook();
    wb.setCell('A1', 2);
    wb.setCell('B1', '=A1*3');
    wb.setCell('C1', '=B1+1');
    assert.equal(wb.getValue('C1').value, 7);
    wb.setCell('A1', 5);
    assert.equal(wb.getValue('B1').value, 15);
    assert.equal(wb.getValue('C1').value, 16);
  });
  it('range dependency triggers recalc', () => {
    const wb = new Workbook();
    wb.setCell('A1', 1); wb.setCell('A2', 2); wb.setCell('A3', 3);
    wb.setCell('B1', '=SUM(A1:A3)');
    assert.equal(wb.getValue('B1').value, 6);
    wb.setCell('A2', 10);
    assert.equal(wb.getValue('B1').value, 14);
  });
  it('incremental: unaffected cells keep values', () => {
    const wb = new Workbook();
    wb.setCell('A1', 1);
    wb.setCell('B1', '=A1+1');
    wb.setCell('C1', 100);
    wb.setCell('D1', '=C1+1');
    wb.setCell('A1', 2);
    assert.equal(wb.getValue('B1').value, 3);
    assert.equal(wb.getValue('D1').value, 101);
  });
  it('cycle detection: A1<->B1 show #CYCLE!', () => {
    const wb = new Workbook();
    wb.setCell('A1', '=B1+1');
    wb.setCell('B1', '=A1+1');
    assert.equal(wb.getValue('A1').error, ERR.CYCLE);
    assert.equal(wb.getValue('B1').error, ERR.CYCLE);
  });
  it('self reference is a cycle', () => {
    const wb = new Workbook();
    wb.setCell('A1', '=A1+1');
    assert.equal(wb.getValue('A1').error, ERR.CYCLE);
  });
  it('breaking a cycle recovers', () => {
    const wb = new Workbook();
    wb.setCell('A1', '=B1+1');
    wb.setCell('B1', '=A1+1');
    assert.equal(wb.getValue('A1').error, ERR.CYCLE);
    wb.setCell('B1', 5);
    assert.equal(wb.getValue('A1').value, 6);
    assert.equal(wb.getValue('B1').value, 5);
  });
  it('three-node cycle', () => {
    const wb = new Workbook();
    wb.setCell('A1', '=C1');
    wb.setCell('B1', '=A1');
    wb.setCell('C1', '=B1');
    assert.equal(wb.getValue('A1').error, ERR.CYCLE);
    assert.equal(wb.getValue('B1').error, ERR.CYCLE);
    assert.equal(wb.getValue('C1').error, ERR.CYCLE);
  });
  it('error propagation: dependent of #DIV/0! shows #DIV/0!', () => {
    const wb = new Workbook();
    wb.setCell('A1', '=1/0');
    wb.setCell('B1', '=A1+5');
    assert.equal(wb.getValue('A1').error, ERR.DIV0);
    assert.equal(wb.getValue('B1').error, ERR.DIV0);
  });
  it('literals: numbers, strings', () => {
    const wb = new Workbook();
    wb.setCell('A1', 42);
    wb.setCell('A2', 'hello');
    assert.equal(wb.getValue('A1').value, 42);
    assert.equal(wb.getValue('A2').value, 'hello');
  });
  it('formula referencing range ignores empties', () => {
    const wb = new Workbook();
    wb.setCell('A1', 4);
    wb.setCell('B1', '=SUM(A1:A5)');
    assert.equal(wb.getValue('B1').value, 4);
  });
  it('diamond dependency evaluates correctly', () => {
    const wb = new Workbook();
    wb.setCell('A1', 3);
    wb.setCell('B1', '=A1*2');
    wb.setCell('C1', '=A1*3');
    wb.setCell('D1', '=B1+C1');
    assert.equal(wb.getValue('D1').value, 15);
    wb.setCell('A1', 4);
    assert.equal(wb.getValue('D1').value, 20);
  });
});

describe('grid size sanity', () => {
  it('supports A-Z x 50', () => {
    const wb = new Workbook();
    wb.setCell('A1', 1);
    wb.setCell('Z50', '=A1+1');
    assert.equal(wb.getValue('Z50').value, 2);
  });
});
