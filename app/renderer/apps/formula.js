'use strict';

/* ===========================================================================
   AI-OS // spreadsheet formula engine
   ---------------------------------------------------------------------------
   A real evaluator, not string substitution: tokeniser, recursive-descent
   parser, dependency graph, topological recalculation and cycle detection.

   That matters because the alternative -- regex-replacing cell references and
   calling eval -- gets =A1&"x" wrong, gets operator precedence wrong, cannot
   detect a circular reference, and hands arbitrary code execution to whatever
   typed the formula. On a machine where a language model fills in cells, that
   last one is not hypothetical.

   Errors follow spreadsheet convention (#DIV/0!, #REF!, #VALUE!, #CYCLE!) and
   propagate through expressions the way a user expects.
   =========================================================================== */

/* global window, AIOS */

(function () {

  var ERR = {
    div0: '#DIV/0!', ref: '#REF!', value: '#VALUE!', name: '#NAME?',
    na: '#N/A', cycle: '#CYCLE!', num: '#NUM!'
  };
  function isErr(v) {
    return typeof v === 'string' && v.charAt(0) === '#' && Object.keys(ERR)
      .some(function (k) { return ERR[k] === v; });
  }

  /* ---------------------------------------------------------------- refs */

  function colToIndex(letters) {
    var n = 0;
    var s = String(letters).toUpperCase();
    for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n - 1;
  }
  function indexToCol(n) {
    var s = '';
    var i = n + 1;
    while (i > 0) {
      var r = (i - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  }
  var REF_RE = /^\$?[A-Z]+\$?\d+$/i;

  /** `$B$7` -> the cell, plus which halves of it are pinned. */
  function parseRef(ref) {
    var m = String(ref).toUpperCase().match(/^(\$?)([A-Z]+)(\$?)(\d+)$/);
    if (!m) return null;
    return {
      col: colToIndex(m[2]),
      row: Number(m[4]) - 1,
      colAbs: m[1] === '$',
      rowAbs: m[3] === '$'
    };
  }

  /**
   * `A1`, or `$A$1` when told to pin.
   *
   * The two extra arguments exist for translation. `$` used to be thrown away by
   * the tokeniser, which was harmless while formulas never moved -- evaluation
   * reads the same cell either way. It stops being harmless the moment a formula
   * can be filled down or pasted somewhere else: that rewrites the relative parts
   * of every reference and must leave the pinned parts alone, so the writer has
   * to be able to put the dollars back where they were.
   */
  function makeRef(col, row, colAbs, rowAbs) {
    return (colAbs ? '$' : '') + indexToCol(col) + (rowAbs ? '$' : '') + (row + 1);
  }

  /**
   * Move a reference by a column/row delta, honouring its own pinning. Off the
   * top or left edge is #REF!, which is what Excel does and is more useful than
   * clamping: a formula that quietly retargeted a different cell is worse than
   * one that says it broke.
   */
  function offsetRef(ref, dc, dr) {
    var p = parseRef(ref);
    if (!p) return null;
    var col = p.colAbs ? p.col : p.col + dc;
    var row = p.rowAbs ? p.row : p.row + dr;
    if (col < 0 || row < 0) return ERR.ref;
    return makeRef(col, row, p.colAbs, p.rowAbs);
  }

  /**
   * The cells of a rectangle, keeping its shape: an array of rows, each an array
   * of refs. Shape is what makes VLOOKUP, HLOOKUP and INDEX honest -- flattening
   * first destroyed the only information they need, which is why VLOOKUP used to
   * demand a non-standard fourth argument saying how wide the table was.
   */
  function rangeGrid(a, b) {
    var A = parseRef(a);
    var B = parseRef(b);
    if (!A || !B) return [];
    var c0 = Math.min(A.col, B.col);
    var c1 = Math.max(A.col, B.col);
    var r0 = Math.min(A.row, B.row);
    var r1 = Math.max(A.row, B.row);
    // Guard against =SUM(A1:ZZ100000) turning into a hundred million cells.
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > 200000) return null;
    var out = [];
    for (var r = r0; r <= r1; r++) {
      var row = [];
      for (var c = c0; c <= c1; c++) row.push(makeRef(c, r));
      out.push(row);
    }
    return out;
  }

  /** Row-major list of the same cells, for the dependency graph. */
  function expandRange(a, b) {
    var grid = rangeGrid(a, b);
    if (!grid) return null;
    var out = [];
    grid.forEach(function (row) { out.push.apply(out, row); });
    return out;
  }

  /* ------------------------------------------------------------ tokeniser */

  /**
   * Read the reference or range that follows a `SheetName!`, and push it.
   *
   * `at` deliberately points at the reference and not at the sheet name, so the
   * rewriters -- translate() and reshape() -- splice only the part that moves and
   * leave the qualifier exactly as the author typed it.
   */
  function readQualified(s, i, t, sheetName) {
    var start = i;
    var word = '';
    while (i < s.length && /[A-Za-z0-9_$]/.test(s[i])) word += s[i++];
    if (!REF_RE.test(word)) throw new Error('! 後面要接儲存格位址，看到的是「' + word + '」');

    if (s[i] === ':') {
      i++;
      var second = '';
      while (i < s.length && /[A-Za-z0-9_$]/.test(s[i])) second += s[i++];
      t.push({
        k: 'range', sheet: sheetName,
        a: word.replace(/\$/g, '').toUpperCase(), b: second.replace(/\$/g, '').toUpperCase(),
        srcA: word.toUpperCase(), srcB: second.toUpperCase(),
        at: start, end: i
      });
      return i;
    }
    t.push({
      k: 'ref', sheet: sheetName,
      v: word.replace(/\$/g, '').toUpperCase(),
      src: word.toUpperCase(),
      at: start, end: i
    });
    return i;
  }

  function tokenize(src) {
    var t = [];
    var i = 0;
    var s = String(src);
    while (i < s.length) {
      var c = s[i];

      if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }

      if (c === '"') {
        var j = i + 1;
        var str = '';
        while (j < s.length) {
          if (s[j] === '"' && s[j + 1] === '"') { str += '"'; j += 2; continue; }
          if (s[j] === '"') break;
          str += s[j++];
        }
        if (j >= s.length) throw new Error('字串沒有結尾引號');
        t.push({ k: 'str', v: str });
        i = j + 1;
        continue;
      }

      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
        var num = '';
        while (i < s.length && /[0-9.eE]/.test(s[i])) {
          // Do not swallow the E of a cell reference such as E5.
          if ((s[i] === 'e' || s[i] === 'E') && !/[0-9+-]/.test(s[i + 1] || '')) break;
          num += s[i++];
        }
        if (s[i] === '%') { i++; t.push({ k: 'num', v: Number(num) / 100 }); continue; }
        t.push({ k: 'num', v: Number(num) });
        continue;
      }

      /* A sheet name in single quotes, which is how a name containing spaces is
         written: '收入 明細'!A1. Only meaningful in front of a `!`, so anything
         else that starts with a quote is a mistake rather than a string -- double
         quotes are the string delimiter here, as in Excel. */
      if (c === "'") {
        var nameEnd = i + 1;
        var sheetName = '';
        while (nameEnd < s.length) {
          if (s[nameEnd] === "'" && s[nameEnd + 1] === "'") { sheetName += "'"; nameEnd += 2; continue; }
          if (s[nameEnd] === "'") break;
          sheetName += s[nameEnd++];
        }
        if (s[nameEnd] !== "'" || s[nameEnd + 1] !== '!') throw new Error('工作表名稱後面要接 !');
        i = nameEnd + 2;
        i = readQualified(s, i, t, sheetName);
        continue;
      }

      if (/[A-Za-z_$\u4e00-\u9fff]/.test(c)) {
        var wordAt = i;
        var word = '';
        while (i < s.length && /[A-Za-z0-9_$.\u4e00-\u9fff]/.test(s[i])) word += s[i++];

        // Sheet1!A1. Checked before the ref test, because `Sheet1` is itself
        // ref-shaped -- letters then digits -- and would otherwise be read as a
        // cell in column SHEET.
        if (s[i] === '!') {
          i = readQualified(s, i + 1, t, word);
          continue;
        }

        // A reference, a range, or a function name depending on what follows.
        if (s[i] === '(') { t.push({ k: 'fn', v: word.toUpperCase() }); continue; }
        /* `v` is normalised so the evaluator can look the cell up in a map keyed
           by plain refs; `src` keeps the dollars, and `at`/`end` say where the
           reference sat in the source. Those three are what translate() needs to
           rewrite a formula without owning a printer for the whole grammar. */
        if (s[i] === ':' && REF_RE.test(word)) {
          i++;
          var w2 = '';
          while (i < s.length && /[A-Za-z0-9_$]/.test(s[i])) w2 += s[i++];
          t.push({
            k: 'range',
            a: word.replace(/\$/g, '').toUpperCase(), b: w2.replace(/\$/g, '').toUpperCase(),
            srcA: word.toUpperCase(), srcB: w2.toUpperCase(),
            at: wordAt, end: i
          });
          continue;
        }
        if (REF_RE.test(word)) {
          t.push({
            k: 'ref',
            v: word.replace(/\$/g, '').toUpperCase(),
            src: word.toUpperCase(),
            at: wordAt, end: i
          });
          continue;
        }
        var up = word.toUpperCase();
        if (up === 'TRUE' || up === 'FALSE') { t.push({ k: 'bool', v: up === 'TRUE' }); continue; }
        t.push({ k: 'name', v: up });
        continue;
      }

      /* Error literals are part of the language, not just output. Translating a
         formula off the edge of the sheet writes #REF! into the text the way
         Excel does, and that text has to survive being parsed again -- otherwise
         a broken reference degrades into a syntax error and the cell reports the
         wrong problem. */
      if (c === '#') {
        var errTok = s.substr(i, 8).match(/^#(REF!|VALUE!|NAME\?|DIV\/0!|NUM!|N\/A|CYCLE!)/i);
        if (errTok) {
          t.push({ k: 'err', v: '#' + errTok[1].toUpperCase() });
          i += errTok[0].length;
          continue;
        }
      }

      var two = s.substr(i, 2);
      if (two === '<=' || two === '>=' || two === '<>') { t.push({ k: 'op', v: two }); i += 2; continue; }
      if ('+-*/^&<>=(),%'.indexOf(c) >= 0) { t.push({ k: 'op', v: c }); i++; continue; }

      throw new Error('看不懂的字元：' + c);
    }
    return t;
  }

  /* --------------------------------------------------------------- parser */

  function parse(src) {
    var t = tokenize(src);
    var p = 0;

    function peek() { return t[p]; }
    function eat(k, v) {
      var tok = t[p];
      if (!tok || tok.k !== k || (v !== undefined && tok.v !== v)) {
        throw new Error('公式語法錯誤' + (tok ? '，在 ' + (tok.v !== undefined ? tok.v : tok.k) + ' 附近' : '：內容不完整'));
      }
      p++;
      return tok;
    }
    function isOp(v) {
      var tok = t[p];
      return tok && tok.k === 'op' && tok.v === v;
    }

    /* comparison < concat < additive < multiplicative < power < unary < atom */

    function expr() { return comparison(); }

    function comparison() {
      var left = concat();
      while (t[p] && t[p].k === 'op' && ['=', '<>', '<', '>', '<=', '>='].indexOf(t[p].v) >= 0) {
        var op = t[p++].v;
        left = { n: 'bin', op: op, a: left, b: concat() };
      }
      return left;
    }
    function concat() {
      var left = additive();
      while (isOp('&')) { p++; left = { n: 'bin', op: '&', a: left, b: additive() }; }
      return left;
    }
    function additive() {
      var left = multiplicative();
      while (isOp('+') || isOp('-')) {
        var op = t[p++].v;
        left = { n: 'bin', op: op, a: left, b: multiplicative() };
      }
      return left;
    }
    function multiplicative() {
      var left = power();
      while (isOp('*') || isOp('/')) {
        var op = t[p++].v;
        left = { n: 'bin', op: op, a: left, b: power() };
      }
      return left;
    }
    function power() {
      var left = unary();
      if (isOp('^')) { p++; return { n: 'bin', op: '^', a: left, b: power() }; }
      return left;
    }
    function unary() {
      if (isOp('-')) { p++; return { n: 'neg', a: unary() }; }
      if (isOp('+')) { p++; return unary(); }
      return atom();
    }

    function atom() {
      var tok = peek();
      if (!tok) throw new Error('公式不完整');

      if (tok.k === 'num') { p++; return { n: 'num', v: tok.v }; }
      if (tok.k === 'str') { p++; return { n: 'str', v: tok.v }; }
      if (tok.k === 'bool') { p++; return { n: 'bool', v: tok.v }; }
      if (tok.k === 'ref') { p++; return { n: 'ref', v: tok.v, sheet: tok.sheet }; }
      if (tok.k === 'range') { p++; return { n: 'range', a: tok.a, b: tok.b, sheet: tok.sheet }; }
      if (tok.k === 'err') { p++; return { n: 'err', v: tok.v }; }

      if (tok.k === 'fn') {
        p++;
        eat('op', '(');
        var args = [];
        if (!isOp(')')) {
          args.push(expr());
          while (isOp(',')) { p++; args.push(expr()); }
        }
        eat('op', ')');
        return { n: 'call', name: tok.v, args: args };
      }

      if (tok.k === 'op' && tok.v === '(') {
        p++;
        var e = expr();
        eat('op', ')');
        return e;
      }

      if (tok.k === 'name') { p++; return { n: 'name', v: tok.v }; }

      throw new Error('公式語法錯誤，在 ' + (tok.v !== undefined ? tok.v : tok.k) + ' 附近');
    }

    var ast = expr();
    if (p < t.length) throw new Error('公式尾端有多餘內容');
    return ast;
  }

  /* -------------------------------------------------------- translation --- */

  /**
   * Rewrite a formula for a new home: relative references move by the delta,
   * pinned ones stay put. This is what fill-down, copy and insert-a-row need.
   *
   * Done by splicing the source at the offsets the tokeniser recorded, not by
   * printing an AST back out. A printer would have to reproduce spacing, the
   * user's own numeric literals and their argument spelling, and would quietly
   * reformat every formula it touched -- so the one thing it was asked to change
   * would arrive alongside a dozen it was not.
   */
  function translate(formula, dc, dr) {
    var src = String(formula == null ? '' : formula);
    if (!dc && !dr) return src;
    var lead = src.charAt(0) === '=' ? '=' : '';
    var body = lead ? src.slice(1) : src;

    var toks;
    try { toks = tokenize(body); } catch (e) { return src; }   // nonsense is left alone

    var out = '';
    var at = 0;
    toks.forEach(function (tok) {
      if (tok.k !== 'ref' && tok.k !== 'range') return;
      out += body.slice(at, tok.at);
      out += tok.k === 'ref'
        ? String(offsetRef(tok.src, dc, dr))
        : String(offsetRef(tok.srcA, dc, dr)) + ':' + String(offsetRef(tok.srcB, dc, dr));
      at = tok.end;
    });
    return lead + out + body.slice(at);
  }

  /* ---------------------------------------------------- structural rewrite */

  /**
   * One reference, adjusted for rows or columns being inserted or removed.
   *
   * This is not translate() with a computed delta. A structural change splits the
   * sheet in two: references before the cut do not move at all, references after
   * it move by the whole count, and references *to* something deleted have no
   * answer -- they become #REF! rather than quietly pointing at whatever slid
   * into the vacated address, which is the failure mode that makes people
   * distrust spreadsheets.
   *
   * Pinning survives but does not exempt: `$B$10` still names the cell holding
   * that value after a row is inserted above it, so the dollars stay and the
   * number moves. That is what absolute means -- fixed against *copying*, not
   * against the sheet changing shape underneath it.
   *
   * `end` is 0 for a lone reference, 1 or 2 for the two ends of a range: a range
   * endpoint inside a deleted band collapses onto the edge of what survived,
   * because `SUM(A1:A9)` with rows 3 to 5 gone is still a sum of what is left.
   */
  function reshapeRef(ref, op, end) {
    var p = parseRef(ref);
    if (!p) return ref;
    var rowAxis = op.kind === 'insertRow' || op.kind === 'deleteRow';
    var idx = rowAxis ? p.row : p.col;
    var at = op.at;
    var n = op.count || 1;
    var out = idx;

    if (op.kind === 'insertRow' || op.kind === 'insertCol') {
      if (idx >= at) out = idx + n;
    } else if (idx >= at + n) {
      out = idx - n;
    } else if (idx >= at) {
      if (!end) return ERR.ref;
      out = end === 2 ? at - 1 : at;
    }
    if (out < 0) return ERR.ref;
    return rowAxis
      ? makeRef(p.col, out, p.colAbs, p.rowAbs)
      : makeRef(out, p.row, p.colAbs, p.rowAbs);
  }

  /**
   * Rewrite a whole formula for a structural change.
   *
   * op: { kind: 'insertRow'|'deleteRow'|'insertCol'|'deleteCol', at, count }
   * `at` is a zero-based index, the same coordinates parseRef reports.
   */
  function reshape(formula, op, home) {
    var src = String(formula == null ? '' : formula);
    if (!op || !op.kind) return src;
    var lead = src.charAt(0) === '=' ? '=' : '';
    var body = lead ? src.slice(1) : src;

    var toks;
    try { toks = tokenize(body); } catch (e) { return src; }

    var onSheet = op.sheet || '';
    var out = '';
    var at = 0;
    toks.forEach(function (tok) {
      if (tok.k !== 'ref' && tok.k !== 'range') return;
      /* A row inserted on one sheet says nothing about references to another, so
         a reference to a different sheet is left exactly as written. Skipping
         without touching `at` is what copies it through verbatim. */
      var refSheet = tok.sheet === undefined ? (home || '') : tok.sheet;
      if (refSheet !== onSheet) return;
      out += body.slice(at, tok.at);
      if (tok.k === 'ref') {
        out += String(reshapeRef(tok.src, op, 0));
      } else {
        var a = reshapeRef(tok.srcA, op, 1);
        var b = reshapeRef(tok.srcB, op, 2);
        // A range whose every cell is gone, or whose ends have crossed, has no
        // surviving meaning.
        var pa = parseRef(a);
        var pb = parseRef(b);
        if (a === ERR.ref || b === ERR.ref || !pa || !pb ||
            pa.row > pb.row || pa.col > pb.col) {
          out += ERR.ref;
        } else {
          out += a + ':' + b;
        }
      }
      at = tok.end;
    });
    return lead + out + body.slice(at);
  }

  /**
   * A cell's address across a whole workbook. The empty sheet name yields a bare
   * reference, so a single-sheet book uses exactly the keys it always did.
   */
  function qualify(sheet, ref) {
    return sheet ? sheet + '!' + ref : ref;
  }

  /**
   * Every cell this formula depends on, for the dependency graph.
   *
   * `home` is the sheet the formula lives on, which is what an unqualified
   * reference means. Without it a dependency on Sheet2!A1 and one on A1 would
   * collide in the graph and the recalculation order would be wrong in a way that
   * only shows up when two sheets happen to use the same addresses -- which they
   * always do.
   */
  function refsOf(ast, out, home) {
    out = out || [];
    if (!ast || typeof ast !== 'object') return out;
    if (ast.n === 'ref') {
      out.push(qualify(ast.sheet === undefined ? home : ast.sheet, ast.v));
    } else if (ast.n === 'range') {
      var cells = expandRange(ast.a, ast.b);
      var on = ast.sheet === undefined ? home : ast.sheet;
      if (cells) {
        cells.forEach(function (r) { out.push(qualify(on, r)); });
      }
    }
    ['a', 'b'].forEach(function (k) { if (ast[k]) refsOf(ast[k], out, home); });
    (ast.args || []).forEach(function (x) { refsOf(x, out, home); });
    return out;
  }

  /* ------------------------------------------------------------ coercion */

  /**
   * A range where a single value is wanted collapses to its first cell.
   *
   * Ranges are rectangles now, so anywhere that wants one number has to say what
   * it does with a grid. Excel calls this implicit intersection. Taking the first
   * cell is the same answer for the single-cell case that actually happens, and
   * predictable for the rest -- the alternative was String([[1,2]]) === '1,2' and
   * then NaN, which reported a value error for something that was merely vague.
   */
  function first(v) { return Array.isArray(v) ? flat(v)[0] : v; }

  function toNum(v) {
    v = first(v);
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (isErr(v)) throw v;
    var n = Number(String(v).replace(/,/g, '').trim());
    if (isNaN(n)) throw ERR.value;
    return n;
  }
  function toStr(v) {
    v = first(v);
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (isErr(v)) throw v;
    return String(v);
  }
  function toBool(v) {
    v = first(v);
    if (typeof v === 'boolean') return v;
    if (isErr(v)) throw v;
    if (v === '' || v === null || v === undefined) return false;
    if (typeof v === 'number') return v !== 0;
    var s = String(v).toUpperCase();
    if (s === 'TRUE') return true;
    if (s === 'FALSE') return false;
    return !!s;
  }

  /** Any argument as a rectangle, so lookup functions have one shape to handle. */
  function grid2d(v) {
    if (!Array.isArray(v)) return [[v]];
    if (!v.length) return [[]];
    if (Array.isArray(v[0])) return v;
    return v.map(function (x) { return [x]; });
  }

  /** Any argument as a flat list, for the functions that want a vector. */
  function vector(v) { return flat(Array.isArray(v) ? v : [v]); }

  /* Flatten arguments so SUM(A1:A9, 5, B2) behaves like a spreadsheet. */
  function flat(values) {
    var out = [];
    values.forEach(function (v) {
      if (Array.isArray(v)) out.push.apply(out, flat(v));
      else out.push(v);
    });
    return out;
  }
  function numbers(values) {
    return flat(values).filter(function (v) {
      return typeof v === 'number' || (typeof v === 'string' && v !== '' && !isNaN(Number(v)));
    }).map(Number);
  }

  /* =========================================================================
     Dates
     -------------------------------------------------------------------------
     A date is a number: whole days since the epoch, with the time of day as the
     fraction. That is how every spreadsheet does it, and it is why dates can be
     subtracted, compared and summed at all.

     THE 1900 LEAP BUG IS REPRODUCED ON PURPOSE

     Serial 60 in Excel is 1900-02-29, a day that did not exist -- Lotus 1-2-3 had
     the bug and Excel copied it for file compatibility. `.xlsx` stores serials,
     so a machine that got the calendar right here would write every date one day
     off from what Excel shows. Being wrong in the same way is the only way to be
     right about the file. Serial 60 itself has no real date; it reads as
     1900-03-01, because there is nothing else honest to do with it.

     Everything is computed in UTC. A spreadsheet date is a calendar date, not an
     instant, so it must not shift when the machine's zone does.
     ======================================================================= */

  var DAY_MS = 86400000;
  var EPOCH_UTC = Date.UTC(1899, 11, 31);   // serial 1 lands on 1900-01-01

  function serialToUtc(serial) {
    var n = Number(serial);
    if (!isFinite(n)) throw ERR.value;
    var whole = Math.floor(n);
    var frac = n - whole;
    var days = whole >= 61 ? whole - 1 : whole;
    return EPOCH_UTC + days * DAY_MS + Math.round(frac * DAY_MS);
  }

  function utcToSerial(ms) {
    var days = Math.floor((ms - EPOCH_UTC) / DAY_MS);
    var rest = ms - EPOCH_UTC - days * DAY_MS;
    return (days >= 60 ? days + 1 : days) + rest / DAY_MS;
  }

  /** Serial for a calendar date, rolling over out-of-range months and days. */
  function dateSerial(y, m, d) {
    var year = Math.round(y);
    // Excel's two-digit year rule, so DATE(26,1,1) is not the year 26.
    if (year >= 0 && year < 1900) year += year < 30 ? 2000 : 1900;
    return Math.floor(utcToSerial(Date.UTC(year, Math.round(m) - 1, Math.round(d))));
  }

  function serialParts(serial) {
    var n = Number(serial);
    var d = new Date(serialToUtc(n));
    /* Rounded to the whole second before the clock is read. A time of day is a
       fraction of a day, and 13:07 as 787/1440 does not survive being added to a
       five-digit date serial exactly -- the stored value lands a hair below, and
       flooring it reports 13:06. Excel rounds to the second when displaying for
       this same reason. */
    var dayMs = Math.round(((((n % 1) + 1) % 1) * DAY_MS) / 1000) * 1000;
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      // Weekday 1 = Sunday, matching WEEKDAY's default return type.
      weekday: d.getUTCDay() + 1,
      hour: Math.floor(dayMs / 3600000) % 24,
      minute: Math.floor(dayMs / 60000) % 60,
      second: Math.round(dayMs / 1000) % 60
    };
  }

  function todaySerial() {
    var now = new Date();
    return Math.floor(utcToSerial(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
  }

  function nowSerial() {
    var now = new Date();
    var day = todaySerial();
    var frac = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400;
    return day + frac;
  }

  /** Text that looks like a date -> serial. Accepts the shapes people type. */
  function parseDateText(text) {
    var s = String(text).trim();
    var m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return dateSerial(Number(m[1]), Number(m[2]), Number(m[3]));
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (m) return dateSerial(Number(m[3]), Number(m[1]), Number(m[2]));
    m = s.match(/^(\d{4})\u5e74(\d{1,2})\u6708(\d{1,2})\u65e5?$/);
    if (m) return dateSerial(Number(m[1]), Number(m[2]), Number(m[3]));
    return null;
  }

  /** Clock text -> a day fraction, for DATEVALUE's sibling TIMEVALUE. */
  function parseTimeText(text) {
    var m = String(text).trim().match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0)) / 86400;
  }

  /* =========================================================================
     Number formats
     -------------------------------------------------------------------------
     One formatter, shared by the TEXT function, the grid's display layer and the
     numFmt codes written into .xlsx -- so a cell, its exported file and
     TEXT(cell,code) cannot disagree about what a number looks like.

     A single section of the Excel format language: digit placeholders, thousands
     separators, a literal currency prefix, percent, scientific, the date and time
     tokens, and `@` for text. Not supported: conditional sections separated by
     `;`, colours in brackets, fractions, and locale tokens. Those are declared
     rather than half-implemented, because a format that silently ignores half of
     what it was given is worse than one that says it only speaks a subset.
     ======================================================================= */

  var MONTHS_TC = ['1\u6708', '2\u6708', '3\u6708', '4\u6708', '5\u6708', '6\u6708',
    '7\u6708', '8\u6708', '9\u6708', '10\u6708', '11\u6708', '12\u6708'];
  var WEEKDAYS_TC = ['\u65e5', '\u4e00', '\u4e8c', '\u4e09', '\u56db', '\u4e94', '\u516d'];

  function pad(n, width) {
    var s = String(Math.abs(Math.round(n)));
    while (s.length < width) s = '0' + s;
    return s;
  }

  function groupThousands(intPart) {
    return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /**
   * Whether a code describes a date rather than a number.
   *
   * Quoted literals are removed first: `0" days"` is a number format that happens
   * to say the word days, and reading it as a date would turn a quantity into
   * 1900-01-something. A digit placeholder settles it the other way -- no date
   * token is `#` or `0`, so a code containing one is arithmetic. `m` on its own
   * is not evidence either way, which is why it is not in the test.
   */
  function isDateCode(code) {
    var bare = String(code).replace(/"[^"]*"/g, '').replace(/\\./g, '');
    if (/#/.test(bare)) return false;
    return /yy|d|h|s|am\/pm|a\/p/i.test(bare);
  }

  /* The date/time tokens of a format code, longest first so `yyyy` is not read
     as two `yy`. `m` is deliberately absent: it is decided separately. */
  var DATE_TOKENS = [
    ['yyyy', 'year4'], ['yy', 'year2'],
    ['mmmm', 'monthName'], ['mmm', 'monthName'],
    ['dddd', 'weekday'], ['ddd', 'weekday'], ['aaaa', 'weekday'], ['aaa', 'weekday'],
    ['dd', 'day2'], ['d', 'day1'],
    ['hh', 'hour2'], ['h', 'hour1'],
    ['ss', 'second2'], ['s', 'second1'],
    ['am/pm', 'ampm'], ['a/p', 'ampm'],
    ['mm', 'mm'], ['m', 'm']
  ];

  function formatDate(serial, code) {
    var p = serialParts(serial);
    var src = String(code);
    var hasAmPm = /am\/pm|a\/p/i.test(src);
    var hour = hasAmPm ? (p.hour % 12 || 12) : p.hour;

    /* Scan into tokens first, then render. Two passes because `m` means month or
       minute depending on its neighbours, and that cannot be decided while still
       walking forwards -- Excel's rule is "a minute if it sits next to an hour or
       a second", which needs to see what comes after. */
    var toks = [];
    var i = 0;
    while (i < src.length) {
      var c = src.charAt(i);
      if (c === '\\') { toks.push({ lit: src.charAt(i + 1) || '' }); i += 2; continue; }
      if (c === '"') {
        var close = src.indexOf('"', i + 1);
        toks.push({ lit: close < 0 ? src.slice(i + 1) : src.slice(i + 1, close) });
        i = close < 0 ? src.length : close + 1;
        continue;
      }
      var hit = null;
      for (var k = 0; k < DATE_TOKENS.length; k++) {
        var word = DATE_TOKENS[k][0];
        if (src.substr(i, word.length).toLowerCase() === word) { hit = DATE_TOKENS[k]; break; }
      }
      if (hit) { toks.push({ kind: hit[1], len: hit[0].length }); i += hit[0].length; continue; }
      toks.push({ lit: c });
      i++;
    }

    function neighbourKind(from, step) {
      for (var j = from + step; j >= 0 && j < toks.length; j += step) {
        if (toks[j].kind) return toks[j].kind;
        if (/[^\s:.\/-]/.test(toks[j].lit || '')) return null;   // a real word ends the run
      }
      return null;
    }

    return toks.map(function (tok, idx) {
      if (!tok.kind) return tok.lit;
      var kind = tok.kind;
      if (kind === 'mm' || kind === 'm') {
        var prev = neighbourKind(idx, -1);
        var next = neighbourKind(idx, +1);
        var isMinute = /^hour/.test(prev || '') || /^second/.test(next || '');
        kind = isMinute ? (tok.len === 2 ? 'minute2' : 'minute1')
                        : (tok.len === 2 ? 'month2' : 'month1');
      }
      switch (kind) {
        case 'year4': return String(p.year);
        case 'year2': return pad(p.year % 100, 2);
        case 'monthName': return MONTHS_TC[p.month - 1];
        case 'weekday': return WEEKDAYS_TC[p.weekday - 1];
        case 'month2': return pad(p.month, 2);
        case 'month1': return String(p.month);
        case 'day2': return pad(p.day, 2);
        case 'day1': return String(p.day);
        case 'hour2': return pad(hour, 2);
        case 'hour1': return String(hour);
        case 'minute2': return pad(p.minute, 2);
        case 'minute1': return String(p.minute);
        case 'second2': return pad(p.second, 2);
        case 'second1': return String(p.second);
        case 'ampm': return p.hour < 12 ? 'AM' : 'PM';
        default: return '';
      }
    }).join('');
  }

  /**
   * Format one value with one format code. Anything the code cannot describe --
   * text against a numeric code, an error value -- comes back as itself.
   */
  function format(value, code) {
    var fmt = code === null || code === undefined || code === '' ? 'General' : String(code);
    if (isErr(value)) return value;
    if (fmt === '@') return value === null || value === undefined ? '' : String(value);

    if (/^general$/i.test(fmt)) {
      if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
      if (value === null || value === undefined) return '';
      if (typeof value !== 'number') return String(value);
      // Trim the float noise that decimal arithmetic leaves behind.
      return String(Math.abs(value) < 1e15 ? Number(value.toPrecision(12)) : value);
    }

    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value !== 'number') {
      var asNum = value === '' || value === null || value === undefined ? null : Number(value);
      if (asNum === null || isNaN(asNum)) return value === null || value === undefined ? '' : String(value);
      value = asNum;
    }

    if (isDateCode(fmt)) return formatDate(value, fmt);

    var n = value;
    var prefix = '';
    var suffix = '';

    // A literal head or tail: currency signs, units, anything quoted.
    var head = fmt.match(/^(?:\[[^\]]*\]|"[^"]*"|[^\d#0.,%eE]+)/);
    if (head) { prefix = head[0].replace(/^\[[^\]]*\]/, '').replace(/"/g, ''); fmt = fmt.slice(head[0].length); }
    var tail = fmt.match(/(?:"[^"]*"|[^\d#0.,%eE]+)$/);
    if (tail) { suffix = tail[0].replace(/"/g, ''); fmt = fmt.slice(0, fmt.length - tail[0].length); }

    var percent = (fmt.match(/%/g) || []).length;
    if (percent) { n *= Math.pow(100, percent); fmt = fmt.replace(/%/g, ''); suffix = '%'.repeat(percent) + suffix; }

    var sci = fmt.match(/[eE][+-]?(0+)$/);
    if (sci) {
      var mantissaCode = fmt.slice(0, fmt.length - sci[0].length);
      var sciDigits = ((mantissaCode.split('.')[1]) || '').replace(/[^0#?]/g, '').length;
      var expParts = n.toExponential(sciDigits).split('e');
      var expNum = Number(expParts[1]);
      // The code's run of zeros says how wide the exponent is written.
      return prefix + expParts[0] + 'E' + (expNum < 0 ? '-' : '+') +
             pad(Math.abs(expNum), sci[1].length) + suffix;
    }

    var grouped = /,/.test(fmt.replace(/,+$/, ''));
    var scaled = (fmt.match(/,+$/) || [''])[0].length;      // trailing commas scale by thousands
    if (scaled) n /= Math.pow(1000, scaled);
    fmt = fmt.replace(/,/g, '');

    var parts = fmt.split('.');
    var decWanted = (parts[1] || '').replace(/[^0#?]/g, '');
    var decMin = (parts[1] || '').replace(/[^0]/g, '').length;
    var intMin = (parts[0] || '').replace(/[^0]/g, '').length;

    var fixed = Math.abs(n).toFixed(decWanted.length);
    var split = fixed.split('.');
    var intText = split[0];
    var decText = split[1] || '';

    while (decText.length > decMin && decText.charAt(decText.length - 1) === '0') {
      decText = decText.slice(0, -1);
    }
    while (intText.length < intMin) intText = '0' + intText;
    if (intMin === 0 && intText === '0' && decText) intText = '';
    if (grouped) intText = groupThousands(intText);

    var sign = n < 0 ? '-' : '';
    return sign + prefix + intText + (decText ? '.' + decText : '') + suffix;
  }

  /** `*` and `?` in a criterion, the two wildcards a spreadsheet understands. */
  function wildcardRe(pattern) {
    var body = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/~\\\*/g, '\u0000').replace(/~\?/g, '\u0001')
      .replace(/\*/g, '[\\s\\S]*').replace(/\?/g, '[\\s\\S]')
      .replace(/\u0000/g, '\\*').replace(/\u0001/g, '\\?');
    return new RegExp('^' + body + '$', 'i');
  }

  /* Criteria for SUMIF / COUNTIF: ">5", "<=3", "<>x", or a literal, and a literal
     may use wildcards -- "筆電*" is how anyone would expect to match a prefix. */
  function matcher(crit) {
    var s = crit === null || crit === undefined ? '' : String(crit);
    var m = s.match(/^(<=|>=|<>|<|>|=)\s*(.*)$/);
    if (!m) {
      if (/[*?]/.test(s)) {
        var re = wildcardRe(s);
        return function (v) { return re.test(String(v == null ? '' : v)); };
      }
      return function (v) {
        if (typeof v === 'number' && !isNaN(Number(s))) return v === Number(s);
        return String(v == null ? '' : v).toLowerCase() === s.toLowerCase();
      };
    }
    if ((m[1] === '=' || m[1] === '<>') && /[*?]/.test(m[2])) {
      var reOp = wildcardRe(m[2]);
      var want = m[1] === '=';
      return function (v) { return reOp.test(String(v == null ? '' : v)) === want; };
    }
    var op = m[1];
    var raw = m[2];
    var asNum = raw !== '' && !isNaN(Number(raw)) ? Number(raw) : null;
    return function (v) {
      if (asNum !== null) {
        var n = typeof v === 'number' ? v : Number(v);
        if (isNaN(n)) return op === '<>';
        switch (op) {
          case '>': return n > asNum;
          case '<': return n < asNum;
          case '>=': return n >= asNum;
          case '<=': return n <= asNum;
          case '<>': return n !== asNum;
          default: return n === asNum;
        }
      }
      var a = String(v == null ? '' : v).toLowerCase();
      var b = raw.toLowerCase();
      switch (op) {
        case '<>': return a !== b;
        case '>': return a > b;
        case '<': return a < b;
        case '>=': return a >= b;
        case '<=': return a <= b;
        default: return a === b;
      }
    };
  }

  /* ------------------------------------------------------------ functions */

  var FNS = {
    SUM: function (a) { return numbers(a).reduce(function (x, y) { return x + y; }, 0); },
    PRODUCT: function (a) { return numbers(a).reduce(function (x, y) { return x * y; }, 1); },
    AVERAGE: function (a) {
      var n = numbers(a);
      if (!n.length) throw ERR.div0;
      return n.reduce(function (x, y) { return x + y; }, 0) / n.length;
    },
    MEDIAN: function (a) {
      var n = numbers(a).sort(function (x, y) { return x - y; });
      if (!n.length) throw ERR.num;
      var mid = Math.floor(n.length / 2);
      return n.length % 2 ? n[mid] : (n[mid - 1] + n[mid]) / 2;
    },
    STDEV: function (a) {
      var n = numbers(a);
      if (n.length < 2) throw ERR.div0;
      var mean = n.reduce(function (x, y) { return x + y; }, 0) / n.length;
      var v = n.reduce(function (acc, x) { return acc + (x - mean) * (x - mean); }, 0) / (n.length - 1);
      return Math.sqrt(v);
    },
    MIN: function (a) { var n = numbers(a); return n.length ? Math.min.apply(null, n) : 0; },
    MAX: function (a) { var n = numbers(a); return n.length ? Math.max.apply(null, n) : 0; },
    COUNT: function (a) { return numbers(a).length; },
    COUNTA: function (a) {
      return flat(a).filter(function (v) { return v !== '' && v !== null && v !== undefined; }).length;
    },
    COUNTBLANK: function (a) {
      return flat(a).filter(function (v) { return v === '' || v === null || v === undefined; }).length;
    },
    ABS: function (a) { return Math.abs(toNum(a[0])); },
    SQRT: function (a) { var n = toNum(a[0]); if (n < 0) throw ERR.num; return Math.sqrt(n); },
    POWER: function (a) { return Math.pow(toNum(a[0]), toNum(a[1])); },
    MOD: function (a) { var d = toNum(a[1]); if (!d) throw ERR.div0; return toNum(a[0]) % d; },
    INT: function (a) { return Math.floor(toNum(a[0])); },
    ROUND: function (a) {
      var d = a.length > 1 ? toNum(a[1]) : 0;
      var f = Math.pow(10, d);
      return Math.round(toNum(a[0]) * f) / f;
    },
    ROUNDUP: function (a) {
      var f = Math.pow(10, a.length > 1 ? toNum(a[1]) : 0);
      return Math.ceil(toNum(a[0]) * f) / f;
    },
    ROUNDDOWN: function (a) {
      var f = Math.pow(10, a.length > 1 ? toNum(a[1]) : 0);
      return Math.floor(toNum(a[0]) * f) / f;
    },
    CEILING: function (a) {
      var step = a.length > 1 ? toNum(a[1]) : 1;
      if (!step) throw ERR.div0;
      return Math.ceil(toNum(a[0]) / step) * step;
    },
    FLOOR: function (a) {
      var step = a.length > 1 ? toNum(a[1]) : 1;
      if (!step) throw ERR.div0;
      return Math.floor(toNum(a[0]) / step) * step;
    },

    IF: function (a) { return toBool(a[0]) ? (a.length > 1 ? a[1] : true) : (a.length > 2 ? a[2] : false); },
    IFERROR: function (a) { return isErr(a[0]) ? a[1] : a[0]; },
    AND: function (a) { return flat(a).every(function (v) { return toBool(v); }); },
    OR: function (a) { return flat(a).some(function (v) { return toBool(v); }); },
    NOT: function (a) { return !toBool(a[0]); },

    CONCAT: function (a) { return flat(a).map(toStr).join(''); },
    CONCATENATE: function (a) { return flat(a).map(toStr).join(''); },
    LEN: function (a) { return toStr(a[0]).length; },
    LEFT: function (a) { return toStr(a[0]).slice(0, a.length > 1 ? toNum(a[1]) : 1); },
    RIGHT: function (a) {
      var n = a.length > 1 ? toNum(a[1]) : 1;
      var s = toStr(a[0]);
      return n <= 0 ? '' : s.slice(-n);
    },
    MID: function (a) {
      var start = toNum(a[1]) - 1;
      return toStr(a[0]).substr(Math.max(0, start), toNum(a[2]));
    },
    UPPER: function (a) { return toStr(a[0]).toUpperCase(); },
    LOWER: function (a) { return toStr(a[0]).toLowerCase(); },
    TRIM: function (a) { return toStr(a[0]).replace(/\s+/g, ' ').trim(); },
    TEXT: function (a) { return format(first(a[0]), toStr(a[1])); },
    VALUE: function (a) {
      var v = first(a[0]);
      if (typeof v === 'number') return v;
      var asDate = parseDateText(v);
      if (asDate !== null) return asDate;
      return toNum(v);
    },
    SUBSTITUTE: function (a) {
      return toStr(a[0]).split(toStr(a[1])).join(toStr(a[2]));
    },

    /* Dates are serial numbers. TODAY() used to return the string '2026-08-15',
       which looked right and could not be used: subtracting two of them gave
       #VALUE!, sorting them worked only by luck of the ISO spelling, and .xlsx
       received text where Excel expected a number. */
    TODAY: function () { return todaySerial(); },
    NOW: function () { return nowSerial(); },

    SUMIF: function (a) {
      var range = Array.isArray(a[0]) ? a[0] : [a[0]];
      var test = matcher(a[1]);
      var sumRange = a.length > 2 ? (Array.isArray(a[2]) ? a[2] : [a[2]]) : range;
      var total = 0;
      range.forEach(function (v, i) {
        if (test(v)) {
          var target = sumRange[i];
          var n = typeof target === 'number' ? target : Number(target);
          if (!isNaN(n)) total += n;
        }
      });
      return total;
    },
    COUNTIF: function (a) {
      var range = Array.isArray(a[0]) ? a[0] : [a[0]];
      var test = matcher(a[1]);
      return range.filter(test).length;
    },
    AVERAGEIF: function (a) {
      var range = Array.isArray(a[0]) ? a[0] : [a[0]];
      var test = matcher(a[1]);
      var target = a.length > 2 ? (Array.isArray(a[2]) ? a[2] : [a[2]]) : range;
      var picked = [];
      range.forEach(function (v, i) {
        if (test(v)) {
          var n = Number(target[i]);
          if (!isNaN(n)) picked.push(n);
        }
      });
      if (!picked.length) throw ERR.div0;
      return picked.reduce(function (x, y) { return x + y; }, 0) / picked.length;
    },

    /* ------------------------------------------------------------- lookup

       These take the standard arguments now. The old VLOOKUP needed a fourth
       argument giving the table's width, because a range arrived as a flat list
       and the stride had been thrown away -- a signature nobody who knows
       spreadsheets would write, and one that silently returned the wrong column
       if it was omitted. */

    VLOOKUP: function (a) {
      var needle = first(a[0]);
      var table = grid2d(a[1]);
      var col = Math.round(toNum(a[2]));
      var approx = a.length > 3 ? toBool(a[3]) : true;
      if (col < 1) throw ERR.value;

      var best = -1;
      for (var r = 0; r < table.length; r++) {
        var key = table[r][0];
        if (sameValue(key, needle)) { best = r; break; }
        // Approximate mode assumes an ascending first column and takes the last
        // key that does not overshoot, which is what makes bracket lookups work.
        if (approx && compareValues(key, needle) < 0) best = r;
      }
      if (best < 0) throw ERR.na;
      var row = table[best];
      if (col > row.length) throw ERR.ref;
      var v = row[col - 1];
      return v === undefined ? '' : v;
    },

    HLOOKUP: function (a) {
      var needle = first(a[0]);
      var table = grid2d(a[1]);
      var row = Math.round(toNum(a[2]));
      var approx = a.length > 3 ? toBool(a[3]) : true;
      if (row < 1) throw ERR.value;
      if (!table.length) throw ERR.na;

      var head = table[0];
      var best = -1;
      for (var c = 0; c < head.length; c++) {
        if (sameValue(head[c], needle)) { best = c; break; }
        if (approx && compareValues(head[c], needle) < 0) best = c;
      }
      if (best < 0) throw ERR.na;
      if (row > table.length) throw ERR.ref;
      var v = table[row - 1][best];
      return v === undefined ? '' : v;
    },

    /** INDEX(range, row, [col]); a single row or column may be indexed with one. */
    INDEX: function (a) {
      var g = grid2d(a[0]);
      var rows = g.length;
      var cols = rows ? g[0].length : 0;
      var n1 = Math.round(toNum(a[1]));
      var n2 = a.length > 2 ? Math.round(toNum(a[2])) : null;

      if (n2 === null && (rows === 1 || cols === 1)) {
        var line = vector(g);
        if (n1 < 1 || n1 > line.length) throw ERR.ref;
        return line[n1 - 1];
      }
      var r = n1;
      var c = n2 === null ? 1 : n2;
      if (r < 1 || r > rows || c < 1 || c > cols) throw ERR.ref;
      var out = g[r - 1][c - 1];
      return out === undefined ? '' : out;
    },

    /** MATCH(needle, vector, [type]): 1 ascending, 0 exact, -1 descending. */
    MATCH: function (a) {
      var needle = first(a[0]);
      var line = vector(a[1]);
      var type = a.length > 2 ? Math.round(toNum(a[2])) : 1;

      if (type === 0) {
        for (var i = 0; i < line.length; i++) if (sameValue(line[i], needle)) return i + 1;
        throw ERR.na;
      }
      var best = -1;
      for (var j = 0; j < line.length; j++) {
        var c = compareValues(line[j], needle);
        if (c === 0) return j + 1;
        if (type > 0 && c < 0) best = j;
        if (type < 0 && c > 0) best = j;
      }
      if (best < 0) throw ERR.na;
      return best + 1;
    },

    /* ---------------------------------------------------------------- dates */

    DATE: function (a) { return dateSerial(toNum(a[0]), toNum(a[1]), toNum(a[2])); },
    TIME: function (a) {
      return ((toNum(a[0]) * 3600) + (toNum(a[1]) * 60) + toNum(a[2])) / 86400 % 1;
    },
    DATEVALUE: function (a) {
      var s = parseDateText(toStr(a[0]));
      if (s === null) throw ERR.value;
      return s;
    },
    TIMEVALUE: function (a) {
      var f = parseTimeText(toStr(a[0]));
      if (f === null) throw ERR.value;
      return f;
    },
    YEAR: function (a) { return serialParts(toNum(a[0])).year; },
    MONTH: function (a) { return serialParts(toNum(a[0])).month; },
    DAY: function (a) { return serialParts(toNum(a[0])).day; },
    HOUR: function (a) { return serialParts(toNum(a[0])).hour; },
    MINUTE: function (a) { return serialParts(toNum(a[0])).minute; },
    SECOND: function (a) { return serialParts(toNum(a[0])).second; },
    WEEKDAY: function (a) {
      var w = serialParts(toNum(a[0])).weekday;      // 1 = Sunday
      var type = a.length > 1 ? Math.round(toNum(a[1])) : 1;
      if (type === 2) return w === 1 ? 7 : w - 1;    // 1 = Monday
      if (type === 3) return w === 1 ? 6 : w - 2;    // 0 = Monday
      return w;
    },
    WEEKNUM: function (a) {
      var s = Math.floor(toNum(a[0]));
      var type = a.length > 1 ? Math.round(toNum(a[1])) : 1;
      var p = serialParts(s);
      var jan1 = dateSerial(p.year, 1, 1);
      var startDow = serialParts(jan1).weekday;                  // 1 = Sunday
      var offset = type === 2 ? (startDow === 1 ? 6 : startDow - 2) : startDow - 1;
      return Math.floor((s - jan1 + offset) / 7) + 1;
    },
    DAYS: function (a) { return Math.floor(toNum(a[0])) - Math.floor(toNum(a[1])); },
    EDATE: function (a) {
      var p = serialParts(toNum(a[0]));
      var months = Math.round(toNum(a[1]));
      var target = p.month - 1 + months;
      var year = p.year + Math.floor(target / 12);
      var month = ((target % 12) + 12) % 12 + 1;
      // Clamp the day, so one month after 31 Jan is 28 Feb rather than 3 March.
      var last = serialParts(dateSerial(year, month + 1, 0)).day;
      return dateSerial(year, month, Math.min(p.day, last));
    },
    EOMONTH: function (a) {
      var p = serialParts(toNum(a[0]));
      var target = p.month - 1 + Math.round(toNum(a[1]));
      var year = p.year + Math.floor(target / 12);
      var month = ((target % 12) + 12) % 12 + 1;
      return dateSerial(year, month + 1, 0);       // day 0 of the next month
    },
    DATEDIF: function (a) {
      var s = Math.floor(toNum(a[0]));
      var e = Math.floor(toNum(a[1]));
      var unit = toStr(a[2]).toUpperCase();
      if (e < s) throw ERR.num;
      var A = serialParts(s);
      var B = serialParts(e);
      var months = (B.year - A.year) * 12 + (B.month - A.month) - (B.day < A.day ? 1 : 0);
      switch (unit) {
        case 'D': return e - s;
        case 'M': return months;
        case 'Y': return Math.floor(months / 12);
        case 'MD': return B.day >= A.day ? B.day - A.day
          : B.day + serialParts(dateSerial(B.year, B.month, 0)).day - A.day;
        case 'YM': return months % 12;
        case 'YD': return e - dateSerial(A.year + Math.floor(months / 12), A.month, A.day);
        default: throw ERR.value;
      }
    },
    NETWORKDAYS: function (a) {
      var s = Math.floor(toNum(a[0]));
      var e = Math.floor(toNum(a[1]));
      var step = e >= s ? 1 : -1;
      var holidays = a.length > 2 ? numbers([a[2]]).map(Math.floor) : [];
      var count = 0;
      for (var d = s; step > 0 ? d <= e : d >= e; d += step) {
        var w = serialParts(d).weekday;
        if (w === 1 || w === 7) continue;
        if (holidays.indexOf(d) >= 0) continue;
        count++;
      }
      return count * step;
    },
    WORKDAY: function (a) {
      var d = Math.floor(toNum(a[0]));
      var left = Math.round(toNum(a[1]));
      var holidays = a.length > 2 ? numbers([a[2]]).map(Math.floor) : [];
      var step = left >= 0 ? 1 : -1;
      left = Math.abs(left);
      while (left > 0) {
        d += step;
        var w = serialParts(d).weekday;
        if (w === 1 || w === 7) continue;
        if (holidays.indexOf(d) >= 0) continue;
        left--;
      }
      return d;
    },

    /* ----------------------------------------------------------- more maths */

    LN: function (a) { var n = toNum(a[0]); if (n <= 0) throw ERR.num; return Math.log(n); },
    LOG: function (a) {
      var n = toNum(a[0]);
      var base = a.length > 1 ? toNum(a[1]) : 10;
      if (n <= 0 || base <= 0 || base === 1) throw ERR.num;
      return Math.log(n) / Math.log(base);
    },
    LOG10: function (a) { var n = toNum(a[0]); if (n <= 0) throw ERR.num; return Math.log10(n); },
    EXP: function (a) { return Math.exp(toNum(a[0])); },
    PI: function () { return Math.PI; },
    SIN: function (a) { return Math.sin(toNum(a[0])); },
    COS: function (a) { return Math.cos(toNum(a[0])); },
    TAN: function (a) { return Math.tan(toNum(a[0])); },
    ASIN: function (a) { var n = toNum(a[0]); if (n < -1 || n > 1) throw ERR.num; return Math.asin(n); },
    ACOS: function (a) { var n = toNum(a[0]); if (n < -1 || n > 1) throw ERR.num; return Math.acos(n); },
    ATAN: function (a) { return Math.atan(toNum(a[0])); },
    ATAN2: function (a) { return Math.atan2(toNum(a[1]), toNum(a[0])); },   // x, y order
    DEGREES: function (a) { return toNum(a[0]) * 180 / Math.PI; },
    RADIANS: function (a) { return toNum(a[0]) * Math.PI / 180; },
    SIGN: function (a) { var n = toNum(a[0]); return n > 0 ? 1 : n < 0 ? -1 : 0; },
    TRUNC: function (a) {
      var f = Math.pow(10, a.length > 1 ? Math.round(toNum(a[1])) : 0);
      var n = toNum(a[0]) * f;
      return (n < 0 ? Math.ceil(n) : Math.floor(n)) / f;
    },
    QUOTIENT: function (a) {
      var d = toNum(a[1]);
      if (!d) throw ERR.div0;
      var q = toNum(a[0]) / d;
      return q < 0 ? Math.ceil(q) : Math.floor(q);
    },
    EVEN: function (a) {
      var n = toNum(a[0]);
      var up = Math.ceil(Math.abs(n) / 2) * 2;
      return n < 0 ? -up : up;
    },
    ODD: function (a) {
      var n = toNum(a[0]);
      var m = Math.ceil(Math.abs(n));
      if (m % 2 === 0) m += 1;
      if (m === 0) m = 1;
      return n < 0 ? -m : m;
    },
    MROUND: function (a) {
      var step = toNum(a[1]);
      if (!step) return 0;
      return Math.round(toNum(a[0]) / step) * step;
    },
    FACT: function (a) {
      var n = Math.floor(toNum(a[0]));
      if (n < 0 || n > 170) throw ERR.num;
      var out = 1;
      for (var i = 2; i <= n; i++) out *= i;
      return out;
    },
    COMBIN: function (a) {
      var n = Math.floor(toNum(a[0]));
      var k = Math.floor(toNum(a[1]));
      if (k < 0 || n < k) throw ERR.num;
      var out = 1;
      for (var i = 1; i <= k; i++) out = out * (n - k + i) / i;
      return Math.round(out);
    },
    GCD: function (a) {
      var n = numbers(a).map(function (x) { return Math.floor(Math.abs(x)); });
      if (!n.length) throw ERR.num;
      return n.reduce(gcd2);
    },
    LCM: function (a) {
      var n = numbers(a).map(function (x) { return Math.floor(Math.abs(x)); });
      if (!n.length) throw ERR.num;
      return n.reduce(function (x, y) { return !x || !y ? 0 : Math.abs(x * y) / gcd2(x, y); });
    },
    RAND: function () { return Math.random(); },
    RANDBETWEEN: function (a) {
      var lo = Math.ceil(toNum(a[0]));
      var hi = Math.floor(toNum(a[1]));
      if (hi < lo) throw ERR.num;
      return lo + Math.floor(Math.random() * (hi - lo + 1));
    },
    SUMSQ: function (a) {
      return numbers(a).reduce(function (acc, x) { return acc + x * x; }, 0);
    },
    /** SUMPRODUCT multiplies the arrays position by position, then adds. */
    SUMPRODUCT: function (a) {
      var lines = a.map(vector);
      if (!lines.length) return 0;
      var n = lines[0].length;
      if (lines.some(function (l) { return l.length !== n; })) throw ERR.value;
      var total = 0;
      for (var i = 0; i < n; i++) {
        var prod = 1;
        for (var j = 0; j < lines.length; j++) {
          var v = lines[j][i];
          var num = typeof v === 'boolean' ? (v ? 1 : 0) : Number(v);
          prod *= isNaN(num) || v === '' || v === null || v === undefined ? 0 : num;
        }
        total += prod;
      }
      return total;
    },

    /* ------------------------------------------------------------ statistics */

    VAR: function (a) {
      var n = numbers(a);
      if (n.length < 2) throw ERR.div0;
      var mean = n.reduce(function (x, y) { return x + y; }, 0) / n.length;
      return n.reduce(function (acc, x) { return acc + (x - mean) * (x - mean); }, 0) / (n.length - 1);
    },
    VARP: function (a) {
      var n = numbers(a);
      if (!n.length) throw ERR.div0;
      var mean = n.reduce(function (x, y) { return x + y; }, 0) / n.length;
      return n.reduce(function (acc, x) { return acc + (x - mean) * (x - mean); }, 0) / n.length;
    },
    STDEVP: function (a) { return Math.sqrt(FNS.VARP(a)); },
    AVERAGEA: function (a) {
      var all = flat(a).filter(function (v) { return v !== '' && v !== null && v !== undefined; });
      if (!all.length) throw ERR.div0;
      var total = all.reduce(function (acc, v) {
        if (typeof v === 'number') return acc + v;
        if (typeof v === 'boolean') return acc + (v ? 1 : 0);
        var n = Number(v);
        return acc + (isNaN(n) ? 0 : n);
      }, 0);
      return total / all.length;
    },
    MODE: function (a) {
      var n = numbers(a);
      var seen = {};
      var best = null;
      var bestCount = 1;
      n.forEach(function (x) {
        seen[x] = (seen[x] || 0) + 1;
        if (seen[x] > bestCount) { bestCount = seen[x]; best = x; }
      });
      if (best === null) throw ERR.na;
      return best;
    },
    LARGE: function (a) {
      var n = sortedNums([a[0]]);
      var k = Math.round(toNum(a[1]));
      if (k < 1 || k > n.length) throw ERR.num;
      return n[n.length - k];
    },
    SMALL: function (a) {
      var n = sortedNums([a[0]]);
      var k = Math.round(toNum(a[1]));
      if (k < 1 || k > n.length) throw ERR.num;
      return n[k - 1];
    },
    RANK: function (a) {
      var target = toNum(a[0]);
      var n = sortedNums([a[1]]);
      var ascending = a.length > 2 && toBool(a[2]);
      var idx = ascending ? n.indexOf(target) : n.lastIndexOf(target);
      if (idx < 0) throw ERR.na;
      return ascending ? idx + 1 : n.length - idx;
    },
    PERCENTILE: function (a) { return percentileOf(sortedNums([a[0]]), toNum(a[1])); },
    QUARTILE: function (a) {
      var q = Math.round(toNum(a[1]));
      if (q < 0 || q > 4) throw ERR.num;
      return percentileOf(sortedNums([a[0]]), q / 4);
    },
    /** SUBTOTAL(code, range): 1 average, 4 max, 5 min, 9 sum, 3 counta, 2 count. */
    SUBTOTAL: function (a) {
      var code = Math.round(toNum(a[0])) % 100;
      var rest = a.slice(1);
      switch (code) {
        case 1: return FNS.AVERAGE(rest);
        case 2: return FNS.COUNT(rest);
        case 3: return FNS.COUNTA(rest);
        case 4: return FNS.MAX(rest);
        case 5: return FNS.MIN(rest);
        case 6: return FNS.PRODUCT(rest);
        case 7: return FNS.STDEV(rest);
        case 8: return FNS.STDEVP(rest);
        case 9: return FNS.SUM(rest);
        case 10: return FNS.VAR(rest);
        case 11: return FNS.VARP(rest);
        default: throw ERR.value;
      }
    },

    /* ------------------------------------------------- multi-criteria maths */

    SUMIFS: function (a) { return pickNumbers(a[0], matchIndices(a, 1))
      .reduce(function (x, y) { return x + y; }, 0); },
    COUNTIFS: function (a) { return matchIndices(a, 0).length; },
    AVERAGEIFS: function (a) {
      var picked = pickNumbers(a[0], matchIndices(a, 1));
      if (!picked.length) throw ERR.div0;
      return picked.reduce(function (x, y) { return x + y; }, 0) / picked.length;
    },
    MAXIFS: function (a) {
      var picked = pickNumbers(a[0], matchIndices(a, 1));
      return picked.length ? Math.max.apply(null, picked) : 0;
    },
    MINIFS: function (a) {
      var picked = pickNumbers(a[0], matchIndices(a, 1));
      return picked.length ? Math.min.apply(null, picked) : 0;
    },

    /* ------------------------------------------------------------ more text */

    FIND: function (a) {
      var needle = toStr(a[0]);
      var hay = toStr(a[1]);
      var from = a.length > 2 ? Math.round(toNum(a[2])) - 1 : 0;
      var at = hay.indexOf(needle, Math.max(0, from));
      if (at < 0) throw ERR.value;
      return at + 1;
    },
    SEARCH: function (a) {
      var pattern = toStr(a[0]);
      var hay = toStr(a[1]);
      var from = a.length > 2 ? Math.round(toNum(a[2])) - 1 : 0;
      if (/[*?]/.test(pattern)) {
        // SEARCH is the one that understands wildcards; FIND is literal.
        var body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '[\\s\\S]*').replace(/\?/g, '[\\s\\S]');
        var m = hay.slice(Math.max(0, from)).match(new RegExp(body, 'i'));
        if (!m) throw ERR.value;
        return Math.max(0, from) + m.index + 1;
      }
      var at = hay.toLowerCase().indexOf(pattern.toLowerCase(), Math.max(0, from));
      if (at < 0) throw ERR.value;
      return at + 1;
    },
    REPLACE: function (a) {
      var s = toStr(a[0]);
      var start = Math.max(1, Math.round(toNum(a[1]))) - 1;
      var len = Math.max(0, Math.round(toNum(a[2])));
      return s.slice(0, start) + toStr(a[3]) + s.slice(start + len);
    },
    REPT: function (a) {
      var n = Math.max(0, Math.round(toNum(a[1])));
      var s = toStr(a[0]);
      if (s.length * n > 32767) throw ERR.value;
      return s.repeat(n);
    },
    PROPER: function (a) {
      return toStr(a[0]).replace(/(^|[^A-Za-z'])([a-z])/g, function (_m, pre, ch) {
        return pre + ch.toUpperCase();
      }).replace(/([A-Za-z])([A-Z]+)/g, function (_m, h, t) { return h + t.toLowerCase(); });
    },
    TEXTJOIN: function (a) {
      var delim = toStr(a[0]);
      var skipEmpty = toBool(a[1]);
      var parts = flat(a.slice(2)).map(function (v) {
        return v === null || v === undefined ? '' : (typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));
      });
      if (skipEmpty) parts = parts.filter(function (s) { return s !== ''; });
      return parts.join(delim);
    },
    CHAR: function (a) {
      var n = Math.round(toNum(a[0]));
      if (n < 1 || n > 255) throw ERR.value;
      return String.fromCharCode(n);
    },
    CODE: function (a) {
      var s = toStr(a[0]);
      if (!s) throw ERR.value;
      return s.charCodeAt(0);
    },
    UNICHAR: function (a) {
      var n = Math.round(toNum(a[0]));
      if (n < 1 || n > 0x10ffff) throw ERR.value;
      return String.fromCodePoint(n);
    },
    UNICODE: function (a) {
      var s = toStr(a[0]);
      if (!s) throw ERR.value;
      return s.codePointAt(0);
    },
    EXACT: function (a) { return toStr(a[0]) === toStr(a[1]); },
    CLEAN: function (a) {
      // eslint-disable-next-line no-control-regex
      return toStr(a[0]).replace(/[\u0000-\u001f\u007f]/g, '');
    },
    T: function (a) { var v = first(a[0]); return typeof v === 'string' && !isErr(v) ? v : ''; },
    N: function (a) {
      var v = first(a[0]);
      if (typeof v === 'number') return v;
      if (typeof v === 'boolean') return v ? 1 : 0;
      return 0;
    },

    /* ----------------------------------------------------------- more logic */

    XOR: function (a) {
      return flat(a).filter(function (v) { return toBool(v); }).length % 2 === 1;
    },
    TRUE: function () { return true; },
    FALSE: function () { return false; },
    NA: function () { return ERR.na; },

    /* ------------------------------------------------------------- about it */

    ISBLANK: function (a) {
      var v = first(a[0]);
      return v === '' || v === null || v === undefined;
    },
    ISNUMBER: function (a) { return typeof first(a[0]) === 'number'; },
    ISTEXT: function (a) {
      var v = first(a[0]);
      return typeof v === 'string' && v !== '' && !isErr(v);
    },
    ISNONTEXT: function (a) { return !FNS.ISTEXT(a); },
    ISLOGICAL: function (a) { return typeof first(a[0]) === 'boolean'; },
    ISEVEN: function (a) { return Math.floor(Math.abs(toNum(a[0]))) % 2 === 0; },
    ISODD: function (a) { return Math.floor(Math.abs(toNum(a[0]))) % 2 === 1; },
    TYPE: function (a) {
      var v = first(a[0]);
      if (typeof v === 'number') return 1;
      if (typeof v === 'boolean') return 4;
      if (isErr(v)) return 16;
      if (Array.isArray(a[0])) return 64;
      return 2;
    },

    /* --------------------------------------------------------- more lookup */

    /** LOOKUP(needle, vector, [result]): the old two-argument form. */
    LOOKUP: function (a) {
      var needle = first(a[0]);
      var line = vector(a[1]);
      var result = a.length > 2 ? vector(a[2]) : line;
      var best = -1;
      for (var i = 0; i < line.length; i++) {
        var c = compareValues(line[i], needle);
        if (c === 0) { best = i; break; }
        if (c < 0) best = i;
      }
      if (best < 0 || best >= result.length) throw ERR.na;
      return result[best];
    },
    /** XLOOKUP(needle, lookupRange, resultRange, [ifMissing]). */
    XLOOKUP: function (a) {
      var needle = first(a[0]);
      var keys = vector(a[1]);
      var vals = vector(a[2]);
      for (var i = 0; i < keys.length; i++) {
        if (sameValue(keys[i], needle)) {
          return i < vals.length ? vals[i] : ERR.ref;
        }
      }
      if (a.length > 3) return a[3];
      throw ERR.na;
    },

    /* ------------------------------------------------------------- finance

       Sign convention is Excel's: money paid out is negative. `type` is 0 for
       payments at the end of a period and 1 for the beginning. */

    PMT: function (a) {
      var r = toNum(a[0]);
      var n = toNum(a[1]);
      var pv = toNum(a[2]);
      var fv = a.length > 3 ? toNum(a[3]) : 0;
      var type = a.length > 4 ? toNum(a[4]) : 0;
      if (!n) throw ERR.num;
      if (!r) return -(pv + fv) / n;
      var g = Math.pow(1 + r, n);
      return -(pv * g + fv) * r / ((g - 1) * (1 + r * type));
    },
    FV: function (a) {
      var r = toNum(a[0]);
      var n = toNum(a[1]);
      var pmt = toNum(a[2]);
      var pv = a.length > 3 ? toNum(a[3]) : 0;
      var type = a.length > 4 ? toNum(a[4]) : 0;
      if (!r) return -(pv + pmt * n);
      var g = Math.pow(1 + r, n);
      return -(pv * g + pmt * (1 + r * type) * (g - 1) / r);
    },
    PV: function (a) {
      var r = toNum(a[0]);
      var n = toNum(a[1]);
      var pmt = toNum(a[2]);
      var fv = a.length > 3 ? toNum(a[3]) : 0;
      var type = a.length > 4 ? toNum(a[4]) : 0;
      if (!r) return -(fv + pmt * n);
      var g = Math.pow(1 + r, n);
      return -(fv + pmt * (1 + r * type) * (g - 1) / r) / g;
    },
    NPER: function (a) {
      var r = toNum(a[0]);
      var pmt = toNum(a[1]);
      var pv = toNum(a[2]);
      var fv = a.length > 3 ? toNum(a[3]) : 0;
      var type = a.length > 4 ? toNum(a[4]) : 0;
      if (!r) {
        if (!pmt) throw ERR.num;
        return -(pv + fv) / pmt;
      }
      var adj = pmt * (1 + r * type);
      var top = adj - fv * r;
      var bottom = adj + pv * r;
      if (top / bottom <= 0) throw ERR.num;
      return Math.log(top / bottom) / Math.log(1 + r);
    },
    NPV: function (a) {
      var r = toNum(a[0]);
      var flows = numbers(a.slice(1));
      return flows.reduce(function (acc, v, i) {
        return acc + v / Math.pow(1 + r, i + 1);
      }, 0);
    }
  };

  /* Value comparison shared by the lookup family. Numbers compare as numbers,
     everything else case-insensitively as text, and the two never mix -- a
     spreadsheet that thinks "10" < "9" is right about text and wrong about the
     column of numbers someone imported as text, so the coercion is explicit. */
  function sameValue(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a === b;
    if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
    return String(a == null ? '' : a).toLowerCase() === String(b == null ? '' : b).toLowerCase();
  }
  function compareValues(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
    var sa = String(a == null ? '' : a).toLowerCase();
    var sb = String(b == null ? '' : b).toLowerCase();
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  /* ---------------------------------------------------- lazy and reference

     Functions that need the expression rather than its value. Each takes the
     call node and the evaluator's own walk(), so it decides what to evaluate.
  */

  /** Evaluate, turning a thrown error value into a returned one. */
  function tryWalk(node, walk) {
    if (node === undefined) return undefined;
    try { return walk(node); } catch (e) {
      var code = typeof e === 'string' ? e : (e && e.message) || ERR.value;
      return isErr(code) ? code : ERR.value;
    }
  }

  /** The reference or rectangle a node names, without reading the cells. */
  function refShape(node) {
    if (!node) return null;
    if (node.n === 'ref') {
      var p = parseRef(node.v);
      return p ? { row: p.row + 1, col: p.col + 1, rows: 1, cols: 1 } : null;
    }
    if (node.n === 'range') {
      var A = parseRef(node.a);
      var B = parseRef(node.b);
      if (!A || !B) return null;
      return {
        row: Math.min(A.row, B.row) + 1,
        col: Math.min(A.col, B.col) + 1,
        rows: Math.abs(A.row - B.row) + 1,
        cols: Math.abs(A.col - B.col) + 1
      };
    }
    return null;
  }

  var LAZY = {
    IF: function (node, walk) {
      var cond = toBool(walk(node.args[0]));
      var branch = cond ? node.args[1] : node.args[2];
      if (branch === undefined) return cond;
      return walk(branch);
    },
    IFERROR: function (node, walk) {
      var v = tryWalk(node.args[0], walk);
      if (!isErr(v)) return v;
      return node.args[1] === undefined ? '' : walk(node.args[1]);
    },
    IFNA: function (node, walk) {
      var v = tryWalk(node.args[0], walk);
      return v === ERR.na ? (node.args[1] === undefined ? '' : walk(node.args[1])) : v;
    },

    /* The IS* family asks whether something went wrong, so it must survive the
       thing going wrong. Evaluated eagerly they never got the chance: the throw
       from 1/0 escaped before the function was ever called. */
    ISERROR: function (node, walk) { return isErr(tryWalk(node.args[0], walk)); },
    ISERR: function (node, walk) {
      var v = tryWalk(node.args[0], walk);
      return isErr(v) && v !== ERR.na;
    },
    ISNA: function (node, walk) { return tryWalk(node.args[0], walk) === ERR.na; },

    IFS: function (node, walk) {
      for (var i = 0; i + 1 < node.args.length; i += 2) {
        if (toBool(walk(node.args[i]))) return walk(node.args[i + 1]);
      }
      return ERR.na;
    },
    SWITCH: function (node, walk) {
      var subject = walk(node.args[0]);
      var i = 1;
      for (; i + 1 < node.args.length; i += 2) {
        if (sameValue(walk(node.args[i]), subject)) return walk(node.args[i + 1]);
      }
      // An odd trailing argument is the default.
      return i < node.args.length ? walk(node.args[i]) : ERR.na;
    },
    CHOOSE: function (node, walk) {
      var n = Math.round(toNum(walk(node.args[0])));
      if (n < 1 || n >= node.args.length) throw ERR.value;
      return walk(node.args[n]);
    },

    /* Geometry of a reference, which is gone by the time it has been read. */
    ROW: function (node, walk) {
      var s = refShape(node.args[0]);
      if (node.args.length === 0) throw ERR.value;   // ROW() needs a cell context
      return s ? s.row : ERR.ref;
    },
    COLUMN: function (node) {
      var s = refShape(node.args[0]);
      if (node.args.length === 0) throw ERR.value;
      return s ? s.col : ERR.ref;
    },
    ROWS: function (node) {
      var s = refShape(node.args[0]);
      return s ? s.rows : ERR.ref;
    },
    COLUMNS: function (node) {
      var s = refShape(node.args[0]);
      return s ? s.cols : ERR.ref;
    }
  };

  /* --------------------------------------------- multi-criteria helpers --- */

  /**
   * Indices where every (range, criteria) pair matches. Ranges are flattened to
   * vectors and must all be the same length -- Excel requires the same shape and
   * silently wrong answers are the alternative.
   */
  function matchIndices(args, from) {
    var tests = [];
    for (var i = from; i + 1 < args.length; i += 2) {
      tests.push({ line: vector(args[i]), test: matcher(first(args[i + 1])) });
    }
    if (!tests.length) throw ERR.value;
    var n = tests[0].line.length;
    if (tests.some(function (t) { return t.line.length !== n; })) throw ERR.value;
    var out = [];
    for (var k = 0; k < n; k++) {
      var all = true;
      for (var j = 0; j < tests.length; j++) {
        if (!tests[j].test(tests[j].line[k])) { all = false; break; }
      }
      if (all) out.push(k);
    }
    return out;
  }

  /** The numbers of `range` at the given indices. */
  function pickNumbers(range, idx) {
    var line = vector(range);
    var out = [];
    idx.forEach(function (k) {
      var n = typeof line[k] === 'number' ? line[k] : Number(line[k]);
      if (line[k] !== '' && line[k] !== null && line[k] !== undefined && !isNaN(n)) out.push(n);
    });
    return out;
  }

  function sortedNums(values) {
    return numbers(values).sort(function (a, b) { return a - b; });
  }

  /** Linear-interpolation percentile, the one PERCENTILE and QUARTILE share. */
  function percentileOf(nums, p) {
    if (!nums.length) throw ERR.num;
    if (p < 0 || p > 1) throw ERR.num;
    var pos = (nums.length - 1) * p;
    var lo = Math.floor(pos);
    var hi = Math.ceil(pos);
    if (lo === hi) return nums[lo];
    return nums[lo] + (nums[hi] - nums[lo]) * (pos - lo);
  }

  function gcd2(a, b) { while (b) { var t = a % b; a = b; b = t; } return Math.abs(a); }

  /* ------------------------------------------------------------ evaluator */

  /**
   * `getCell(qualifiedRef)` returns the *computed* value of another cell. The
   * caller owns ordering and cycle detection, which is why recalc() below exists.
   *
   * `home` is the sheet this formula lives on, so an unqualified reference can be
   * resolved. Omitting it means the single-sheet case, where a bare reference is
   * the only kind there is.
   */
  function evaluate(ast, getCell, home) {
    function walk(node) {
      switch (node.n) {
        case 'num': return node.v;
        case 'str': return node.v;
        case 'bool': return node.v;
        case 'ref': {
          var v = getCell(qualify(node.sheet === undefined ? home : node.sheet, node.v));
          return v === undefined ? '' : v;
        }
        /* A rectangle, not a flat list. flat() still walks into it, so every
           aggregate keeps working unchanged, but the lookup functions can now see
           rows and columns instead of guessing at a stride. */
        case 'range': {
          var grid = rangeGrid(node.a, node.b);
          if (!grid) throw ERR.ref;
          var on = node.sheet === undefined ? home : node.sheet;
          return grid.map(function (row) {
            return row.map(function (r) {
              var cv = getCell(qualify(on, r));
              return cv === undefined ? '' : cv;
            });
          });
        }
        case 'err': return node.v;
        case 'neg': return -toNum(walk(node.a));
        case 'name': throw ERR.name;
        /* Most functions take values. A few have to take expressions instead --
           either because they must not evaluate a branch they are about to
           discard, or because they are asking about a reference rather than
           about what is in it. Those live in LAZY, as a table rather than as a
           chain of special cases inside this switch. */
        case 'call': {
          var lazy = LAZY[node.name];
          if (lazy) return lazy(node, walk);
          var fn = FNS[node.name];
          if (!fn) throw ERR.name;
          return fn(node.args.map(walk));
        }
        case 'bin': {
          var a = walk(node.a);
          var b = walk(node.b);
          if (isErr(a)) throw a;
          if (isErr(b)) throw b;
          switch (node.op) {
            case '+': return toNum(a) + toNum(b);
            case '-': return toNum(a) - toNum(b);
            case '*': return toNum(a) * toNum(b);
            case '/': {
              var d = toNum(b);
              if (d === 0) throw ERR.div0;
              return toNum(a) / d;
            }
            case '^': return Math.pow(toNum(a), toNum(b));
            case '&': return toStr(a) + toStr(b);
            case '=': return looseEq(a, b);
            case '<>': return !looseEq(a, b);
            case '<': return cmp(a, b) < 0;
            case '>': return cmp(a, b) > 0;
            case '<=': return cmp(a, b) <= 0;
            case '>=': return cmp(a, b) >= 0;
            default: throw ERR.value;
          }
        }
        default: throw ERR.value;
      }
    }

    function looseEq(a, b) {
      if (typeof a === 'number' || typeof b === 'number') {
        var na = Number(a);
        var nb = Number(b);
        if (!isNaN(na) && !isNaN(nb)) return na === nb;
      }
      return String(a).toLowerCase() === String(b).toLowerCase();
    }
    function cmp(a, b) {
      var na = Number(a);
      var nb = Number(b);
      if (!isNaN(na) && !isNaN(nb) && a !== '' && b !== '') return na - nb;
      var sa = String(a).toLowerCase();
      var sb = String(b).toLowerCase();
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    }

    return walk(ast);
  }

  /* ------------------------------------------------------------ recalc */

  /**
   * Recompute a whole workbook.
   *
   * book: { '工作表1': { A1: { v } | { f: '=...' } }, ... }
   *   ->  { values: { sheet: { ref: value } }, errors: same shape, order, cyclic }
   *
   * One pass over every sheet at once, not a pass per sheet. A formula on one
   * sheet may read another, so the dependency order is a property of the book:
   * recomputing sheet by sheet would evaluate a cell before the thing it reads
   * whenever the two live on different sheets, and the answer would be stale by
   * exactly one recalculation -- the kind of wrong that looks right until someone
   * checks a total by hand.
   *
   * Internally every cell is keyed `sheet!ref`, with the empty sheet name giving
   * a bare reference, so the single-sheet case is the same code and the same keys
   * it always used.
   */
  function recalcBook(book) {
    var values = {};      // qualified -> value
    var errors = {};
    var parsed = {};
    var deps = {};
    var homeOf = {};

    Object.keys(book).forEach(function (sheet) {
      var cells = book[sheet] || {};
      Object.keys(cells).forEach(function (ref) {
        var key = qualify(sheet, ref);
        var cell = cells[ref];
        homeOf[key] = sheet;
        if (cell && typeof cell === 'object' && cell.f) {
          try {
            var ast = parse(String(cell.f).replace(/^=/, ''));
            parsed[key] = ast;
            // Self-references are kept: =A1+1 written into A1 is a cycle, and
            // filtering it out here would let it quietly evaluate to 1.
            deps[key] = refsOf(ast, [], sheet);
          } catch (e) {
            parsed[key] = null;
            errors[key] = e.message || String(e);
            values[key] = ERR.value;
          }
        } else {
          values[key] = cell && typeof cell === 'object' ? cell.v : cell;
          if (values[key] === undefined) values[key] = '';
        }
      });
    });

    // Depth-first topological sort with an on-stack marker for cycles.
    var state = {};      // ref -> 'visiting' | 'done'
    var order = [];
    var cyclic = {};

    function visit(ref, stack) {
      if (state[ref] === 'done') return;
      if (state[ref] === 'visiting') {
        // Reaching a cell that is already on the stack closes a loop, so every
        // cell currently on the stack participates in it.
        stack.forEach(function (r) { cyclic[r] = true; });
        cyclic[ref] = true;
        return;
      }
      if (!parsed[ref]) { state[ref] = 'done'; return; }
      state[ref] = 'visiting';
      stack.push(ref);
      (deps[ref] || []).forEach(function (d) {
        if (parsed[d]) visit(d, stack);
      });
      stack.pop();
      state[ref] = 'done';
      order.push(ref);
    }

    Object.keys(parsed).forEach(function (ref) { visit(ref, []); });

    Object.keys(cyclic).forEach(function (ref) {
      values[ref] = ERR.cycle;
      errors[ref] = '循環參照';
    });

    order.forEach(function (ref) {
      if (cyclic[ref] || !parsed[ref]) return;
      try {
        var v = evaluate(parsed[ref], function (r) {
          if (cyclic[r]) return ERR.cycle;
          return values[r];
        }, homeOf[ref]);
        // A formula whose result is a rectangle shows its top-left cell, the way
        // a spreadsheet without dynamic arrays does.
        var one = Array.isArray(v) ? flat(v)[0] : v;
        values[ref] = one === undefined ? '' : one;
      } catch (e) {
        var msg = typeof e === 'string' ? e : (e && e.message) || ERR.value;
        values[ref] = isErr(msg) ? msg : ERR.value;
        errors[ref] = typeof e === 'string' ? e : (e && e.message) || '計算失敗';
      }
    });

    // Split back out per sheet, which is the shape a grid can render.
    var bySheet = { values: {}, errors: {} };
    Object.keys(book).forEach(function (sheet) {
      bySheet.values[sheet] = {};
      bySheet.errors[sheet] = {};
    });
    Object.keys(values).forEach(function (key) {
      var cut = key.lastIndexOf('!');
      var sheet = cut < 0 ? '' : key.slice(0, cut);
      var ref = cut < 0 ? key : key.slice(cut + 1);
      if (!bySheet.values[sheet]) { bySheet.values[sheet] = {}; bySheet.errors[sheet] = {}; }
      bySheet.values[sheet][ref] = values[key];
      if (errors[key]) bySheet.errors[sheet][ref] = errors[key];
    });

    return {
      values: bySheet.values, errors: bySheet.errors,
      order: order, cyclic: Object.keys(cyclic)
    };
  }

  /**
   * One sheet, in the shape the grid has always used. A workbook of one, with the
   * empty name -- so its keys are bare references and nothing downstream has to
   * know that sheets exist.
   */
  function recalc(cells) {
    var out = recalcBook({ '': cells || {} });
    return {
      values: out.values[''] || {},
      errors: out.errors[''] || {},
      order: out.order,
      cyclic: out.cyclic
    };
  }

  AIOS.formula = {
    parse: parse,
    tokenize: tokenize,
    evaluate: evaluate,
    recalc: recalc,
    recalcBook: recalcBook,
    qualify: qualify,
    refsOf: refsOf,
    expandRange: expandRange,
    rangeGrid: rangeGrid,
    colToIndex: colToIndex,
    indexToCol: indexToCol,
    parseRef: parseRef,
    makeRef: makeRef,
    offsetRef: offsetRef,
    translate: translate,
    reshape: reshape,
    isErr: isErr,
    ERR: ERR,
    /* The lazy ones are functions too. Leaving them out of this list would hide
       IFS, CHOOSE and the IS* family from the model, which reads it as the
       definitive statement of what it may write into a cell. */
    functions: Object.keys(FNS).concat(Object.keys(LAZY).filter(function (k) {
      return !FNS[k];
    })).sort(),

    /* Dates and display, exported because the grid, the exporter and the TEXT
       function have to agree. Two implementations of "what does this number look
       like" is how a cell, its .xlsx and its PDF end up saying three things. */
    format: format,
    isDateCode: isDateCode,
    dateSerial: dateSerial,
    serialParts: serialParts,
    todaySerial: todaySerial,
    nowSerial: nowSerial,
    parseDateText: parseDateText,
    parseTimeText: parseTimeText,
    serialToUtc: serialToUtc,
    utcToSerial: utcToSerial
  };
})();
