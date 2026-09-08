'use strict';

/* ===========================================================================
   Formula engine tests
   ---------------------------------------------------------------------------
   The engine ships in the renderer, so it is loaded here the way the browser
   loads it -- as a classic script against a global -- rather than being
   restructured into a module just to be testable.
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const AIOS = {};
const sandboxGlobals = { window: {}, AIOS, console };
sandboxGlobals.window.AIOS = AIOS;
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'apps', 'formula.js'), 'utf8'),
  sandboxGlobals,
  { filename: 'formula.js' }
);
const F = AIOS.formula;

/** Convenience: evaluate one formula against a literal sheet. */
function calc(formula, cells) {
  const all = Object.assign({}, cells || {}, { ZZ1: { f: formula } });
  return F.recalc(all).values.ZZ1;
}

/* ---------------------------------------------------------------- basics */

test('arithmetic respects precedence and parentheses', () => {
  assert.equal(calc('=1+2*3'), 7);
  assert.equal(calc('=(1+2)*3'), 9);
  assert.equal(calc('=2^3^2'), 512);          // right associative
  assert.equal(calc('=-3+5'), 2);
  assert.equal(calc('=10/4'), 2.5);
  assert.equal(calc('=50%'), 0.5);
});

test('string concatenation and comparison', () => {
  assert.equal(calc('="a"&"b"'), 'ab');
  assert.equal(calc('="x"&1'), 'x1');
  assert.equal(calc('=1=1'), true);
  assert.equal(calc('=2<>2'), false);
  assert.equal(calc('="a"<"b"'), true);
  assert.equal(calc('=3>=3'), true);
});

test('cell references and ranges', () => {
  const sheet = { A1: { v: 1 }, A2: { v: 2 }, A3: { v: 3 }, B1: { v: 'x' } };
  assert.equal(calc('=A1+A3', sheet), 4);
  assert.equal(calc('=SUM(A1:A3)', sheet), 6);
  assert.equal(calc('=COUNTA(A1:B1)', sheet), 2);
  assert.equal(calc('=B1&A1', sheet), 'x1');
});

test('a reference to an empty cell is blank, not an error', () => {
  assert.equal(calc('=Q9'), '');
  assert.equal(calc('=Q9+1'), 1);
});

/* -------------------------------------------------------------- functions */

test('aggregate functions', () => {
  const s = { A1: { v: 4 }, A2: { v: 8 }, A3: { v: 6 }, A4: { v: '' }, A5: { v: 'text' } };
  assert.equal(calc('=SUM(A1:A5)', s), 18);
  assert.equal(calc('=AVERAGE(A1:A5)', s), 6);
  assert.equal(calc('=MIN(A1:A5)', s), 4);
  assert.equal(calc('=MAX(A1:A5)', s), 8);
  assert.equal(calc('=COUNT(A1:A5)', s), 3);
  assert.equal(calc('=COUNTA(A1:A5)', s), 4);
  assert.equal(calc('=MEDIAN(A1:A5)', s), 6);
  assert.equal(calc('=PRODUCT(A1:A3)', s), 192);
});

test('conditional aggregates', () => {
  const s = {
    A1: { v: '筆電' }, B1: { v: 30000 },
    A2: { v: '滑鼠' }, B2: { v: 800 },
    A3: { v: '筆電' }, B3: { v: 42000 }
  };
  assert.equal(calc('=SUMIF(A1:A3,"筆電",B1:B3)', s), 72000);
  assert.equal(calc('=COUNTIF(A1:A3,"筆電")', s), 2);
  assert.equal(calc('=COUNTIF(B1:B3,">1000")', s), 2);
  assert.equal(calc('=AVERAGEIF(A1:A3,"筆電",B1:B3)', s), 36000);
});

test('logic and text functions', () => {
  assert.equal(calc('=IF(1>2,"yes","no")'), 'no');
  assert.equal(calc('=IF(TRUE,"y","n")'), 'y');
  assert.equal(calc('=AND(TRUE,1)'), true);
  assert.equal(calc('=OR(FALSE,0)'), false);
  assert.equal(calc('=NOT(FALSE)'), true);
  assert.equal(calc('=LEN("hello")'), 5);
  assert.equal(calc('=LEFT("hello",2)'), 'he');
  assert.equal(calc('=RIGHT("hello",2)'), 'lo');
  assert.equal(calc('=MID("hello",2,3)'), 'ell');
  assert.equal(calc('=UPPER("ab")'), 'AB');
  assert.equal(calc('=TRIM("  a   b ")'), 'a b');
  assert.equal(calc('=CONCAT("a","b","c")'), 'abc');
  assert.equal(calc('=SUBSTITUTE("a-b-c","-","+")'), 'a+b+c');
  assert.equal(calc('=ROUND(3.14159,2)'), 3.14);
  assert.equal(calc('=MOD(7,3)'), 1);
});

test('lookup functions take the arguments a spreadsheet user would write', () => {
  /* A range used to arrive flattened, so VLOOKUP needed a fourth argument saying
     how wide the table was -- a signature nobody would guess, which returned the
     wrong column when it was left out. Ranges keep their shape now. */
  const s = {
    A1: { v: 'x' }, B1: { v: 10 }, C1: { v: 'first' },
    A2: { v: 'y' }, B2: { v: 20 }, C2: { v: 'second' },
    A3: { v: 'z' }, B3: { v: 30 }, C3: { v: 'third' }
  };
  assert.equal(calc('=VLOOKUP("y",A1:C3,2,FALSE)', s), 20);
  assert.equal(calc('=VLOOKUP("y",A1:C3,3,FALSE)', s), 'second');
  assert.equal(calc('=VLOOKUP("nope",A1:C3,2,FALSE)', s), '#N/A');

  assert.equal(calc('=INDEX(A1:C3,2,2)', s), 20);
  assert.equal(calc('=INDEX(B1:B3,2)', s), 20, 'a single column may be indexed with one number');
  assert.equal(calc('=INDEX(A1:C1,3)', s), 'first', 'and so may a single row');
  assert.equal(calc('=INDEX(A1:C3,9,9)', s), '#REF!');

  assert.equal(calc('=MATCH("z",A1:A3,0)', s), 3);
  assert.equal(calc('=MATCH("q",A1:A3,0)', s), '#N/A');
  assert.equal(calc('=INDEX(B1:B3,MATCH("z",A1:A3,0))', s), 30, 'the idiom that replaces VLOOKUP');
});

test('approximate lookup takes the last key that does not overshoot', () => {
  // Bracket lookups: a score of 85 falls in the 80 band.
  const bands = {
    A1: { v: 0 }, B1: { v: 'F' },
    A2: { v: 60 }, B2: { v: 'D' },
    A3: { v: 70 }, B3: { v: 'C' },
    A4: { v: 80 }, B4: { v: 'B' },
    A5: { v: 90 }, B5: { v: 'A' }
  };
  assert.equal(calc('=VLOOKUP(85,A1:B5,2)', bands), 'B');
  assert.equal(calc('=VLOOKUP(90,A1:B5,2)', bands), 'A');
  assert.equal(calc('=VLOOKUP(0,A1:B5,2)', bands), 'F');
  assert.equal(calc('=MATCH(85,A1:A5)', bands), 4);
  assert.equal(calc('=MATCH(85,A1:A5,0)', bands), '#N/A', 'exact mode does not settle for close');
});

test('HLOOKUP reads across the first row', () => {
  const s = {
    A1: { v: 'Q1' }, B1: { v: 'Q2' }, C1: { v: 'Q3' },
    A2: { v: 100 }, B2: { v: 200 }, C2: { v: 300 }
  };
  assert.equal(calc('=HLOOKUP("Q2",A1:C2,2,FALSE)', s), 200);
  assert.equal(calc('=HLOOKUP("Q9",A1:C2,2,FALSE)', s), '#N/A');
});

test('a range keeps its shape without changing what aggregates see', () => {
  const s = { A1: { v: 1 }, B1: { v: 2 }, A2: { v: 3 }, B2: { v: 4 } };
  assert.equal(calc('=SUM(A1:B2)', s), 10, 'flattening still happens inside SUM');
  assert.equal(calc('=COUNT(A1:B2)', s), 4);
  // Without dynamic arrays, a rectangle in a cell shows its top-left value.
  assert.equal(calc('=A1:B2', s), 1);
  // And a rectangle where one number is wanted collapses rather than erroring.
  assert.equal(calc('=ABS(A2:B2)', s), 3);
});

/* --------------------------------------------------------- error literals */

test('an error value can be written into a formula and survives reparsing', () => {
  /* Translating a formula off the edge of the sheet writes #REF! into the text,
     the way Excel does. If the tokeniser could not read it back, a broken
     reference would degrade into a syntax error and the cell would report the
     wrong problem. */
  assert.equal(calc('=#REF!'), '#REF!');
  assert.equal(calc('=1+#N/A'), '#N/A');
  assert.equal(calc('=IFERROR(#DIV/0!,"caught")'), 'caught');
  assert.equal(calc('=#NAME?'), '#NAME?');
});

/* ------------------------------------------------------------- translation */

test('$ pins a reference when a formula moves', () => {
  // Evaluation is unaffected -- A1 and $A$1 read the same cell.
  const s = { A1: { v: 7 } };
  assert.equal(calc('=$A$1', s), 7);
  assert.equal(calc('=SUM($A$1:$A$1)', s), 7);

  // The difference only shows up in translation, which is what fill and paste do.
  assert.equal(F.translate('=A1+1', 1, 0), '=B1+1');
  assert.equal(F.translate('=A1+1', 0, 2), '=A3+1');
  assert.equal(F.translate('=$A$1+1', 3, 3), '=$A$1+1');
  assert.equal(F.translate('=$A1+1', 2, 2), '=$A3+1', 'the column is pinned, the row is not');
  assert.equal(F.translate('=A$1+1', 2, 2), '=C$1+1', 'and the other way round');
  assert.equal(F.translate('=SUM(A1:B2)', 1, 1), '=SUM(B2:C3)');
  assert.equal(F.translate('=SUM($A$1:B2)', 1, 1), '=SUM($A$1:C3)');
});

test('translation leaves alone everything that is not a reference', () => {
  assert.equal(F.translate('=A1&"B2"', 1, 0), '=B1&"B2"', 'a ref inside a string is text');
  assert.equal(F.translate('=SUM(A1:A3)*2', 0, 0), '=SUM(A1:A3)*2', 'no delta, no rewrite');
  assert.equal(F.translate('plain text', 1, 1), 'plain text');
  assert.equal(F.translate('=SUM(', 1, 1), '=SUM(', 'nonsense is returned unchanged');
  assert.equal(F.translate('', 1, 1), '');
  // Spacing and the author's own spelling survive, because the text is spliced
  // rather than printed back out from the syntax tree.
  assert.equal(F.translate('= A1 +  1', 1, 0), '= B1 +  1');
});

test('a reference translated off the sheet becomes #REF!, not a wrong cell', () => {
  assert.equal(F.translate('=A1', -1, 0), '=#REF!');
  assert.equal(F.translate('=A1', 0, -1), '=#REF!');
  assert.equal(F.translate('=B2+$A$1', -5, -5), '=#REF!+$A$1');
  // And the result still parses, reporting the reference problem it really is.
  assert.equal(calc(F.translate('=A1', -1, 0)), '#REF!');
});

/* ------------------------------------------------------------- workbooks */

test('a formula can read another sheet', () => {
  const book = {
    收入: { A1: { v: 100 }, A2: { v: 200 } },
    摘要: { B1: { f: '=SUM(收入!A1:A2)' }, B2: { f: '=收入!A1*2' } }
  };
  const r = F.recalcBook(book);
  assert.equal(r.values.摘要.B1, 300);
  assert.equal(r.values.摘要.B2, 200);
  assert.equal(r.values.收入.A1, 100, 'and the sheet it read is reported too');
});

test('a sheet name with a space is written in single quotes', () => {
  const book = {
    '本月 明細': { C3: { v: 42 } },
    總表: { A1: { f: "='本月 明細'!C3+1" } }
  };
  const r = F.recalcBook(book);
  assert.equal(r.values.總表.A1, 43);
});

test('the same address on two sheets is two different cells', () => {
  /* Keyed by sheet as well as by address. Without that the dependency graph
     collides on A1 and a formula is evaluated before the thing it reads, so the
     answer is stale by exactly one recalculation -- right-looking and wrong. */
  const book = {
    一: { A1: { v: 1 }, B1: { f: '=A1+10' } },
    二: { A1: { v: 100 }, B1: { f: '=A1+10' } }
  };
  const r = F.recalcBook(book);
  assert.equal(r.values.一.B1, 11);
  assert.equal(r.values.二.B1, 110);
});

test('cross-sheet dependencies are ordered, not evaluated in key order', () => {
  const book = {
    // 甲!A1 depends on 乙!A1, which itself depends on 甲!A2.
    甲: { A1: { f: '=乙!A1*2' }, A2: { v: 5 } },
    乙: { A1: { f: '=甲!A2+1' } }
  };
  const r = F.recalcBook(book);
  assert.equal(r.values.乙.A1, 6);
  assert.equal(r.values.甲.A1, 12);
});

test('a cycle across two sheets is detected, not hung', () => {
  const book = {
    甲: { A1: { f: '=乙!A1' } },
    乙: { A1: { f: '=甲!A1' } }
  };
  const r = F.recalcBook(book);
  assert.equal(r.values.甲.A1, '#CYCLE!');
  assert.equal(r.values.乙.A1, '#CYCLE!');
});

test('a reference to a sheet that is not there is blank, not a crash', () => {
  const r = F.recalcBook({ 甲: { A1: { f: '=沒有這張表!A1' } } });
  assert.equal(r.values.甲.A1, '', 'an absent sheet reads as an absent cell');
});

test('recalc is still the single-sheet shape it always was', () => {
  const r = F.recalc({ A1: { v: 2 }, A2: { f: '=A1*3' } });
  assert.equal(r.values.A2, 6, 'bare references, bare keys');
  assert.deepEqual(Object.keys(r.values).sort(), ['A1', 'A2']);
});

test('a structural change on one sheet leaves other sheets alone', () => {
  const op = { kind: 'insertRow', at: 4, count: 1, sheet: '甲' };
  assert.equal(F.reshape('=A9', op, '甲'), '=A10', 'a formula on the changed sheet moves');
  assert.equal(F.reshape('=乙!A9', op, '甲'), '=乙!A9', 'a reference to another sheet does not');
  assert.equal(F.reshape('=甲!A9', op, '乙'), '=甲!A10',
    'and a formula elsewhere pointing at the changed sheet does move');
  assert.equal(F.reshape('=A9+乙!A9', op, '甲'), '=A10+乙!A9');
});

test('a qualified reference keeps its sheet name when the formula is copied', () => {
  // Excel moves the address and leaves the qualifier, because the sheet is not
  // a coordinate.
  assert.equal(F.translate('=收入!A1', 0, 1), '=收入!A2');
  assert.equal(F.translate("='本月 明細'!A1", 1, 0), "='本月 明細'!B1");
  assert.equal(F.translate('=收入!$A$1', 5, 5), '=收入!$A$1');
});

test('a malformed sheet reference is reported rather than half-read', () => {
  assert.throws(() => F.parse('收入!'), /儲存格位址/);
  assert.throws(() => F.parse("'未收尾!A1"), /工作表名稱/);
});

test('inserting a row moves the references below it and leaves the rest', () => {
  /* Not a constant shift: a structural change splits the sheet, so a reference
     above the cut must not move. Indices are zero-based, matching parseRef. */
  const op = { kind: 'insertRow', at: 4, count: 1 };          // insert before row 5
  assert.equal(F.reshape('=A1+A9', op), '=A1+A10');
  assert.equal(F.reshape('=SUM(A1:A9)', op), '=SUM(A1:A10)');
  assert.equal(F.reshape('=$A$9', op), '=$A$10',
    'absolute is fixed against copying, not against the sheet changing shape');
  assert.equal(F.reshape('=A1+B2', op), '=A1+B2', 'everything above the cut is untouched');
});

test('inserting a column is the same rule on the other axis', () => {
  const op = { kind: 'insertCol', at: 1, count: 2 };           // insert before B
  assert.equal(F.reshape('=A1+B1', op), '=A1+D1');
  assert.equal(F.reshape('=SUM(B1:C1)', op), '=SUM(D1:E1)');
  assert.equal(F.reshape('=A1', op), '=A1');
});

test('deleting a row breaks the references that pointed into it', () => {
  const op = { kind: 'deleteRow', at: 4, count: 2 };           // remove rows 5 and 6
  assert.equal(F.reshape('=A9', op), '=A7');
  assert.equal(F.reshape('=A1', op), '=A1');
  assert.equal(F.reshape('=A5', op), '=#REF!',
    'pointing at a deleted cell has no honest answer but #REF!');
  assert.equal(F.reshape('=A5+A9', op), '=#REF!+A7');
  // A range loses the deleted part rather than the whole thing.
  assert.equal(F.reshape('=SUM(A1:A9)', op), '=SUM(A1:A7)');
  assert.equal(F.reshape('=SUM(A5:A9)', op), '=SUM(A5:A7)');
  // And a range entirely inside the deleted band has nothing left.
  assert.equal(F.reshape('=SUM(A5:A6)', op), '=SUM(#REF!)');
});

test('a structurally rewritten formula still parses', () => {
  const broken = F.reshape('=A5*2', { kind: 'deleteRow', at: 4, count: 1 });
  assert.equal(broken, '=#REF!*2');
  assert.equal(calc(broken), '#REF!', 'and reports the reference problem, not a syntax error');
});

test('offsetRef is the same rule, one reference at a time', () => {
  assert.equal(F.offsetRef('A1', 2, 3), 'C4');
  assert.equal(F.offsetRef('$A$1', 2, 3), '$A$1');
  assert.equal(F.offsetRef('A$1', 2, 3), 'C$1');
  assert.equal(F.offsetRef('A1', -1, 0), '#REF!');
  assert.equal(F.offsetRef('not-a-ref', 1, 1), null);
});

/* ----------------------------------------------------------------- errors */

test('division by zero produces the spreadsheet error', () => {
  assert.equal(calc('=1/0'), '#DIV/0!');
  assert.equal(calc('=IFERROR(1/0,"fallback")'), 'fallback');
});

test('unknown function names are reported', () => {
  assert.equal(calc('=NOSUCHFN(1)'), '#NAME?');
});

test('text where a number is required is a value error', () => {
  assert.equal(calc('=1+"abc"'), '#VALUE!');
});

test('errors propagate through expressions', () => {
  const r = F.recalc({ A1: { f: '=1/0' }, A2: { f: '=A1+1' } });
  assert.equal(r.values.A1, '#DIV/0!');
  assert.equal(r.values.A2, '#DIV/0!');
});

test('a malformed formula does not throw out of recalc', () => {
  const r = F.recalc({ A1: { f: '=SUM(' } });
  assert.equal(r.values.A1, '#VALUE!');
  assert.ok(r.errors.A1, 'the parse error is reported for the UI');
});

/* ------------------------------------------------------------ dependencies */

test('formulas are evaluated in dependency order regardless of key order', () => {
  const r = F.recalc({
    C1: { f: '=B1*2' },
    B1: { f: '=A1+10' },
    A1: { v: 5 }
  });
  assert.equal(r.values.B1, 15);
  assert.equal(r.values.C1, 30);
});

test('a long chain resolves in one pass', () => {
  const cells = { A1: { v: 1 } };
  for (let i = 2; i <= 60; i++) cells['A' + i] = { f: `=A${i - 1}+1` };
  const r = F.recalc(cells);
  assert.equal(r.values.A60, 60);
});

test('direct and indirect cycles are detected, not hung', () => {
  const direct = F.recalc({ A1: { f: '=A1+1' } });
  assert.equal(direct.values.A1, '#CYCLE!');

  const indirect = F.recalc({ A1: { f: '=B1' }, B1: { f: '=C1' }, C1: { f: '=A1' } });
  assert.equal(indirect.values.A1, '#CYCLE!');
  assert.equal(indirect.values.B1, '#CYCLE!');
  assert.equal(indirect.values.C1, '#CYCLE!');

  // A cell that merely reads a cycle inherits the error rather than crashing.
  const reader = F.recalc({ A1: { f: '=B1' }, B1: { f: '=A1' }, D1: { f: '=A1+1' } });
  assert.equal(reader.values.D1, '#CYCLE!');
});

/* -------------------------------------------------------------- injection */

test('a formula cannot reach the host environment', () => {
  // The whole reason this is a parser and not eval(): a model writing into a
  // cell must not be able to run code.
  for (const attack of [
    '=constructor.constructor("return 1")()',
    '=this.process',
    '=globalThis',
    '=window.aios',
    '=[].constructor'
  ]) {
    const v = calc(attack);
    assert.ok(
      typeof v === 'string' && v.charAt(0) === '#',
      `${attack} should evaluate to an error, got ${JSON.stringify(v)}`
    );
  }
});

test('an enormous range is refused rather than expanded', () => {
  assert.equal(calc('=SUM(A1:ZZ99999)'), '#REF!');
});

/* ---------------------------------------------------------------- helpers */

test('column letters and indices round-trip', () => {
  assert.equal(F.indexToCol(0), 'A');
  assert.equal(F.indexToCol(25), 'Z');
  assert.equal(F.indexToCol(26), 'AA');
  assert.equal(F.indexToCol(51), 'AZ');
  assert.equal(F.colToIndex('A'), 0);
  assert.equal(F.colToIndex('AA'), 26);
  assert.equal(F.makeRef(2, 4), 'C5');
  // Compared field by field: the engine runs in a separate VM realm, so its
  // objects have a different Object prototype and deepStrictEqual would fail on
  // that alone.
  const a = F.parseRef('C5');
  assert.equal(a.col, 2);
  assert.equal(a.row, 4);
  const b = F.parseRef('$C$5');
  assert.equal(b.col, 2);
  assert.equal(b.row, 4);
});

test('parseRef reports which halves of a reference are pinned', () => {
  const rel = F.parseRef('C5');
  assert.equal(rel.colAbs, false);
  assert.equal(rel.rowAbs, false);
  const abs = F.parseRef('$C$5');
  assert.equal(abs.colAbs, true);
  assert.equal(abs.rowAbs, true);
  const mixed = F.parseRef('$C5');
  assert.equal(mixed.colAbs, true);
  assert.equal(mixed.rowAbs, false);
  assert.equal(F.makeRef(2, 4), 'C5');
  assert.equal(F.makeRef(2, 4, true, true), '$C$5');
  assert.equal(F.makeRef(2, 4, true, false), '$C5');
});

/* ------------------------------------------------------------------ dates */

test('a date is a serial number, matching the values Excel stores', () => {
  /* Pinned against known Excel serials. These are what .xlsx contains, so getting
     them wrong means every exported date lands on a different day in Excel. */
  assert.equal(F.dateSerial(1900, 1, 1), 1);
  assert.equal(F.dateSerial(1900, 2, 28), 59);
  assert.equal(F.dateSerial(1900, 3, 1), 61, 'serial 60 is the phantom 29 Feb 1900');
  assert.equal(F.dateSerial(2000, 1, 1), 36526);
  assert.equal(F.dateSerial(2026, 8, 15), 46249);

  assert.equal(calc('=YEAR(DATE(2026,8,15))'), 2026);
  assert.equal(calc('=MONTH(DATE(2026,8,15))'), 8);
  assert.equal(calc('=DAY(DATE(2026,8,15))'), 15);
  // Sums and differences are the whole point of a serial.
  assert.equal(calc('=DATE(2026,8,15)-DATE(2026,8,1)'), 14);
  assert.equal(calc('=DATE(2026,1,1)+31'), F.dateSerial(2026, 2, 1));
  // Out-of-range parts roll over, as they do in Excel.
  assert.equal(calc('=DATE(2026,13,1)'), F.dateSerial(2027, 1, 1));
  assert.equal(calc('=DATE(2026,1,32)'), F.dateSerial(2026, 2, 1));
});

test('the clock is the fractional part of the day', () => {
  assert.equal(calc('=TIME(12,0,0)'), 0.5);
  assert.equal(calc('=HOUR(TIME(13,45,30))'), 13);
  assert.equal(calc('=MINUTE(TIME(13,45,30))'), 45);
  assert.equal(calc('=SECOND(TIME(13,45,30))'), 30);
  assert.equal(calc('=HOUR(TIME(25,0,0))'), 1, 'past midnight wraps');
});

test('TODAY and NOW are numbers, not text that looks like a date', () => {
  const today = calc('=TODAY()');
  assert.equal(typeof today, 'number');
  assert.equal(today, Math.floor(today), 'TODAY carries no time of day');
  assert.equal(calc('=TODAY()-TODAY()'), 0, 'which used to be #VALUE! on strings');
  const now = calc('=NOW()');
  assert.ok(now >= today && now < today + 1);
});

test('WEEKDAY counts from Sunday by default', () => {
  // 2026-08-15 is a Saturday.
  assert.equal(calc('=WEEKDAY(DATE(2026,8,15))'), 7);
  assert.equal(calc('=WEEKDAY(DATE(2026,8,15),2)'), 6, 'type 2 counts from Monday');
  assert.equal(calc('=WEEKDAY(DATE(2026,8,16))'), 1, 'Sunday');
});

test('text that looks like a date can be read as one', () => {
  assert.equal(calc('=DATEVALUE("2026-08-15")'), F.dateSerial(2026, 8, 15));
  assert.equal(calc('=DATEVALUE("2026/8/15")'), F.dateSerial(2026, 8, 15));
  assert.equal(calc('=DATEVALUE("8/15/2026")'), F.dateSerial(2026, 8, 15));
  assert.equal(calc('=DATEVALUE("nonsense")'), '#VALUE!');
  assert.equal(calc('=VALUE("2026-08-15")'), F.dateSerial(2026, 8, 15));
  assert.equal(calc('=VALUE("1,234")'), 1234, 'and a plain number is still a number');
});

/* ------------------------------------------------------------ number format */

test('General trims the noise decimal arithmetic leaves behind', () => {
  assert.equal(F.format(0.1 + 0.2, 'General'), '0.3');
  assert.equal(F.format(1234.5, 'General'), '1234.5');
  assert.equal(F.format(1 / 3, 'General'), '0.333333333333');
  assert.equal(F.format('', 'General'), '');
  assert.equal(F.format(true, 'General'), 'TRUE');
  assert.equal(F.format('text', 'General'), 'text');
});

test('numeric formats place digits, separators and signs', () => {
  assert.equal(F.format(1234.5, '0.00'), '1234.50');
  assert.equal(F.format(1234.5, '#,##0.00'), '1,234.50');
  assert.equal(F.format(1234567, '#,##0'), '1,234,567');
  assert.equal(F.format(-5, '0.00'), '-5.00');
  assert.equal(F.format(0.5, '0'), '1', 'rounds rather than truncates');
  assert.equal(F.format(0.1234, '0.0%'), '12.3%');
  assert.equal(F.format(0.1234, '0%'), '12%');
  assert.equal(F.format(1234, '$#,##0'), '$1,234');
  assert.equal(F.format(12345678, '0.00E+00'), '1.23E+07');
  assert.equal(F.format(0.000123, '0.00E+00'), '1.23E-04');
  assert.equal(F.format('abc', '0.00'), 'abc', 'text a numeric code cannot describe stays itself');
  assert.equal(F.format('#DIV/0!', '0.00'), '#DIV/0!', 'and an error stays an error');
  assert.equal(F.format('x', '@'), 'x');
});

test('date formats read their tokens, and tell month from minute', () => {
  const d = F.dateSerial(2026, 8, 15);
  assert.equal(F.format(d, 'yyyy-mm-dd'), '2026-08-15');
  assert.equal(F.format(d, 'yyyy/m/d'), '2026/8/15');
  assert.equal(F.format(d, 'yy-mm-dd'), '26-08-15');
  assert.equal(F.format(F.dateSerial(2026, 1, 5), 'mm/dd'), '01/05');
  assert.equal(F.format(d + 0.5, 'yyyy-mm-dd hh:mm'), '2026-08-15 12:00');
  assert.equal(F.format(d + 0.5, 'hh:mm:ss'), '12:00:00');
  // `mm` next to an hour is minutes; next to a year it is the month.
  assert.equal(F.format(F.dateSerial(2026, 3, 1) + (13 * 60 + 7) / 1440, 'hh:mm'), '13:07');
  assert.equal(F.format(F.dateSerial(2026, 3, 1) + (13 * 60 + 7) / 1440, 'yyyy-mm'), '2026-03');
  assert.equal(F.format(d, '"民國"yyyy'), '民國2026', 'quoted text is literal');
});

test('a format code is recognised as a date only when it can only be one', () => {
  assert.equal(F.isDateCode('yyyy-mm-dd'), true);
  assert.equal(F.isDateCode('hh:mm'), true);
  assert.equal(F.isDateCode('0.00'), false);
  assert.equal(F.isDateCode('#,##0'), false);
  assert.equal(F.isDateCode('0%'), false);
  assert.equal(F.isDateCode('General'), false);
  assert.equal(F.isDateCode('0" days"'), false, 'a literal word is not a date token');
});

test('TEXT formats through the same code path the grid displays with', () => {
  assert.equal(calc('=TEXT(1234.5,"#,##0.00")'), '1,234.50');
  assert.equal(calc('=TEXT(0.25,"0%")'), '25%');
  assert.equal(calc('=TEXT(DATE(2026,8,15),"yyyy/mm/dd")'), '2026/08/15');
});

/* ================================================== the wider function set */

test('the IS family survives the thing it is asking about', () => {
  /* Evaluated eagerly these could never work: the throw from 1/0 escaped before
     the function was called, so ISERROR(1/0) reported #DIV/0! instead of TRUE. */
  assert.equal(calc('=ISERROR(1/0)'), true);
  assert.equal(calc('=ISERROR(1+1)'), false);
  assert.equal(calc('=ISERR(1/0)'), true);
  assert.equal(calc('=ISERR(NA())'), false, 'ISERR excludes #N/A on purpose');
  assert.equal(calc('=ISNA(NA())'), true);
  assert.equal(calc('=IFNA(NA(),"fallback")'), 'fallback');
  assert.equal(calc('=IFNA(1/0,"fallback")'), '#DIV/0!', 'IFNA does not swallow other errors');
});

test('conditionals only evaluate the branch they take', () => {
  const s = { A1: { v: 0 } };
  assert.equal(calc('=IFS(A1>0,1/A1,TRUE,"zero")', s), 'zero');
  assert.equal(calc('=IFS(A1>0,1,A1<0,-1)', s), '#N/A', 'no branch matched');
  assert.equal(calc('=SWITCH(2,1,"one",2,"two","other")'), 'two');
  assert.equal(calc('=SWITCH(9,1,"one",2,"two","other")'), 'other');
  assert.equal(calc('=SWITCH(9,1,"one")'), '#N/A');
  assert.equal(calc('=CHOOSE(2,"a","b","c")'), 'b');
  assert.equal(calc('=CHOOSE(2,1/0,"safe")'), 'safe', 'the unchosen division is never run');
  assert.equal(calc('=CHOOSE(9,"a")'), '#VALUE!');
  assert.equal(calc('=XOR(TRUE,FALSE)'), true);
  assert.equal(calc('=XOR(TRUE,TRUE)'), false);
});

test('a reference can be asked about its own geometry', () => {
  assert.equal(calc('=ROW(C5)'), 5);
  assert.equal(calc('=COLUMN(C5)'), 3);
  assert.equal(calc('=ROWS(A1:B4)'), 4);
  assert.equal(calc('=COLUMNS(A1:B4)'), 2);
  assert.equal(calc('=ROWS(A1)'), 1);
});

test('multi-criteria aggregates', () => {
  const s = {
    A1: { v: '筆電' }, B1: { v: '台北' }, C1: { v: 30000 },
    A2: { v: '筆電' }, B2: { v: '台中' }, C2: { v: 42000 },
    A3: { v: '滑鼠' }, B3: { v: '台北' }, C3: { v: 800 },
    A4: { v: '筆電' }, B4: { v: '台北' }, C4: { v: 51000 }
  };
  assert.equal(calc('=SUMIFS(C1:C4,A1:A4,"筆電",B1:B4,"台北")', s), 81000);
  assert.equal(calc('=COUNTIFS(A1:A4,"筆電",B1:B4,"台北")', s), 2);
  assert.equal(calc('=AVERAGEIFS(C1:C4,A1:A4,"筆電")', s), 41000);
  assert.equal(calc('=MAXIFS(C1:C4,A1:A4,"筆電")', s), 51000);
  assert.equal(calc('=MINIFS(C1:C4,A1:A4,"筆電")', s), 30000);
  assert.equal(calc('=SUMIFS(C1:C4,A1:A4,"筆電",B1:B3,"台北")', s), '#VALUE!',
    'ranges of different shapes are refused rather than silently misaligned');
});

test('criteria understand the two wildcards', () => {
  const s = {
    A1: { v: 'ThinkPad X1' }, B1: { v: 3 },
    A2: { v: 'ThinkPad T14' }, B2: { v: 5 },
    A3: { v: 'MacBook Air' }, B3: { v: 2 }
  };
  assert.equal(calc('=COUNTIF(A1:A3,"ThinkPad*")', s), 2);
  assert.equal(calc('=SUMIF(A1:A3,"ThinkPad*",B1:B3)', s), 8);
  assert.equal(calc('=COUNTIF(A1:A3,"*Book*")', s), 1);
  assert.equal(calc('=COUNTIF(A1:A3,"MacBook Ai?")', s), 1);
});

test('maths beyond the four operations', () => {
  assert.equal(calc('=LN(EXP(1))'), 1);
  assert.equal(calc('=LOG(8,2)'), 3);
  assert.equal(calc('=LOG10(1000)'), 3);
  assert.equal(calc('=ROUND(PI(),4)'), 3.1416);
  assert.equal(calc('=DEGREES(PI())'), 180);
  assert.equal(calc('=ROUND(SIN(RADIANS(90)),6)'), 1);
  assert.equal(calc('=SIGN(-3)'), -1);
  assert.equal(calc('=TRUNC(3.99)'), 3);
  assert.equal(calc('=TRUNC(-3.99)'), -3, 'TRUNC cuts towards zero, unlike INT');
  assert.equal(calc('=INT(-3.99)'), -4);
  assert.equal(calc('=QUOTIENT(7,2)'), 3);
  assert.equal(calc('=EVEN(3)'), 4);
  assert.equal(calc('=ODD(4)'), 5);
  assert.equal(calc('=MROUND(17,5)'), 15);
  assert.equal(calc('=FACT(5)'), 120);
  assert.equal(calc('=COMBIN(5,2)'), 10);
  assert.equal(calc('=GCD(12,18)'), 6);
  assert.equal(calc('=LCM(4,6)'), 12);
  assert.equal(calc('=LN(0)'), '#NUM!');
});

test('SUMPRODUCT pairs the arrays up position by position', () => {
  const s = {
    A1: { v: 2 }, B1: { v: 10 },
    A2: { v: 3 }, B2: { v: 20 },
    A3: { v: 4 }, B3: { v: 30 }
  };
  assert.equal(calc('=SUMPRODUCT(A1:A3,B1:B3)', s), 200);
  assert.equal(calc('=SUMSQ(A1:A3)', s), 29);
  assert.equal(calc('=SUMPRODUCT(A1:A3,B1:B2)', s), '#VALUE!');
});

test('descriptive statistics', () => {
  const s = {};
  [4, 8, 6, 10, 2].forEach((v, i) => { s['A' + (i + 1)] = { v }; });
  assert.equal(calc('=VAR(A1:A5)', s), 10);
  assert.equal(calc('=VARP(A1:A5)', s), 8);
  assert.equal(calc('=STDEVP(A1:A5)', s), Math.sqrt(8));
  assert.equal(calc('=LARGE(A1:A5,1)', s), 10);
  assert.equal(calc('=LARGE(A1:A5,2)', s), 8);
  assert.equal(calc('=SMALL(A1:A5,1)', s), 2);
  assert.equal(calc('=RANK(8,A1:A5)', s), 2);
  assert.equal(calc('=RANK(8,A1:A5,TRUE)', s), 4, 'ascending ranks the other way up');
  assert.equal(calc('=MEDIAN(A1:A5)', s), 6);
  assert.equal(calc('=PERCENTILE(A1:A5,0.5)', s), 6);
  assert.equal(calc('=QUARTILE(A1:A5,4)', s), 10);
  assert.equal(calc('=SUBTOTAL(9,A1:A5)', s), 30);
  assert.equal(calc('=SUBTOTAL(109,A1:A5)', s), 30, 'the 10x codes mean the same function');
  assert.equal(calc('=MODE(A1:A5)', s), '#N/A', 'nothing repeats');
});

test('text functions beyond slicing', () => {
  assert.equal(calc('=FIND("b","abcb")'), 2);
  assert.equal(calc('=FIND("b","abcb",3)'), 4);
  assert.equal(calc('=FIND("B","abc")'), '#VALUE!', 'FIND is case sensitive');
  assert.equal(calc('=SEARCH("B","abc")'), 2, 'SEARCH is not');
  assert.equal(calc('=SEARCH("a*c","xxabc")'), 3, 'and SEARCH takes wildcards');
  assert.equal(calc('=REPLACE("abcdef",2,3,"XY")'), 'aXYef');
  assert.equal(calc('=REPT("ab",3)'), 'ababab');
  assert.equal(calc('=PROPER("hello world")'), 'Hello World');
  assert.equal(calc('=TEXTJOIN("-",TRUE,"a","","b")'), 'a-b');
  assert.equal(calc('=TEXTJOIN("-",FALSE,"a","","b")'), 'a--b');
  assert.equal(calc('=CHAR(65)'), 'A');
  assert.equal(calc('=CODE("A")'), 65);
  assert.equal(calc('=UNICHAR(20013)'), '中');
  assert.equal(calc('=UNICODE("中")'), 20013);
  assert.equal(calc('=EXACT("a","A")'), false);
  assert.equal(calc('=T(123)'), '');
  assert.equal(calc('=T("abc")'), 'abc');
  assert.equal(calc('=N("abc")'), 0);
  assert.equal(calc('=N(7)'), 7);
});

test('type questions', () => {
  const s = { A1: { v: 5 }, A2: { v: 'text' }, A3: { v: '' }, A4: { v: true } };
  assert.equal(calc('=ISBLANK(A3)', s), true);
  assert.equal(calc('=ISBLANK(A1)', s), false);
  assert.equal(calc('=ISNUMBER(A1)', s), true);
  assert.equal(calc('=ISTEXT(A2)', s), true);
  assert.equal(calc('=ISTEXT(A3)', s), false, 'empty is blank, not text');
  assert.equal(calc('=ISNONTEXT(A1)', s), true);
  assert.equal(calc('=ISLOGICAL(A4)', s), true);
  assert.equal(calc('=ISEVEN(4)'), true);
  assert.equal(calc('=ISODD(4)'), false);
  assert.equal(calc('=TYPE(A1)', s), 1);
  assert.equal(calc('=TYPE(A2)', s), 2);
  assert.equal(calc('=TYPE(A4)', s), 4);
});

test('the rest of the date family', () => {
  assert.equal(calc('=DAYS(DATE(2026,8,15),DATE(2026,8,1))'), 14);
  assert.equal(calc('=EDATE(DATE(2026,1,31),1)'), F.dateSerial(2026, 2, 28),
    'one month after 31 January is the end of February, not the 31st');
  assert.equal(calc('=EDATE(DATE(2026,3,15),-2)'), F.dateSerial(2026, 1, 15));
  assert.equal(calc('=EOMONTH(DATE(2026,2,10),0)'), F.dateSerial(2026, 2, 28));
  assert.equal(calc('=EOMONTH(DATE(2024,2,10),0)'), F.dateSerial(2024, 2, 29), 'a real leap year');
  assert.equal(calc('=DATEDIF(DATE(2020,3,15),DATE(2026,8,15),"Y")'), 6);
  assert.equal(calc('=DATEDIF(DATE(2026,1,1),DATE(2026,8,15),"M")'), 7);
  assert.equal(calc('=DATEDIF(DATE(2026,1,1),DATE(2026,8,15),"D")'), 226);
  // 2026-08-10 is a Monday, so Monday to Friday is five working days.
  assert.equal(calc('=NETWORKDAYS(DATE(2026,8,10),DATE(2026,8,14))'), 5);
  assert.equal(calc('=NETWORKDAYS(DATE(2026,8,10),DATE(2026,8,16))'), 5, 'the weekend does not count');
  assert.equal(calc('=WORKDAY(DATE(2026,8,14),1)'), F.dateSerial(2026, 8, 17),
    'the day after Friday is Monday');
  assert.equal(calc('=WEEKNUM(DATE(2026,1,1))'), 1);
});

test('lookup, the remaining shapes', () => {
  const s = {
    A1: { v: 10 }, B1: { v: 'low' },
    A2: { v: 20 }, B2: { v: 'mid' },
    A3: { v: 30 }, B3: { v: 'high' }
  };
  assert.equal(calc('=LOOKUP(25,A1:A3,B1:B3)', s), 'mid');
  assert.equal(calc('=XLOOKUP(20,A1:A3,B1:B3)', s), 'mid');
  assert.equal(calc('=XLOOKUP(99,A1:A3,B1:B3,"none")', s), 'none');
  assert.equal(calc('=XLOOKUP(99,A1:A3,B1:B3)', s), '#N/A');
});

test('the finance functions follow Excel sign conventions', () => {
  // A 1,000,000 loan at 2% a year over 20 years, paid monthly.
  const pmt = calc('=PMT(0.02/12,240,1000000)');
  assert.ok(pmt < 0, 'money leaving the borrower is negative');
  assert.equal(Math.round(pmt), -5059);
  assert.equal(Math.round(calc('=FV(0.05,10,-1000)')), 12578);
  assert.equal(Math.round(calc('=PV(0.05,10,-1000)')), 7722);
  assert.equal(Math.round(calc('=NPER(0.05,-1000,7721.73)')), 10);
  // Every flow is discounted, including the first: -100/1.1 + 60/1.1^2 + 60/1.1^3.
  assert.equal(Math.round(calc('=NPV(0.1,-100,60,60)')), 4);
  assert.equal(calc('=PMT(0,10,1000)'), -100, 'no interest is a plain division');
});

test('the function list the model is shown includes the lazy ones', () => {
  const names = F.functions;
  for (const wanted of ['IF', 'IFS', 'CHOOSE', 'SWITCH', 'ISERROR', 'ROW', 'COLUMNS',
    'SUMIFS', 'XLOOKUP', 'HLOOKUP', 'DATEDIF', 'TEXTJOIN', 'PMT', 'PERCENTILE']) {
    assert.ok(names.includes(wanted), wanted + ' is missing from the advertised list');
  }
  assert.equal(new Set(names).size, names.length, 'no duplicates');
  assert.ok(names.length > 120, 'expected a real library, got ' + names.length);
});
