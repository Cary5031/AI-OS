'use strict';

/* ===========================================================================
   AI-OS // charts
   ---------------------------------------------------------------------------
   One chart model for the three Office programs. The spreadsheet binds a chart
   to a range and re-reads it on every recalculation; the word processor keeps
   a chart as a block with its data inside; the deck keeps one as an object on
   the slide. All three hold the same shape:

     { type, title, categories: [...], series: [{ name, values: [...], colour }],
       legend, labels, numFmt, xTitle, yTitle, source }

   so a chart copied from one program is the very object pasted into another,
   and the OOXML writers in main see one vocabulary whichever file they write.

   THE DRAWING IS SVG, BUILT AS DOM, STYLED INLINE

   Every destination the chart reaches is a serialisation of the editor's DOM:
   the PDF is printed from it under a stylesheet that is not os.css, the deck's
   .html export carries no stylesheet of ours, and the thumbnail in the rail is
   the same builder at 170px. An <svg> with a viewBox scales to all of them
   without being rebuilt, and an inline attribute travels where a class does not.
   Nothing here measures the page: layout is arithmetic on the viewBox, so the
   same spec draws the same picture in a detached node as on screen.

   ONE DRAWING, TWO SURFACES

   The same serialised chart is read on a dark page in the editor and on white
   paper in the PDF, and the deck's .html export is dark while its .pdf is not.
   So the ink is `currentColor` -- the host says what colour text is, on screen
   and in print -- and the series colours are CSS variables with the light
   palette as their fallback: os.css supplies the dark steps under a dark
   theme, the print stylesheet supplies nothing, and one DOM reads on both.
   Gaps between marks are unpainted geometry, never a stroke in some
   background colour that would be wrong on the other surface.

   THE DATA HALF RUNS IN MAIN TOO

   Reading a chart back out of .md or .docx has to rebuild categories and series
   from a table the same way the editors do, and the honest way to keep two
   copies of that rule from drifting is to have one copy. So the module is
   loadable both as a renderer script (AIOS.charts) and with require() from
   app/main -- the pure half works in either; render() needs a document.
   =========================================================================== */

/* global window, document, module */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null);
  } else {
    root.AIOS = root.AIOS || {};
    root.AIOS.charts = factory(root.AIOS);
  }
}(typeof window !== 'undefined' ? window : this, function (AIOS) {

  /* The engine is resolved when it is used, not when this file loads: in the
     renderer it is a global that exists by then; in main it does not exist and
     numbers are written plain. */
  function F() { return AIOS && AIOS.formula ? AIOS.formula : null; }
  function palette() { return AIOS && AIOS.palette ? AIOS.palette : null; }

  /* ------------------------------------------------------------- types */

  var TYPES = [
    { id: 'column', name: '直條圖', family: 'bar', stacked: false, horizontal: false },
    { id: 'stackedColumn', name: '堆疊直條圖', family: 'bar', stacked: true, horizontal: false },
    { id: 'bar', name: '橫條圖', family: 'bar', stacked: false, horizontal: true },
    { id: 'stackedBar', name: '堆疊橫條圖', family: 'bar', stacked: true, horizontal: true },
    { id: 'line', name: '折線圖', family: 'line', stacked: false, horizontal: false },
    { id: 'area', name: '區域圖', family: 'area', stacked: false, horizontal: false },
    { id: 'stackedArea', name: '堆疊區域圖', family: 'area', stacked: true, horizontal: false },
    { id: 'pie', name: '圓餅圖', family: 'pie', stacked: false, horizontal: false },
    { id: 'doughnut', name: '環圈圖', family: 'pie', stacked: false, horizontal: false, hole: true },
    { id: 'scatter', name: '散佈圖', family: 'scatter', stacked: false, horizontal: false }
  ];
  var TYPE_BY_ID = {};
  TYPES.forEach(function (t) { TYPE_BY_ID[t.id] = t; });

  function typeOf(id) { return TYPE_BY_ID[id] || TYPE_BY_ID.column; }

  /** A type id from an id or a Chinese name, or null. */
  function resolveType(value) {
    var v = String(value == null ? '' : value).trim();
    if (!v) return null;
    if (TYPE_BY_ID[v]) return v;
    var lower = v.toLowerCase();
    var hit = TYPES.find(function (t) {
      return t.id.toLowerCase() === lower || t.name === v || t.name.replace(/圖$/, '') === v;
    });
    return hit ? hit.id : null;
  }

  /** The same, but a name nobody has is refused rather than read as 直條圖. */
  function requireType(value) {
    var id = resolveType(value);
    if (!id) {
      throw new Error('不認得的圖表類型「' + value + '」；可用：' +
        TYPES.map(function (t) { return t.name + '（' + t.id + '）'; }).join('、'));
    }
    return id;
  }

  function typeName(id) { return typeOf(id).name; }

  /* ----------------------------------------------------------- colours */

  /* Eight hues in a fixed order, assigned in sequence and never cycled. The
     order is the colour-vision-safety mechanism: every adjacent pair keeps a
     measured distance under simulated protanopia and deuteranopia, on white
     (these) and on a dark surface (COLOURS_DARK, the same hues re-stepped).
     A ninth series does not get a generated ninth hue: a stack folds it into
     其他, anything else drops it and the caller says so. */
  var COLOURS = ['2A78D6', 'EB6834', '1BAF7A', 'EDA100', 'E87BA4', '008300', '4A3AA7', 'E34948'];
  var COLOURS_DARK = ['3987E5', 'D95926', '199E70', 'C98500', 'D55181', '008300', '9085E9', 'E66767'];
  var COLOUR_NAMES = ['藍', '橙', '青綠', '黃', '粉紅', '綠', '紫', '紅'];
  /* The de-emphasis grey: 其他, and nothing else. */
  var OTHER_COLOUR = '898781';
  /* Slots below 3:1 on white. Where a chart is exported without its tooltips,
     these get a direct label so the value is readable another way. */
  var FAINT_SLOTS = [2, 3, 4];

  var MAX_SERIES = 8;
  var SCATTER_SERIES = 3;      // past three, any two hues may sit side by side
  var MAX_POINTS = 500;
  var LEGENDS = ['bottom', 'right', 'none'];

  /** 'RRGGBB' from a hex with or without '#', a chart colour name or a palette name; null otherwise. */
  function hexOf(value) {
    if (value === undefined || value === null) return null;
    var s = String(value).trim();
    if (!s) return null;
    var m = /^#?([0-9a-fA-F]{6})$/.exec(s);
    if (m) return m[1].toUpperCase();
    var at = COLOUR_NAMES.indexOf(s);
    if (at >= 0) return COLOURS[at];
    var P = palette();
    if (P && P.hexOf) return P.hexOf(s);
    return null;
  }

  /** As hexOf, but a colour nobody has is an error the caller can show. */
  function requireColour(value, what) {
    if (value === undefined || value === null || value === '') return null;
    var hex = hexOf(value);
    if (!hex) {
      var P = palette();
      throw new Error('不認得的' + (what || '顏色') + '「' + value + '」；可用 #RRGGBB 或：' +
        COLOUR_NAMES.join('、') + (P && P.names ? '、' + P.names().join('、') : ''));
    }
    return hex;
  }

  function luminanceOf(hex) {
    var h = String(hex || '').replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return 1;
    function ch(i) {
      var c = parseInt(h.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
  }

  /** Ink that reads on a fill: the same threshold the document palette uses. */
  function inkOn(hex) {
    return luminanceOf(hex) > 0.184 ? '#0b1016' : '#ffffff';
  }

  /* ----------------------------------------------------------- numbers */

  /**
   * A number out of whatever a table cell holds, or null.
   *
   * Tables that arrive here were typed by people or read from files, so the
   * value column says `NT$1,234`, `12%`, `(500)` and `１２３` as often as it
   * says `1234`. Each of those is one number; refusing them would make the
   * first chart most people draw come out empty.
   */
  function toNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return isFinite(value) ? value : null;
    if (typeof value === 'boolean') return null;
    if (typeof value === 'object') return 'v' in value ? toNumber(value.v) : null;
    var s = String(value).trim();
    if (!s) return null;
    // Full-width digits and signs, as typed on a Chinese keyboard.
    s = s.replace(/[０-９]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 48); })
         .replace(/[，]/g, ',').replace(/[．]/g, '.').replace(/[－−–]/g, '-')
         .replace(/[％]/g, '%');
    var neg = false;
    var m = /^\((.*)\)$/.exec(s);
    if (m) { neg = true; s = m[1].trim(); }
    var pct = false;
    if (/%$/.test(s)) { pct = true; s = s.slice(0, -1).trim(); }
    s = s.replace(/^([-+]?)\s*(NT\$|US\$|HK\$|RMB|[$€£¥￥])\s*/i, '$1');
    s = s.replace(/,/g, '').replace(/\s+/g, '');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
    var n = Number(s);
    if (!isFinite(n)) return null;
    if (neg) n = -n;
    if (pct) n = n / 100;
    return n;
  }

  /* A cell may be a bare value or `{ v, text, label, numFmt }`: `v` decides
     whether it is a number, `text` is what a person sees (a date cell's raw
     value is a serial, its text is the date), `label` says the cell is a
     heading even when its value is numeric -- a column of dates is categories,
     not a series -- and `numFmt` is the format the cell was shown with. */
  function isCellObject(cell) {
    return !!cell && typeof cell === 'object' && !Array.isArray(cell);
  }
  function rawOf(cell) {
    return isCellObject(cell) ? cell.v : cell;
  }
  function textOf(cell) {
    if (cell === null || cell === undefined) return '';
    if (isCellObject(cell)) {
      if (cell.text !== undefined && cell.text !== null) return String(cell.text);
      return textOf(cell.v);
    }
    // A number used as a label (a year, a month) is written plain: 2023, not 2,023.
    if (typeof cell === 'number') return isFinite(cell) ? String(Math.round(cell * 1e6) / 1e6) : '';
    return String(cell);
  }
  function isBlank(cell) {
    var raw = rawOf(cell);
    return raw === null || raw === undefined || String(raw).trim() === '';
  }
  /* An error value is neither a label nor a number. */
  var ERROR_RE = /^#[A-Z0-9\/!?]+!?$/;
  function isLabel(cell) {
    if (isCellObject(cell) && cell.label) return true;
    var raw = rawOf(cell);
    if (raw === null || raw === undefined) return false;
    if (typeof raw === 'number' || typeof raw === 'boolean') return false;
    var s = String(raw).trim();
    if (s === '' || ERROR_RE.test(s)) return false;
    return toNumber(s) === null;
  }
  function isNumberCell(cell) {
    return !isBlank(cell) && !isLabel(cell) && toNumber(rawOf(cell)) !== null;
  }
  function isIntegerCell(cell) {
    var n = isNumberCell(cell) ? toNumber(rawOf(cell)) : null;
    return n !== null && Math.floor(n) === n;
  }

  /* ---------------------------------------------------------- from rows */

  var TOTAL_RE = /^\s*(合計|總計|小計|總和|總數|加總|合計數|total|sum|subtotal|grand total)\s*[:：]?\s*$/i;

  function nearly(a, b) {
    return Math.abs(a - b) <= Math.max(0.5, Math.abs(b) * 0.005);
  }

  /**
   * Categories and series out of a table.
   *
   * `rows` is a two-dimensional array of cells (see rawOf). Options:
   *
   *   seriesIn    'cols' (each column is a series), 'rows', or 'auto' (the
   *               default): the orientation with fewer series -- a table wider
   *               than it is tall runs its series along rows
   *   headerRow   true / false to say whether the first row is headings;
   *               undefined decides from the cells
   *   headerCol   the same for the first column
   *   omitTotals  true / false; undefined drops a 合計 row or column only when
   *               its numbers really are the sum of the others
   *
   * Heading detection, when not told: the first row is headings when every
   * non-blank cell after the corner is a label (or all are years) and there
   * are numbers below it; the first column is headings when any cell below the
   * corner is a label, when they are an increasing run of integers under a
   * labelled corner (months, years), or when the corner is blank under a
   * heading row. A row above the table holding only a title is skipped and
   * returned as `titleHint`.
   *
   * Returns { categories, series, layout: { headerRow, headerCol, seriesIn },
   *           corner, titleHint, numFmtHint, omitted, skipped }.
   * `omitted` names the totals that were left out, `skipped` the columns that
   * held no numbers -- the caller says both out loud, because a chart that
   * quietly lost a column looks complete.
   */
  function fromRows(rows, opts) {
    var o = opts || {};
    var grid = (Array.isArray(rows) ? rows : []).map(function (r) {
      return Array.isArray(r) ? r.slice() : [r];
    });
    var width = grid.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    grid.forEach(function (r) { while (r.length < width) r.push(null); });

    function rowBlank(r) { return grid[r].every(isBlank); }
    function colBlank(c) { return grid.every(function (row) { return isBlank(row[c]); }); }

    /* How far into the caller's own grid the used region starts. A spreadsheet
       turns this back into cell references, and a chart that points at the rows
       it did not draw is a chart that says something different in Excel from
       what it says here. */
    var padTop = 0;
    var padLeft = 0;

    // Blank rows and columns at the edges are the selection's slack, not data.
    while (grid.length && rowBlank(grid.length - 1)) grid.pop();
    while (grid.length && rowBlank(0)) { grid.shift(); padTop++; }
    while (width > 0 && colBlank(width - 1)) { grid.forEach(function (r) { r.pop(); }); width--; }
    while (width > 0 && colBlank(0)) { grid.forEach(function (r) { r.shift(); }); width--; padLeft++; }

    // A title sitting above the table: a label in the first column with
    // nothing beside it. Kept as a hint, not as a category.
    var titleHint = '';
    while (grid.length > 1 && width > 1 && isLabel(grid[0][0]) &&
           grid[0].slice(1).every(isBlank) && !grid[1].slice(1).every(isBlank)) {
      if (!titleHint) titleHint = textOf(grid[0][0]).trim();
      grid.shift();
      padTop++;
    }

    var R = grid.length;
    var C = width;
    var empty = {
      categories: [], series: [], layout: { headerRow: false, headerCol: false, seriesIn: 'cols' },
      corner: '', titleHint: titleHint, numFmtHint: '', omitted: [], skipped: []
    };
    if (!R || !C) return empty;

    function numericIn(r0, c0) {
      for (var r = r0; r < R; r++) for (var c = c0; c < C; c++) if (isNumberCell(grid[r][c])) return true;
      return false;
    }
    function allYears(cells) {
      return cells.length > 0 && cells.every(function (cell) {
        var n = isIntegerCell(cell) ? toNumber(rawOf(cell)) : null;
        return n !== null && n >= 1900 && n <= 2100;
      });
    }
    function nonDecreasingIntegers(cells) {
      if (!cells.length || !cells.every(isIntegerCell)) return false;
      for (var i = 1; i < cells.length; i++) {
        if (toNumber(rawOf(cells[i])) < toNumber(rawOf(cells[i - 1]))) return false;
      }
      return true;
    }

    var corner = grid[0][0];
    var rowLabels, colLabels;
    if (C === 1) {
      rowLabels = R > 1 && isLabel(corner) && numericIn(1, 0);
      colLabels = false;
    } else if (R === 1) {
      rowLabels = false;
      colLabels = isLabel(corner) && numericIn(0, 1);
    } else {
      var top = grid[0].slice(1).filter(function (c) { return !isBlank(c); });
      rowLabels = top.length > 0 && numericIn(1, 1) &&
        (top.every(isLabel) || (allYears(top) && !isNumberCell(corner)));
      var side = grid.slice(1).map(function (r) { return r[0]; }).filter(function (c) { return !isBlank(c); });
      colLabels = side.length > 0 && (
        side.some(isLabel) ||
        ((isLabel(corner) || isBlank(corner)) && nonDecreasingIntegers(side) && numericIn(1, 1)) ||
        (rowLabels && isBlank(corner)));
    }
    if (o.headerRow === true || o.headerRow === false) rowLabels = o.headerRow;
    if (o.headerCol === true || o.headerCol === false) colLabels = o.headerCol;

    var rowOff = rowLabels ? 1 : 0;
    var colOff = colLabels ? 1 : 0;
    var seriesIn = o.seriesIn === 'rows' ? 'rows' : o.seriesIn === 'cols' ? 'cols' : null;
    if (!seriesIn) {
      // The orientation with fewer series: a table wider than it is tall runs
      // its series along its rows.
      seriesIn = (C - colOff) > (R - rowOff) ? 'rows' : 'cols';
    }
    var cols = seriesIn === 'cols';
    var nSeries = Math.max(0, cols ? C - colOff : R - rowOff);
    var nPoints = Math.max(0, cols ? R - rowOff : C - colOff);

    var categories = [];
    var named = [];
    for (var i = 0; i < nPoints; i++) {
      var catCell = cols ? (colLabels ? grid[rowOff + i][0] : null)
                         : (rowLabels ? grid[0][colOff + i] : null);
      var has = catCell !== null && !isBlank(catCell);
      named.push(has);
      categories.push(has ? textOf(catCell).trim() : String(i + 1));
    }

    var series = [];
    var numFmtHint = '';
    for (var k = 0; k < nSeries; k++) {
      var nameCell = cols ? (rowLabels ? grid[0][colOff + k] : null)
                          : (colLabels ? grid[rowOff + k][0] : null);
      var values = [];
      for (var p = 0; p < nPoints; p++) {
        var cell = cols ? grid[rowOff + p][colOff + k] : grid[rowOff + k][colOff + p];
        var v = isLabel(cell) ? null : toNumber(rawOf(cell));
        values.push(v);
        if (!numFmtHint && v !== null) numFmtHint = formatHint(cell);
      }
      series.push({
        name: nameCell !== null && !isBlank(nameCell) ? textOf(nameCell).trim() : '',
        values: values,
        hadName: nameCell !== null && !isBlank(nameCell)
      });
    }

    /* A blank row at the foot of a selection is not a category: drop trailing
       points that have neither a name nor a value, but keep a gap in the middle
       -- a month with no figures is still a month. */
    var last = nPoints - 1;
    while (last >= 0 && !named[last] && !series.some(function (s) { return s.values[last] !== null; })) last--;
    if (last < nPoints - 1) {
      categories = categories.slice(0, last + 1);
      named = named.slice(0, last + 1);
      series.forEach(function (s) { s.values = s.values.slice(0, last + 1); });
    }

    // A column with no numbers is text, not a series. A named one is reported.
    var skipped = [];
    var lost = 0;
    series = series.filter(function (s) {
      if (s.values.some(function (v) { return v !== null; })) return true;
      if (s.hadName) skipped.push(s.name);
      lost++;
      return false;
    });

    // Totals. A 合計 row or column is arithmetic on the rest of the table and
    // would dwarf the categories it sums; it is left out when its numbers say
    // it really is a total, or when the caller asks.
    var omitted = [];
    var omit = o.omitTotals;
    if (omit !== false && categories.length > 1) {
      var lastIx = categories.length - 1;
      if (TOTAL_RE.test(categories[lastIx])) {
        var isSum = series.every(function (s) {
          var v = s.values[lastIx];
          if (v === null) return true;
          var sum = 0, n = 0;
          for (var q = 0; q < lastIx; q++) if (s.values[q] !== null) { sum += s.values[q]; n++; }
          return n > 0 && nearly(v, sum);
        });
        if (omit === true || isSum) {
          omitted.push(categories[lastIx]);
          categories = categories.slice(0, lastIx);
          series.forEach(function (s) { s.values = s.values.slice(0, lastIx); });
        }
      }
    }
    if (omit !== false && series.length > 1) {
      series = series.filter(function (s, k2) {
        if (!TOTAL_RE.test(s.name)) return true;
        var others = series.filter(function (x, j) { return j !== k2 && !TOTAL_RE.test(x.name); });
        if (!others.length) return true;
        var isSum = s.values.every(function (v, i2) {
          if (v === null) return true;
          var sum = 0, n = 0;
          others.forEach(function (x) { if (x.values[i2] !== null) { sum += x.values[i2]; n++; } });
          return n > 0 && nearly(v, sum);
        });
        if (omit === true || isSum) { omitted.push(s.name); lost++; return false; }
        return true;
      });
    }

    // Default names are numbered after the filtering, so a dropped text column
    // does not leave 數列 2 beside 數列 3.
    series.forEach(function (s, k3) {
      if (!s.name) s.name = '數列 ' + (k3 + 1);
      delete s.hadName;
    });

    if (categories.length > MAX_POINTS) {
      categories = categories.slice(0, MAX_POINTS);
      series.forEach(function (s) { s.values = s.values.slice(0, MAX_POINTS); });
    }

    /* The part of the caller's grid this chart was actually read from, so a
       spreadsheet can point its exported chart at those cells and no others.
       Only when what was kept is still one rectangle: a series dropped from the
       middle (a text column between two number columns, a 合計 column) leaves
       the kept ones no longer adjacent, and a reference spanning them would
       name data the chart does not show. Then there is no rectangle to give,
       and the writer carries the numbers instead. */
    var bounds = null;
    if (!lost && (categories.length || series.length)) {
      var pointSpan = (cols ? rowOff : colOff) + categories.length - 1;
      var seriesSpan = (cols ? colOff : rowOff) + series.length - 1;
      bounds = cols
        ? { r0: padTop, r1: padTop + pointSpan, c0: padLeft, c1: padLeft + seriesSpan }
        : { r0: padTop, r1: padTop + seriesSpan, c0: padLeft, c1: padLeft + pointSpan };
    }

    return {
      categories: categories,
      series: series,
      layout: { headerRow: rowLabels, headerCol: colLabels, seriesIn: seriesIn },
      bounds: bounds,
      corner: rowLabels && colLabels && !isBlank(corner) ? textOf(corner).trim() : '',
      titleHint: titleHint,
      numFmtHint: numFmtHint,
      omitted: omitted,
      skipped: skipped
    };
  }

  /** The number format a value cell implies: its own, or what its text says. */
  function formatHint(cell) {
    if (isCellObject(cell) && cell.numFmt) return String(cell.numFmt);
    var raw = rawOf(cell);
    if (typeof raw !== 'string') return '';
    var s = raw.trim();
    if (/^-?\(?\s*NT\$/i.test(s)) return 'NT$#,##0';
    if (/^-?\(?\s*\$/.test(s)) return '$#,##0';
    if (/%\s*$/.test(s)) return /\.\d/.test(s) ? '0.0%' : '0%';
    if (/\d,\d{3}/.test(s)) return /\.\d/.test(s) ? '#,##0.00' : '#,##0';
    return '';
  }

  /* ------------------------------------------------------------ format */

  /** A number written the way an axis wants it: no float noise, thousands grouped. */
  function plainNumber(v) {
    if (!isFinite(v)) return '';
    var abs = Math.abs(v);
    if (abs >= 1e15) return v.toExponential(2);
    var s = String(Math.round(v * 1e6) / 1e6);
    if (s === '-0') s = '0';
    return group(s);
  }
  function group(s) {
    var parts = String(s).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  /** A value in the chart's number format; General is grouped so an axis reads. */
  function fmtValue(v, numFmt) {
    if (v === null || v === undefined || !isFinite(v)) return '';
    if (numFmt) {
      var f = F();
      if (f && f.format) {
        try { return String(f.format(v, numFmt)); } catch (e) { /* fall through */ }
      }
      if (/%/.test(numFmt)) return (Math.round(v * 10000) / 100) + '%';
    }
    return plainNumber(v);
  }

  /* The letters Excel's format language reads as tokens: the date and time
     fields, the AM/PM pair, the exponent, and the era markers. Every other
     letter is literal text. */
  var FORMAT_LETTERS = 'ymdhsapegb';

  /**
   * A number format code spelled the way an OOXML file has to spell it.
   *
   * `NT$#,##0` is what a person types, what the toolbar offers and what this
   * machine's own engine reads -- but in a file those two letters are literal
   * text, and Excel does not shrug at a bare one: it refuses to open the
   * workbook at all, with no hint of which cell it objected to. The file has
   * to say `"NT$"#,##0`. Reading is unaffected, here and in Excel, because a
   * quoted literal formats the same as a bare one.
   *
   * It lives beside the other readers of this format language rather than in
   * either writer, because the cell that carries the format and the chart that
   * labels its axis with it must reach the same answer.
   */
  function excelFormatCode(code) {
    var src = String(code == null ? '' : code);
    if (!src || /^general$/i.test(src)) return src;
    var out = '';
    var i = 0;
    while (i < src.length) {
      var ch = src.charAt(i);
      if (ch === '"') {                       // already a literal
        var end = src.indexOf('"', i + 1);
        if (end < 0) { out += src.slice(i); break; }
        out += src.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (ch === '[') {                       // a colour, a locale or a condition
        var close = src.indexOf(']', i + 1);
        if (close < 0) { out += src.slice(i); break; }
        out += src.slice(i, close + 1);
        i = close + 1;
        continue;
      }
      if (ch === '\\' || ch === '_' || ch === '*') {   // the next character is taken as given
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (/[A-Za-z]/.test(ch)) {
        var j = i;
        while (j < src.length && /[A-Za-z]/.test(src.charAt(j))) j++;
        var run = src.slice(i, j);
        var isToken = run.toLowerCase().split('').every(function (c) {
          return FORMAT_LETTERS.indexOf(c) >= 0;
        });
        out += isToken ? run : '"' + run + '"';
        i = j;
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  }

  /** A tick label: the number format when there is one, else the scale's own decimals. */
  function tickLabel(v, numFmt, decimals) {
    if (numFmt) return fmtValue(v, numFmt);
    if (!isFinite(v)) return '';
    if (Math.abs(v) >= 1e15) return v.toExponential(2);
    var s = v.toFixed(Math.max(0, Math.min(10, decimals || 0)));
    if (/^-0(\.0+)?$/.test(s)) s = s.slice(1);
    return group(s);
  }

  /**
   * The chart's data as a table: a heading row, then one row per category.
   * `opts.raw` keeps numbers as numbers (for cells and the clipboard);
   * otherwise values are formatted with the chart's number format so what the
   * table says is what the axis says.
   */
  function toRows(spec, opts) {
    var s = norm(spec);
    var o = opts || {};
    var head = [s.xTitle || ''].concat(s.series.map(function (ser) { return ser.name; }));
    var rows = [head];
    s.categories.forEach(function (cat, i) {
      rows.push([cat].concat(s.series.map(function (ser) {
        var v = ser.values[i];
        if (o.raw) return v === null ? '' : v;
        return fmtValue(v, s.numFmt);
      })));
    });
    return rows;
  }

  /** Rows as tab-separated text, the shape a spreadsheet copies. */
  function tsv(rows) {
    return (rows || []).map(function (r) {
      return r.map(function (c) { return String(c === null || c === undefined ? '' : c).replace(/[\t\r\n]+/g, ' '); }).join('\t');
    }).join('\n');
  }

  /* -------------------------------------------------------------- norm */

  function str(v, max) {
    return String(v === null || v === undefined ? '' : v).slice(0, max || 200);
  }

  /**
   * Everything a chart needs, with anything missing filled in and anything wrong
   * put right. The single gate for a spec arriving from a file, a chat action,
   * a paste or a toolbar -- so no other code has to ask whether a field is there.
   * Returns a fresh object; the input is never mutated. Idempotent.
   *
   * More than MAX_SERIES series: a stack folds the rest into 其他 (its totals
   * stay true), anything else keeps the first eight. Callers that want to say
   * so compare with overflow().
   */
  function norm(raw) {
    var o = raw && typeof raw === 'object' ? raw : {};
    var type = resolveType(o.type) || 'column';
    var t = typeOf(type);

    var categories = (Array.isArray(o.categories) ? o.categories : [])
      .slice(0, MAX_POINTS).map(function (c) { return str(textOf(c), 200).trim(); });

    var series = (Array.isArray(o.series) ? o.series : []).filter(function (s) {
      return s && typeof s === 'object';
    }).map(function (s, k) {
      var values = (Array.isArray(s.values) ? s.values : []).map(toNumber);
      var out = { name: str(s.name, 100).trim() || '數列 ' + (k + 1), values: values };
      var hex = hexOf(s.colour);
      if (hex) out.colour = hex;
      return out;
    });

    if (series.length > MAX_SERIES) {
      if (t.stacked) {
        var rest = series.slice(MAX_SERIES - 1);
        var folded = { name: '其他（' + rest.length + ' 項）', values: [], colour: OTHER_COLOUR };
        var len = rest.reduce(function (m, s) { return Math.max(m, s.values.length); }, 0);
        for (var i = 0; i < len; i++) {
          var sum = null;
          rest.forEach(function (s) { if (s.values[i] !== null && s.values[i] !== undefined) sum = (sum || 0) + s.values[i]; });
          folded.values.push(sum);
        }
        series = series.slice(0, MAX_SERIES - 1).concat([folded]);
      } else {
        series = series.slice(0, MAX_SERIES);
      }
    }

    // Series values are aligned to the categories: a category with no value is
    // a gap, a value with no category names itself by position.
    var n = categories.length;
    series.forEach(function (s) { if (s.values.length > n) n = s.values.length; });
    n = Math.min(n, MAX_POINTS);
    while (categories.length < n) categories.push(String(categories.length + 1));
    series.forEach(function (s) {
      while (s.values.length < n) s.values.push(null);
      if (s.values.length > n) s.values = s.values.slice(0, n);
    });
    // Trailing categories with no name and no value are slack, not data.
    var last = n - 1;
    while (last >= 0 && (categories[last] === '' || categories[last] === String(last + 1)) &&
           !series.some(function (s) { return s.values[last] !== null; })) last--;
    if (last < n - 1) {
      categories = categories.slice(0, last + 1);
      series.forEach(function (s) { s.values = s.values.slice(0, last + 1); });
    }
    categories = categories.map(function (c, i) { return c === '' ? String(i + 1) : c; });

    var legend = LEGENDS.indexOf(o.legend) >= 0 ? o.legend : (t.family === 'pie' ? 'right' : 'bottom');
    var labels = o.labels === undefined || o.labels === null
      ? t.family === 'pie'
      : (o.labels === true || o.labels === 'true' || o.labels === 1);

    var out = {
      type: type,
      title: str(o.title, 200).trim(),
      categories: categories,
      series: series,
      legend: legend,
      labels: !!labels,
      numFmt: str(o.numFmt, 60).trim(),
      xTitle: str(o.xTitle, 100).trim(),
      yTitle: str(o.yTitle, 100).trim()
    };
    if (o.source && typeof o.source === 'object') {
      var src = {};
      ['file', 'sheet', 'range', 'seriesIn'].forEach(function (k) {
        if (o.source[k] !== undefined && o.source[k] !== null && o.source[k] !== '') src[k] = str(o.source[k], 300);
      });
      if (Object.keys(src).length) out.source = src;
    }
    return out;
  }

  /** How many series a raw spec has beyond what norm() keeps, and how they were kept. */
  function overflow(raw) {
    var list = raw && Array.isArray(raw.series) ? raw.series.filter(function (s) { return s && typeof s === 'object'; }) : [];
    var extra = Math.max(0, list.length - MAX_SERIES);
    var t = typeOf(resolveType(raw && raw.type) || 'column');
    return { extra: extra, folded: extra && t.stacked ? extra + 1 : 0, dropped: extra && !t.stacked ? extra : 0 };
  }

  /** A spec with per-series colour overrides applied from a sparse list. */
  function withColours(spec, colours) {
    var s = norm(spec);
    if (Array.isArray(colours)) {
      s.series.forEach(function (ser, k) {
        var hex = hexOf(colours[k]);
        if (hex) ser.colour = hex;
        else if (colours[k] === '' || colours[k] === null) delete ser.colour;
      });
    }
    return s;
  }

  /** The colour a series draws in: its own, or its slot in the fixed order. */
  function colourOf(spec, k) {
    var s = spec.series[k];
    if (s && s.colour) return '#' + s.colour;
    return '#' + COLOURS[Math.min(k, COLOURS.length - 1)];
  }
  /** Whether series k draws in a slot colour (themed) rather than an override. */
  function slotOf(spec, k) {
    var s = spec.series[k];
    return s && s.colour ? -1 : Math.min(k, COLOURS.length - 1);
  }

  /**
   * The slices of a pie: the first series, positive values only, the seven
   * largest kept in their own order and the rest folded into 其他 in the
   * de-emphasis grey. The DrawingML writer colours its slices by the same rule.
   */
  function pieSlices(spec) {
    var s = norm(spec);
    var ser = s.series[0];
    if (!ser) return [];
    var items = [];
    s.categories.forEach(function (cat, i) {
      var v = ser.values[i];
      if (v !== null && v > 0) items.push({ name: cat, value: v, index: i });
    });
    if (items.length > MAX_SERIES) {
      var sorted = items.slice().sort(function (a, b) { return b.value - a.value; });
      var keep = sorted.slice(0, MAX_SERIES - 1);
      var rest = sorted.slice(MAX_SERIES - 1);
      items = items.filter(function (it) { return keep.indexOf(it) >= 0; });
      items.push({
        name: '其他（' + rest.length + ' 項）', index: -1, folded: rest.length,
        value: rest.reduce(function (a, it) { return a + it.value; }, 0)
      });
    }
    items.forEach(function (it, k) {
      it.slot = it.index < 0 ? -1 : k;
      it.colour = '#' + (it.index < 0 ? OTHER_COLOUR : COLOURS[k]);
    });
    return items;
  }

  /** The colour of pie slice i of n, for a writer that keeps every slice. */
  function sliceColour(i, n) {
    if (n > MAX_SERIES && i >= MAX_SERIES - 1) return OTHER_COLOUR;
    return COLOURS[Math.min(i, COLOURS.length - 1)];
  }

  /* ---------------------------------------------------------- describe */

  function preview(list, max) {
    var n = list.length;
    if (n <= (max || 4)) return list.join('、');
    return list.slice(0, 3).join('、') + '…' + list[n - 1];
  }

  /**
   * One line for the model, which sees this and nothing else of the chart:
   *   直條圖「上半年收支」：3 個數列（收入、支出、淨利）× 6 個類別（1月、2月、3月…6月）
   */
  function describe(raw) {
    var s = norm(raw);
    var t = typeOf(s.type);
    var head = t.name + (s.title ? '「' + s.title + '」' : '') + '：';
    if (!s.series.length || !s.categories.length) return head + '（沒有資料）';
    var names = s.series.map(function (x) { return x.name; });
    if (t.family === 'pie') {
      var ser = s.series[0];
      var skipped = ser.values.filter(function (v) { return v !== null && v <= 0; }).length;
      return head + s.categories.length + ' 個類別（' + preview(s.categories) + '），數列「' + names[0] + '」' +
        (names.length > 1 ? '（其餘 ' + (names.length - 1) + ' 個數列不畫）' : '') +
        (skipped ? '（略過 ' + skipped + ' 個非正值）' : '');
    }
    var extra = t.family === 'scatter' && names.length > SCATTER_SERIES
      ? '（散佈圖最多畫 ' + SCATTER_SERIES + ' 個數列）' : '';
    return head + names.length + ' 個數列（' + preview(names) + '）× ' +
      s.categories.length + ' 個類別（' + preview(s.categories) + '）' + extra;
  }

  /* ------------------------------------------------------------- scale */

  function stepFor(rough) {
    var exp = Math.floor(Math.log(rough) / Math.LN10 + 1e-9);
    var mag = Math.pow(10, exp);
    var unit = Math.round(rough / mag * 1e9) / 1e9;
    var f = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10;
    var decimals = Math.max(0, -exp) + (f === 2.5 ? 1 : 0);
    if (f === 10) { f = 1; exp += 1; mag *= 10; decimals = Math.max(0, -exp); }
    return { step: Number((f * mag).toFixed(decimals + 2)), decimals: decimals };
  }

  /**
   * A nice axis over [lo, hi]: a step of 1, 2, 2.5 or 5 times a power of ten,
   * about `count` ticks, ends rounded outward, the count near the request that
   * wastes the least room. Zero: 'always' (bars grow from a baseline), 'auto'
   * (a line keeps zero when the data is within a factor of two of it) or 'never'.
   * Returns { min, max, step, decimals, ticks }.
   */
  function niceScale(lo, hi, opts) {
    var o = typeof opts === 'object' && opts ? opts : { count: opts, zero: 'always' };
    var count = Math.max(3, Number(o.count) || 5);
    var zero = o.zero || 'always';
    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
    if (hi < lo) { var tmp = lo; lo = hi; hi = tmp; }
    /* A span too small to tell apart at this magnitude is flat data, not an
       axis: a range of a billionth either side of four million cannot be
       written as two different tick labels, because the two ends are the same
       double. Treating it as one value gives a readable axis instead of a row
       of identical numbers. */
    if (hi - lo <= Math.abs(hi) * 1e-12) hi = lo;
    if (zero === 'always') { lo = Math.min(0, lo); hi = Math.max(0, hi); }
    else if (zero === 'auto') {
      var near = (lo >= 0 && hi > 0 && lo / hi <= 0.5) || (hi <= 0 && lo < 0 && hi / lo <= 0.5) || (lo < 0 && hi > 0);
      if (near) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
    }
    if (hi === lo) {
      if (zero !== 'never' && lo === 0) hi = 1;
      else if (zero === 'always') { if (lo > 0) lo = 0; else hi = 0; }
      else { var pad = Math.max(Math.abs(lo) * 0.1, 1); lo -= pad; hi += pad; }
    }
    var best = null;
    [count - 1, count, count + 1].forEach(function (c) {
      if (c < 3) return;
      var s = stepFor((hi - lo) / (c - 1));
      var min = Math.floor(lo / s.step + 1e-9) * s.step;
      var max = Math.ceil(hi / s.step - 1e-9) * s.step;
      var ticks = [];
      for (var v = min; v <= max + s.step * 1e-6 && ticks.length <= 40; v += s.step) {
        ticks.push(Number(v.toFixed(s.decimals + 2)));
      }
      if (ticks.length > 9 || ticks.length < 2) return;
      var span = max - min;
      // The least wasted room wins; between equals, the count nearest the request.
      var closer = best && Math.abs(ticks.length - count) < Math.abs(best.ticks.length - count);
      if (!best || span < best.span - 1e-12 || (Math.abs(span - best.span) <= 1e-12 && closer)) {
        best = { min: Number(min.toFixed(s.decimals + 2)), max: Number(max.toFixed(s.decimals + 2)), step: s.step, decimals: s.decimals, ticks: ticks, span: span };
      }
    });
    if (!best) {
      var s2 = stepFor((hi - lo) / 4);
      var min2 = Math.floor(lo / s2.step) * s2.step, max2 = Math.ceil(hi / s2.step) * s2.step;
      best = { min: min2, max: max2, step: s2.step, decimals: s2.decimals, ticks: [min2, max2], span: max2 - min2 };
    }
    delete best.span;
    return best;
  }

  /* ------------------------------------------------------------ ranges */

  /** A sheet name the way a formula spells it: quoted, with quotes doubled. */
  function quoteSheet(name) {
    return "'" + String(name || '').replace(/'/g, "''") + "'";
  }

  function indexToCol(n) {
    var s = '';
    n = n + 1;
    while (n > 0) {
      var m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }
  function colToIndex(letters) {
    var n = 0;
    var s = String(letters).toUpperCase();
    for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n - 1;
  }

  /**
   * A range as text -- `A1:D13`, `工作表2!A1:D13`, `'我的表'!$A$1:$D$13`, or a
   * single cell -- taken apart into { sheet, c0, r0, c1, r1 } (zero-based,
   * inclusive, corners ordered). Null when it is not a range.
   */
  function parseRange(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s) return null;
    var sheet = null;
    var bang = -1;
    if (s.charAt(0) === "'") {
      var end = 1;
      while (end < s.length) {
        if (s.charAt(end) === "'") {
          if (s.charAt(end + 1) === "'") { end += 2; continue; }
          break;
        }
        end++;
      }
      if (s.charAt(end) !== "'" || s.charAt(end + 1) !== '!') return null;
      sheet = s.slice(1, end).replace(/''/g, "'");
      s = s.slice(end + 2);
    } else if ((bang = s.lastIndexOf('!')) >= 0) {
      sheet = s.slice(0, bang);
      s = s.slice(bang + 1);
      if (!sheet) return null;
    }
    var m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?([A-Za-z]{1,3})\$?(\d{1,7}))?$/.exec(s);
    if (!m) return null;
    var c0 = colToIndex(m[1]), r0 = Number(m[2]) - 1;
    var c1 = m[3] ? colToIndex(m[3]) : c0, r1 = m[4] ? Number(m[4]) - 1 : r0;
    if (r0 < 0 || r1 < 0) return null;
    return {
      sheet: sheet,
      c0: Math.min(c0, c1), c1: Math.max(c0, c1),
      r0: Math.min(r0, r1), r1: Math.max(r0, r1)
    };
  }

  /** A rectangle back as text, qualified with a sheet when one is given. */
  function rangeText(rect, sheet) {
    var a = indexToCol(rect.c0) + (rect.r0 + 1);
    var b = indexToCol(rect.c1) + (rect.r1 + 1);
    var body = a === b ? a : a + ':' + b;
    if (!sheet) return body;
    return (/[\s!'\[\]]/.test(sheet) ? quoteSheet(sheet) : sheet) + '!' + body;
  }

  /**
   * Cell references for the .xlsx writer, so Excel's own chart points at the
   * cells the AI-OS chart was drawn from. `rect` is {c0, r0, c1, r1} (zero-based,
   * inclusive), `layout` is what fromRows() decided about the heading row and
   * column, `seriesIn` says which way the series run, and `catRect` is an
   * optional separate range holding the categories (one row or one column).
   * Returns { cat, tx: [...], val: [...] } with nulls where there is no heading.
   */
  function rangeRefs(sheetName, rect, seriesIn, layout, catRect) {
    var q = quoteSheet(sheetName) + '!';
    var lay = layout || {};
    function bare(c, r) { return '$' + indexToCol(c) + '$' + (r + 1); }
    function cell(c, r) { return q + bare(c, r); }
    function range(c0, r0, c1, r1) { return q + bare(c0, r0) + ':' + bare(c1, r1); }
    var cols = seriesIn !== 'rows';
    var hr = lay.headerRow ? 1 : 0;
    var hc = lay.headerCol ? 1 : 0;
    var out = { cat: null, tx: [], val: [] };
    if (catRect) {
      out.cat = range(catRect.c0, catRect.r0, catRect.c1, catRect.r1);
      hc = cols ? 0 : hc;
      hr = cols ? hr : 0;
    }
    if (cols) {
      if (!catRect && lay.headerCol && rect.r0 + hr <= rect.r1) out.cat = range(rect.c0, rect.r0 + hr, rect.c0, rect.r1);
      for (var c = rect.c0 + hc; c <= rect.c1; c++) {
        out.tx.push(lay.headerRow ? cell(c, rect.r0) : null);
        out.val.push(rect.r0 + hr <= rect.r1 ? range(c, rect.r0 + hr, c, rect.r1) : null);
      }
    } else {
      if (!catRect && lay.headerRow && rect.c0 + hc <= rect.c1) out.cat = range(rect.c0 + hc, rect.r0, rect.c1, rect.r0);
      for (var r = rect.r0 + hr; r <= rect.r1; r++) {
        out.tx.push(lay.headerCol ? cell(rect.c0, r) : null);
        out.val.push(rect.c0 + hc <= rect.c1 ? range(rect.c0 + hc, r, rect.c1, r) : null);
      }
    }
    return out;
  }

  /**
   * The workbook a document or a deck carries beside its chart.
   *
   * A chart in a .docx or a .pptx has no spreadsheet behind it, so Office's
   * 「編輯資料」 has nothing to open -- unless the file brings one. The data is
   * already here, so the workbook is not a guess: it is `toRows` written into
   * cells, and the chart points at those cells the way it would point at a
   * sheet. That is what makes the chart editable in Word and PowerPoint
   * instead of a picture of numbers.
   *
   * Returns `{ sheet, cells, refs }`, or null when there is nothing to chart.
   */
  function embedPlan(spec, sheetName) {
    var s = norm(spec);
    if (!s.series.length || !s.categories.length) return null;
    var name = sheetName || 'Sheet1';
    var cells = {};
    toRows(s, { raw: true }).forEach(function (row, r) {
      row.forEach(function (v, c) {
        if (v === '' || v === null || v === undefined) return;
        var cell = { v: v };
        // The value cells wear the chart's own format, so the workbook a person
        // opens reads the way the axis does.
        if (r > 0 && c > 0 && s.numFmt) cell.numFmt = s.numFmt;
        cells[indexToCol(c) + (r + 1)] = cell;
      });
    });
    return {
      sheet: name,
      cells: cells,
      refs: rangeRefs(name, { c0: 0, r0: 0, c1: s.series.length, r1: s.categories.length },
        'cols', { headerRow: true, headerCol: true })
    };
  }

  /**
   * The inverse, for a chart read out of an .xlsx: the cell references of its
   * series turned back into a range a spreadsheet chart can bind to.
   * Returns { sheet, range: rect, categories: rect | null, seriesIn,
   *           layout: { headerRow, headerCol }, names: [...] } or null when the
   * references do not describe parallel rows or columns on one sheet.
   */
  function refsToRange(refs) {
    if (!refs || !Array.isArray(refs.val) || !refs.val.length) return null;
    var vals = refs.val.map(parseRange);
    if (vals.some(function (v) { return !v; })) return null;
    var sheet = vals[0].sheet;
    if (vals.some(function (v) { return v.sheet !== sheet; })) return null;
    var cat = refs.cat ? parseRange(refs.cat) : null;
    if (refs.cat && !cat) return null;
    if (cat && cat.sheet !== sheet) return null;
    var txs = (refs.tx || []).map(function (t) { return t ? parseRange(t) : null; });
    if (txs.some(function (t, k) { return refs.tx && refs.tx[k] && !t; })) return null;

    var cols = vals.every(function (v) { return v.c0 === v.c1; });
    var rows = !cols && vals.every(function (v) { return v.r0 === v.r1; });
    if (!cols && !rows) return null;
    var span = cols
      ? vals.every(function (v) { return v.r0 === vals[0].r0 && v.r1 === vals[0].r1; })
      : vals.every(function (v) { return v.c0 === vals[0].c0 && v.c1 === vals[0].c1; });
    if (!span) return null;
    // Consecutive columns (or rows), in order.
    for (var k = 1; k < vals.length; k++) {
      if (cols ? vals[k].c0 !== vals[k - 1].c0 + 1 : vals[k].r0 !== vals[k - 1].r0 + 1) return null;
    }
    var first = vals[0], lastV = vals[vals.length - 1];
    // Series names in the cell just before the values, all or none.
    var headerNames = txs.length === vals.length && txs.every(function (t, k2) {
      return t && (cols ? (t.c0 === vals[k2].c0 && t.c1 === t.c0 && t.r0 === first.r0 - 1 && t.r1 === t.r0)
                        : (t.r0 === vals[k2].r0 && t.r1 === t.r0 && t.c0 === first.c0 - 1 && t.c1 === t.c0));
    });
    var out = { sheet: sheet, seriesIn: cols ? 'cols' : 'rows', names: [], categories: null };
    var r0 = cols ? (headerNames ? first.r0 - 1 : first.r0) : first.r0;
    var c0 = cols ? first.c0 : (headerNames ? first.c0 - 1 : first.c0);
    var r1 = cols ? first.r1 : lastV.r0;
    var c1 = cols ? lastV.c0 : first.c1;
    var layout = { headerRow: cols ? headerNames : false, headerCol: cols ? false : headerNames };
    if (cat) {
      var adjacent = cols
        ? (cat.c0 === cat.c1 && cat.c0 === first.c0 - 1 && cat.r0 === first.r0 && cat.r1 === first.r1)
        : (cat.r0 === cat.r1 && cat.r0 === first.r0 - 1 && cat.c0 === first.c0 && cat.c1 === first.c1);
      if (adjacent) {
        if (cols) { c0 = cat.c0; layout.headerCol = true; } else { r0 = cat.r0; layout.headerRow = true; }
      } else {
        out.categories = { c0: cat.c0, r0: cat.r0, c1: cat.c1, r1: cat.r1 };
      }
    }
    out.range = { c0: c0, r0: r0, c1: c1, r1: r1 };
    out.layout = layout;
    return out;
  }

  /* ------------------------------------------------------- text width */

  /* Layout never measures text: a detached node reports nothing and the same
     spec has to lay out identically in the editor, a thumbnail and a print
     window. Width is estimated per character class instead, rounding up, so
     an error costs a skipped label rather than a clipped one. CJK is one em. */
  function charWidth(cp) {
    if (cp === 32) return 0.30;
    if (cp >= 48 && cp <= 57) return 0.60;
    if (cp >= 65 && cp <= 90) return cp === 73 ? 0.30 : cp === 74 ? 0.50 : (cp === 77 || cp === 87) ? 0.90 : 0.68;
    if (cp >= 97 && cp <= 122) {
      if (cp === 105 || cp === 106 || cp === 108) return 0.28;
      if (cp === 102 || cp === 116 || cp === 114) return 0.35;
      if (cp === 109 || cp === 119) return 0.85;
      return 0.55;
    }
    if (cp === 46 || cp === 44 || cp === 58 || cp === 59 || cp === 39 || cp === 124 || cp === 33) return 0.30;
    if (cp === 40 || cp === 41 || cp === 91 || cp === 93 || cp === 123 || cp === 125) return 0.35;
    if (cp === 45) return 0.40;
    if (cp === 37) return 0.85;
    if (cp === 38) return 0.70;
    if (cp === 64) return 1.0;
    if (cp < 128) return 0.60;
    if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f)) return 0;
    if (cp >= 0xff61 && cp <= 0xff9f) return 0.50;
    if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) ||
        (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
        (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) ||
        (cp >= 0x20000 && cp <= 0x3fffd)) return 1.0;
    return 0.62;
  }
  function codePoints(text) {
    var out = [];
    var s = String(text == null ? '' : text);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) { out.push(((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000); i++; continue; }
      }
      out.push(c);
    }
    return out;
  }
  function estWidth(text, size, bold) {
    var w = 0;
    codePoints(text).forEach(function (cp) { w += charWidth(cp); });
    return w * (size || 13) * (bold ? 1.06 : 1) + 2;
  }
  /** Cut a label to an estimated width, ending in an ellipsis. */
  function fitText(text, size, maxWidth) {
    var s = String(text == null ? '' : text);
    if (estWidth(s, size) <= maxWidth) return s;
    var cps = codePoints(s);
    var out = '';
    for (var i = 0; i < cps.length; i++) {
      var next = out + String.fromCodePoint(cps[i]);
      if (estWidth(next + '…', size) > maxWidth) break;
      out = next;
    }
    return (out || (cps.length ? String.fromCodePoint(cps[0]) : '')) + '…';
  }
  /** Two lines out of a label, when both fit; null otherwise. */
  function wrapTwo(text, size, maxWidth) {
    var cps = codePoints(text);
    if (cps.length < 4) return null;
    var at = Math.ceil(cps.length / 2);
    var latin = cps.every(function (cp) { return cp < 0x2e80; });
    if (latin) {
      var s = String(text);
      var sp = s.lastIndexOf(' ', Math.ceil(s.length / 2));
      if (sp > 0) {
        var l1 = s.slice(0, sp), l2 = s.slice(sp + 1);
        if (Math.max(estWidth(l1, size), estWidth(l2, size)) <= maxWidth) return [l1, l2];
      }
    }
    var a = String.fromCodePoint.apply(null, cps.slice(0, at));
    var b = String.fromCodePoint.apply(null, cps.slice(at));
    if (Math.max(estWidth(a, size), estWidth(b, size)) <= maxWidth) return [a, b];
    return null;
  }

  /* -------------------------------------------------------------- svg */

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function num(v) { return String(Math.round(v * 100) / 100); }
  function half(v) { return Math.round(v) + 0.5; }

  /**
   * Draw a chart. Returns an <svg> element the caller places wherever it likes;
   * everything about its appearance is inline, so the node serialises into the
   * PDF and the deck's HTML export unchanged.
   *
   * opts:
   *   width, height   the viewBox (default 640 x 360); the element itself is 100% x 100%
   *   fontSize        in viewBox units (default 13)
   *   font            a CSS font-family list
   *   surface         a background colour to paint; '' (default) paints none --
   *                   the host's own background shows through
   *   preserve        preserveAspectRatio (default 'xMidYMid meet')
   *   tooltips        add a <title> to every mark and category (default true)
   *   static          the drawing goes somewhere without hover (a PDF): the
   *                   faint-on-white series get a direct label
   *
   * Ink is always `currentColor`: the host decides. Series colours in the eight
   * slots are `var(--ch-N, #light)`, so a dark host may re-step them.
   */
  function render(raw, opts) {
    if (typeof document === 'undefined') throw new Error('render() needs a document');
    var s = norm(raw);
    var t = typeOf(s.type);
    var o = opts || {};
    var W = Math.max(40, Number(o.width) || 640);
    var H = Math.max(12, Number(o.height) || 360);
    var fs = Math.max(4, Number(o.fontSize) || 13);
    var font = String(o.font || 'system-ui, "Segoe UI", "Noto Sans TC", sans-serif').replace(/"/g, "'");
    var surface = o.surface ? String(o.surface) : '';
    var tips = o.tooltips !== false;
    var isStatic = !!o.static;

    function mk(tag, attrs, parent) {
      var n = document.createElementNS(SVG_NS, tag);
      if (attrs) Object.keys(attrs).forEach(function (k) {
        if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, String(attrs[k]));
      });
      if (parent) parent.appendChild(n);
      return n;
    }
    function text(parent, x, y, str, attrs) {
      var a = Object.assign({ x: num(x), y: num(y), fill: 'currentColor', 'font-size': num(fs) }, attrs || {});
      var n = mk('text', a, parent);
      n.appendChild(document.createTextNode(String(str)));
      return n;
    }
    function dimText(parent, x, y, str, attrs) {
      return text(parent, x, y, str, Object.assign({ 'fill-opacity': 0.72 }, attrs || {}));
    }
    function hair(parent, x1, y1, x2, y2, strong) {
      return mk('line', { x1: num(x1), y1: num(y1), x2: num(x2), y2: num(y2), stroke: 'currentColor',
        'stroke-opacity': strong ? 0.3 : 0.12, 'stroke-width': 1 }, parent);
    }
    function tip(node, str) {
      if (!tips) return;
      var ti = mk('title', null);
      ti.appendChild(document.createTextNode(str));
      node.insertBefore(ti, node.firstChild);
    }
    /* A series fill: a themed slot or a plain override. */
    function paint(node, k, prop) {
      var slot = slotOf(s, k);
      var hex = colourOf(s, k);
      if (slot < 0) node.setAttribute(prop || 'fill', hex);
      else node.style[prop || 'fill'] = 'var(--ch-' + (slot + 1) + ', ' + hex + ')';
      // An override too faint to see against the surface gets a hairline ring.
      if (slot < 0 && (prop || 'fill') === 'fill' && luminanceOf(hex) > 0.8) {
        node.setAttribute('stroke', 'currentColor');
        node.setAttribute('stroke-opacity', '0.1');
        node.setAttribute('stroke-width', '1');
      }
    }
    function label(v) { return fmtValue(v, s.numFmt); }

    var svg = mk('svg', {
      xmlns: SVG_NS, viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: '100%',
      preserveAspectRatio: o.preserve || 'xMidYMid meet', role: 'img',
      'aria-label': describe(s), 'class': 'ui-chart', 'font-family': font
    });
    svg.style.display = 'block';
    svg.dataset.chartType = s.type;
    if (surface) mk('rect', { x: 0, y: 0, width: W, height: H, fill: surface }, svg);
    if (W < 40 || H < 12) return svg;

    var pad = 12;
    var top = pad;
    var bottom = H - pad;
    var left = pad;
    var right = W - pad;

    var n = s.categories.length;
    var m = s.series.length;
    var pie = t.family === 'pie';
    var scatter = t.family === 'scatter';
    if (scatter && m > SCATTER_SERIES) m = SCATTER_SERIES;
    var empty = !m || !n || (pie ? !s.series[0].values.some(function (v) { return v !== null && v > 0; })
                                : !s.series.slice(0, m).some(function (ser) { return ser.values.some(function (v) { return v !== null; }); }));

    /* The title: the chart's, or the one series' name when the chart has none
       and would otherwise never say what it shows. */
    var title = s.title;
    if (!title && !pie && m === 1 && !empty) title = s.series[0].name;

    /* Legend: series for cartesian charts (two or more -- one series is named by
       the title), slices for a pie. */
    var slices = pie && !empty ? pieSlices(s) : [];
    var legendItems = [];
    if (!empty && s.legend !== 'none') {
      if (pie) {
        if (slices.length >= 2) legendItems = slices.map(function (sl) { return { name: sl.name, slot: sl.slot, colour: sl.colour, kind: 'rect' }; });
      } else if (m >= 2) {
        legendItems = s.series.slice(0, m).map(function (ser, k) {
          return { name: ser.name, slot: slotOf(s, k), colour: colourOf(s, k), k: k,
            kind: t.family === 'line' ? 'line' : scatter ? 'dot' : 'rect' };
        });
      }
    }

    /* Chrome, then the degrade ladder: a small drawing gives up its legend, its
       title and its labels in that order rather than squeezing them illegibly. */
    var tfs = fs * 1.25;
    var lfs = fs;
    var rowH = Math.round(1.5 * lfs);
    var legendRows = [];
    var legendRight = false;
    var legendH = 0, legendW = 0;
    function layoutLegend() {
      legendRows = []; legendRight = false; legendH = 0; legendW = 0;
      if (!legendItems.length) return;
      var itemsW = legendItems.map(function (it) { return 12 + 6 + estWidth(it.name, lfs) + 16; });
      if (s.legend === 'right') {
        var colW = Math.min(W * 0.32, Math.max.apply(null, itemsW));
        if (legendItems.length * rowH <= (H - top - pad)) {
          legendRight = true;
          legendW = colW + pad;
          legendItems.forEach(function (it, i) {
            it.maxW = colW - 12 - 6 - 16;
          });
          return;
        }
      }
      var maxW = right - left;
      var cap = 0.45 * maxW;
      var flow = function (capW) {
        var rows = [], row = [], x = 0;
        legendItems.forEach(function (it, i) {
          it.maxW = Math.min(estWidth(it.name, lfs), capW);
          var w = 12 + 6 + it.maxW + 16;
          if (x + w > maxW && row.length) { rows.push(row); row = []; x = 0; }
          it.dx = x; it.w = w; row.push(it); x += w;
        });
        if (row.length) rows.push(row);
        return rows;
      };
      legendRows = flow(cap);
      if (legendRows.length > 3) legendRows = flow(0.22 * maxW);
      legendH = legendRows.length * rowH + 8;
    }
    layoutLegend();

    var showTitle = !!title;
    var showLegend = legendItems.length > 0;
    var titleH = showTitle ? tfs * 1.75 + 6 : 0;
    var plotH = H - pad * 2 - titleH - (legendRight ? 0 : legendH);
    if (plotH < 60 && showLegend) { showLegend = false; legendRows = []; legendRight = false; legendH = 0; legendW = 0; plotH = H - pad * 2 - titleH; }
    if (plotH < 60 && showTitle) { showTitle = false; titleH = 0; plotH = H - pad * 2; }
    var showAxes = !(plotH < 40 || (W - pad * 2 - legendW) < 80);
    var marksOnly = plotH < 16;

    if (showTitle) {
      text(svg, left, top + tfs, fitText(title, tfs, W - pad * 2), { 'font-size': num(tfs), 'font-weight': 600 });
      top += titleH;
    }
    if (showLegend && legendRight) right -= legendW;
    if (showLegend && !legendRight) bottom -= legendH;

    // The legend itself.
    if (showLegend) {
      var g = mk('g', null, svg);
      var placed = [];
      if (legendRight) {
        var lx = right + pad;
        var ly0 = top + Math.max(0, (bottom - top - legendItems.length * rowH) / 2);
        legendItems.forEach(function (it, i) { placed.push({ it: it, x: lx, y: ly0 + i * rowH + rowH / 2 }); });
      } else {
        var maxW = right - left;
        legendRows.forEach(function (row, ri) {
          var rowW = row.reduce(function (a, it) { return a + it.w; }, 0);
          var start = left + Math.max(0, (maxW - rowW) / 2);
          row.forEach(function (it) { placed.push({ it: it, x: start + it.dx, y: bottom + 8 + ri * rowH + rowH / 2 }); });
        });
      }
      placed.forEach(function (p) {
        var it = p.it;
        var sw;
        if (it.kind === 'line') {
          sw = mk('line', { x1: num(p.x), y1: num(p.y), x2: num(p.x + 16), y2: num(p.y), 'stroke-width': 2, 'stroke-linecap': 'round' }, g);
          paint(sw, it.k, 'stroke');
          var d = mk('circle', { cx: num(p.x + 8), cy: num(p.y), r: 3 }, g);
          paint(d, it.k, 'fill');
        } else if (it.kind === 'dot') {
          sw = mk('circle', { cx: num(p.x + 8), cy: num(p.y), r: 4 }, g);
          paint(sw, it.k, 'fill');
        } else {
          sw = mk('rect', { x: num(p.x + 2), y: num(p.y - 6), width: 12, height: 12, rx: 2 }, g);
          if (it.slot >= 0 && it.k !== undefined) paint(sw, it.k, 'fill');
          else if (it.slot >= 0) sw.style.fill = 'var(--ch-' + (it.slot + 1) + ', ' + it.colour + ')';
          else sw.setAttribute('fill', it.colour);
        }
        var tx = dimText(g, p.x + 12 + 6 + 2, p.y, fitText(it.name, lfs, it.maxW), { 'font-size': num(lfs), dy: '0.35em' });
        tx.setAttribute('fill-opacity', '0.85');
        if (tips) tip(tx, it.name);
      });
    }

    if (empty) {
      dimText(svg, (left + right) / 2, (top + bottom) / 2, '（沒有資料）', { 'text-anchor': 'middle', dy: '0.35em' });
      return svg;
    }

    var L = {
      left: left, right: right, top: top, bottom: bottom, fs: fs, mk: mk, text: text, dimText: dimText,
      tip: tip, label: label, hair: hair, paint: paint, tips: tips, showAxes: showAxes, marksOnly: marksOnly,
      surface: surface, isStatic: isStatic, m: m
    };
    if (pie) drawPie(svg, s, t, slices, L);
    else if (scatter) drawScatter(svg, s, L);
    else drawCartesian(svg, s, t, L);
    return svg;
  }

  /* Pie: slices from twelve o'clock, clockwise, separated by unpainted angle. */
  function drawPie(svg, s, t, slices, L) {
    var cx = (L.left + L.right) / 2;
    var cy = (L.top + L.bottom) / 2;
    var r = Math.max(6, Math.min(L.right - L.left, L.bottom - L.top) / 2 - 4);
    var inner = t.hole ? r * 0.5 : 0;
    var total = slices.reduce(function (a, it) { return a + it.value; }, 0);
    var delta = 2 / r;                       // two units of unpainted rim
    var a0 = -Math.PI / 2;
    var g = L.mk('g', null, svg);
    slices.forEach(function (it) {
      var frac = it.value / total;
      var a1 = a0 + frac * Math.PI * 2;
      var pa0 = a0, pa1 = a1;
      if (a1 - a0 > 2 * delta && slices.length > 1) { pa0 += delta / 2; pa1 -= delta / 2; }
      var large = (pa1 - pa0) > Math.PI ? 1 : 0;
      var d;
      if (frac >= 0.9999) {
        d = 'M' + num(cx) + ' ' + num(cy - r) + 'A' + num(r) + ' ' + num(r) + ' 0 1 1 ' + num(cx - 0.01) + ' ' + num(cy - r) + 'Z';
        if (inner) d += 'M' + num(cx) + ' ' + num(cy - inner) + 'A' + num(inner) + ' ' + num(inner) + ' 0 1 0 ' + num(cx - 0.01) + ' ' + num(cy - inner) + 'Z';
      } else {
        var x0 = cx + r * Math.cos(pa0), y0 = cy + r * Math.sin(pa0);
        var x1 = cx + r * Math.cos(pa1), y1 = cy + r * Math.sin(pa1);
        if (inner) {
          var ix0 = cx + inner * Math.cos(pa0), iy0 = cy + inner * Math.sin(pa0);
          var ix1 = cx + inner * Math.cos(pa1), iy1 = cy + inner * Math.sin(pa1);
          d = 'M' + num(x0) + ' ' + num(y0) + 'A' + num(r) + ' ' + num(r) + ' 0 ' + large + ' 1 ' + num(x1) + ' ' + num(y1) +
              'L' + num(ix1) + ' ' + num(iy1) + 'A' + num(inner) + ' ' + num(inner) + ' 0 ' + large + ' 0 ' + num(ix0) + ' ' + num(iy0) + 'Z';
        } else {
          d = 'M' + num(cx) + ' ' + num(cy) + 'L' + num(x0) + ' ' + num(y0) + 'A' + num(r) + ' ' + num(r) + ' 0 ' + large + ' 1 ' + num(x1) + ' ' + num(y1) + 'Z';
        }
      }
      var path = L.mk('path', { d: d, 'fill-rule': 'evenodd' }, g);
      if (it.slot >= 0) path.style.fill = 'var(--ch-' + (it.slot + 1) + ', ' + it.colour + ')';
      else path.setAttribute('fill', it.colour);
      L.tip(path, it.name + ' = ' + L.label(it.value) + '（' + Math.round(frac * 1000) / 10 + '%）');
      if (s.labels && !L.marksOnly && frac >= 0.05) {
        var mid = (a0 + a1) / 2;
        var lr = inner ? 0.75 * r : 0.62 * r;
        var txt = Math.round(frac * 100) + '%';
        var chord = 2 * lr * Math.sin((a1 - a0) / 2);
        var room = inner ? (r - inner >= L.fs + 4) : true;
        if (chord >= estWidth(txt, L.fs * 0.9) + 4 && room) {
          L.text(g, cx + lr * Math.cos(mid), cy + lr * Math.sin(mid), txt, {
            'font-size': num(L.fs * 0.9), 'text-anchor': 'middle', dy: '0.35em', fill: inkOn(it.colour)
          });
        }
      }
      a0 = a1;
    });
  }

  /** Every non-null value's category, for the hit rect's readout. */
  function readout(s, i, m) {
    var lines = [s.categories[i]];
    s.series.slice(0, m).forEach(function (ser) {
      var v = ser.values[i];
      lines.push(ser.name + ' = ' + (v === null ? '（無）' : fmtValue(v, s.numFmt)));
    });
    return lines.join('\n');
  }

  /**
   * Bars, lines and areas: one category axis, one value axis, a baseline at
   * zero. Bars always include zero (a bar is a length from the baseline);
   * a line keeps zero only while the data is within reach of it.
   */
  function drawCartesian(svg, s, t, L) {
    var n = s.categories.length;
    var m = L.m;
    var fs = L.fs;
    var horizontal = !!t.horizontal;
    var stacked = !!t.stacked;
    var series = s.series.slice(0, m);

    // Value extent. Stacks are measured as their positive and negative totals.
    var lo = Infinity, hi = -Infinity;
    var posTot = [], negTot = [];
    for (var i = 0; i < n; i++) {
      var p = 0, q = 0;
      series.forEach(function (ser) {
        var v = ser.values[i];
        if (v === null) return;
        if (stacked) { if (v >= 0) p += v; else q += v; }
        else { if (v > hi) hi = v; if (v < lo) lo = v; }
      });
      posTot.push(p); negTot.push(q);
      if (stacked) { if (p > hi) hi = p; if (q < lo) lo = q; }
    }
    if (lo === Infinity) { lo = 0; hi = 0; }
    var wantLabels = s.labels && !L.marksOnly;
    if (wantLabels && t.family !== 'area') {
      var room = (hi - lo) * 0.08 || Math.abs(hi) * 0.08 || 1;
      if (hi > 0) hi += room;
      if (lo < 0) lo -= room;
    }

    var left = L.left, right = L.right, top = L.top, bottom = L.bottom;
    var afs = fs * 0.9;
    var cfs = fs * 0.9;
    var axisTitleH = fs * 1.4;
    var yTitle = L.showAxes ? (horizontal ? s.xTitle : s.yTitle) : '';
    var xTitle = L.showAxes ? (horizontal ? s.yTitle : s.xTitle) : '';
    if (yTitle) left += axisTitleH;
    if (xTitle) bottom -= axisTitleH;

    var scale = niceScale(lo, hi, {
      count: Math.max(3, Math.min(7, Math.floor((horizontal ? right - left : bottom - top) / (3 * fs)))),
      zero: t.family === 'line' ? 'auto' : 'always'
    });
    var vlabels = scale.ticks.map(function (v) { return tickLabel(v, s.numFmt, scale.decimals); });
    var vlabelW = vlabels.reduce(function (a, l) { return Math.max(a, estWidth(l, afs)); }, 0);

    // Category labels: on one line, on two, or every k-th.
    var catW = s.categories.reduce(function (a, c) { return Math.max(a, estWidth(c, cfs)); }, 0);
    var plotLeft, plotRight, plotTop, plotBottom;
    var catLines = 1, every = 1;
    if (horizontal) {
      var gutter = Math.min(catW, (right - left) * 0.30) + 8;
      plotLeft = left + (L.showAxes ? gutter : 0);
      /* The value axis runs along the foot here, and its last label is centred
         on the last tick -- which sits at the right edge of the plot. Half of
         it hangs off the picture unless the plot stops short by that much. */
      var lastW = L.showAxes && vlabels.length ? estWidth(vlabels[vlabels.length - 1], afs) : 0;
      plotRight = right - Math.max(4, lastW / 2);
      plotTop = top + 4;
      plotBottom = bottom - (L.showAxes ? afs * 1.6 : 0);
    } else {
      plotLeft = left + (L.showAxes ? vlabelW + 8 : 0);
      plotRight = right - (L.showAxes ? 12 : 4);
      plotTop = top + fs * 0.5;
      var band0 = (plotRight - plotLeft) / n;
      if (L.showAxes) {
        if (catW + 6 > band0) {
          var wraps = s.categories.map(function (c) { return wrapTwo(c, cfs, band0 - 6); });
          if (wraps.every(function (w, i2) { return w || estWidth(s.categories[i2], cfs) + 6 <= band0; })) catLines = 2;
          else every = Math.max(Math.ceil((catW + 6) / band0), Math.ceil(n / 12));
        }
      }
      plotBottom = bottom - (L.showAxes ? (catLines === 2 ? 2.4 : 1.3) * cfs : 0);
    }
    var plotW = Math.max(10, plotRight - plotLeft);
    var plotH = Math.max(10, plotBottom - plotTop);

    function vpos(v) {   // value -> coordinate along the value axis
      var f = (v - scale.min) / (scale.max - scale.min || 1);
      return horizontal ? plotLeft + f * plotW : plotBottom - f * plotH;
    }
    var band = (horizontal ? plotH : plotW) / n;
    function cpos(i) { return (horizontal ? plotTop : plotLeft) + band * (i + 0.5); }

    var g = L.mk('g', null, svg);
    // Gridlines and value labels.
    scale.ticks.forEach(function (v, k) {
      var c = half(vpos(v));
      if (horizontal) {
        L.hair(g, c, plotTop, c, plotBottom, v === 0);
        if (L.showAxes) L.dimText(g, c, plotBottom + afs * 1.15, vlabels[k], { 'font-size': num(afs), 'text-anchor': 'middle', style: 'font-variant-numeric: tabular-nums' });
      } else {
        L.hair(g, plotLeft, c, plotRight, c, v === 0);
        if (L.showAxes) L.dimText(g, plotLeft - 6, c, vlabels[k], { 'font-size': num(afs), 'text-anchor': 'end', dy: '0.35em', style: 'font-variant-numeric: tabular-nums' });
      }
    });
    // The baseline when zero is off the scale.
    if (scale.min > 0 || scale.max < 0) {
      if (horizontal) L.hair(g, half(plotLeft), plotTop, half(plotLeft), plotBottom, true);
      else L.hair(g, plotLeft, half(plotBottom), plotRight, half(plotBottom), true);
    }

    // Category labels.
    if (L.showAxes) {
      for (var ci = 0; ci < n; ci++) {
        if (ci % every) continue;
        if (horizontal) {
          L.dimText(g, plotLeft - 6, cpos(ci), fitText(s.categories[ci], cfs, plotLeft - left - 8),
            { 'font-size': num(cfs), 'text-anchor': 'end', dy: '0.35em' });
        } else if (catLines === 2) {
          var lines = wrapTwo(s.categories[ci], cfs, band - 6) || [fitText(s.categories[ci], cfs, band - 6)];
          var tn = L.dimText(g, cpos(ci), plotBottom + cfs * 1.15, lines[0], { 'font-size': num(cfs), 'text-anchor': 'middle' });
          if (lines[1]) {
            var ts = L.mk('tspan', { x: num(cpos(ci)), dy: num(cfs * 1.1) }, tn);
            ts.appendChild(document.createTextNode(lines[1]));
          }
        } else {
          L.dimText(g, cpos(ci), plotBottom + cfs * 1.15, fitText(s.categories[ci], cfs, band * every - 6),
            { 'font-size': num(cfs), 'text-anchor': 'middle' });
        }
      }
      if (xTitle) L.dimText(g, (plotLeft + plotRight) / 2, bottom + fs * 1.05, xTitle, { 'font-size': num(fs * 0.9), 'text-anchor': 'middle' });
      if (yTitle) {
        var yx = L.left + fs * 0.5, yy = (plotTop + plotBottom) / 2;
        L.dimText(g, yx, yy, yTitle, { 'font-size': num(fs * 0.9), 'text-anchor': 'middle', transform: 'rotate(-90 ' + num(yx) + ' ' + num(yy) + ')' });
      }
    }

    // Hit areas: one per category, reading out every series.
    if (L.tips) {
      var hits = L.mk('g', null, svg);
      for (var hi2 = 0; hi2 < n; hi2++) {
        var hr = horizontal
          ? L.mk('rect', { x: num(plotLeft), y: num(plotTop + band * hi2), width: num(plotW), height: num(band), fill: '#000', 'fill-opacity': 0 }, hits)
          : L.mk('rect', { x: num(plotLeft + band * hi2), y: num(plotTop), width: num(band), height: num(plotH), fill: '#000', 'fill-opacity': 0 }, hits);
        L.tip(hr, readout(s, hi2, m));
      }
    }

    var marks = L.mk('g', null, svg);
    var zero = vpos(Math.max(scale.min, Math.min(scale.max, 0)));
    var dfs = fs * 0.85;
    var boxes = [];   // placed data labels, for collision
    function place(x, y, w, h) {
      var hitBox = boxes.some(function (b) { return x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y; });
      if (!hitBox) boxes.push({ x: x, y: y, w: w, h: h });
      return !hitBox;
    }
    function tipText(i, k) {
      return s.categories[i] + '：' + series[k].name + ' = ' + L.label(series[k].values[i]);
    }
    var faint = function (k) { return L.isStatic && !s.labels && FAINT_SLOTS.indexOf(slotOf(s, k)) >= 0; };

    if (t.family === 'bar') {
      var thick, slot, groupStart;
      if (stacked) { thick = Math.min(band * 0.7, 24); slot = thick; groupStart = -thick / 2; }
      else {
        thick = Math.min(24, (0.7 * band - 2 * (m - 1)) / m);
        var gapB = 2;
        if (thick < 2) { thick = Math.max(1, 0.7 * band / m); gapB = 0; }
        slot = thick + gapB;
        groupStart = -(m * thick + (m - 1) * gapB) / 2;
      }
      var posBase = [], negBase = [];
      for (i = 0; i < n; i++) { posBase.push(0); negBase.push(0); }
      var maxPerSeries = series.map(function (ser) {
        var best = -1, bv = -Infinity;
        ser.values.forEach(function (v, i2) { if (v !== null && Math.abs(v) > bv) { bv = Math.abs(v); best = i2; } });
        return best;
      });
      series.forEach(function (ser, k) {
        for (var i2 = 0; i2 < n; i2++) {
          var v = ser.values[i2];
          if (v === null) continue;
          var base = 0;
          if (stacked) { base = v >= 0 ? posBase[i2] : negBase[i2]; if (v >= 0) posBase[i2] += v; else negBase[i2] += v; }
          var a = vpos(base), b = vpos(base + v);
          var c = cpos(i2) + (stacked ? groupStart : groupStart + k * slot);
          var lo2 = Math.min(a, b), hi2b = Math.max(a, b);
          // Stacked segments after the first sit two units off the one beneath.
          if (stacked && base !== 0) {
            if ((v >= 0) !== horizontal) lo2 += 2; else hi2b -= 2;
          }
          var len = hi2b - lo2;
          if (len < 1) continue;
          var outer = !stacked || (v >= 0 ? posTot[i2] === posBase[i2] : negTot[i2] === negBase[i2]);
          var rr = outer ? Math.min(4, thick / 2, len) : 0;
          var d;
          var endAtHi = horizontal ? (v >= 0) : (v < 0);   // the data end sits at hi2b
          if (horizontal) {
            var y0 = c, y1 = c + thick, xa = lo2, xb = hi2b;
            if (endAtHi) d = 'M' + num(xa) + ' ' + num(y0) + 'H' + num(xb - rr) + 'A' + rr + ' ' + rr + ' 0 0 1 ' + num(xb) + ' ' + num(y0 + rr) + 'V' + num(y1 - rr) + 'A' + rr + ' ' + rr + ' 0 0 1 ' + num(xb - rr) + ' ' + num(y1) + 'H' + num(xa) + 'Z';
            else d = 'M' + num(xb) + ' ' + num(y0) + 'H' + num(xa + rr) + 'A' + rr + ' ' + rr + ' 0 0 0 ' + num(xa) + ' ' + num(y0 + rr) + 'V' + num(y1 - rr) + 'A' + rr + ' ' + rr + ' 0 0 0 ' + num(xa + rr) + ' ' + num(y1) + 'H' + num(xb) + 'Z';
          } else {
            var x0 = c, x1 = c + thick, ya = lo2, yb = hi2b;
            if (!endAtHi) d = 'M' + num(x0) + ' ' + num(yb) + 'V' + num(ya + rr) + 'A' + rr + ' ' + rr + ' 0 0 1 ' + num(x0 + rr) + ' ' + num(ya) + 'H' + num(x1 - rr) + 'A' + rr + ' ' + rr + ' 0 0 1 ' + num(x1) + ' ' + num(ya + rr) + 'V' + num(yb) + 'Z';
            else d = 'M' + num(x0) + ' ' + num(ya) + 'V' + num(yb - rr) + 'A' + rr + ' ' + rr + ' 0 0 0 ' + num(x0 + rr) + ' ' + num(yb) + 'H' + num(x1 - rr) + 'A' + rr + ' ' + rr + ' 0 0 0 ' + num(x1) + ' ' + num(yb - rr) + 'V' + num(ya) + 'Z';
          }
          var path = L.mk('path', { d: d }, marks);
          L.paint(path, k, 'fill');
          L.tip(path, tipText(i2, k));

          // Segment labels inside a stack, when the segment can hold them.
          if (wantLabels && stacked) {
            var txt = L.label(v);
            var tw = estWidth(txt, dfs);
            if (thick >= dfs + 2 && (horizontal ? len >= tw + 4 : len >= dfs * 1.2 && tw <= thick + 2)) {
              L.text(marks, horizontal ? (lo2 + hi2b) / 2 : c + thick / 2, horizontal ? c + thick / 2 : (lo2 + hi2b) / 2, txt,
                { 'font-size': num(dfs), 'text-anchor': 'middle', dy: '0.35em', fill: inkOn(colourOf(s, k)) });
            }
          } else if (!stacked && (wantLabels || (faint(k) && i2 === maxPerSeries[k]))) {
            var txt2 = L.label(v);
            var tw2 = estWidth(txt2, dfs);
            // A relief label is one per series, so it only has to avoid the
            // others that were placed; a label the user asked for on every bar
            // must also fit its own slot or the row of them becomes a smear.
            var relief = !wantLabels;
            if (horizontal) {
              var lx = v >= 0 ? hi2b + 4 : lo2 - 4;
              var fits = v >= 0 ? lx + tw2 <= plotRight + 12 : lx - tw2 >= plotLeft - 2;
              if (fits && place(v >= 0 ? lx : lx - tw2, c, tw2, thick)) {
                L.text(marks, lx, c + thick / 2, txt2, { 'font-size': num(dfs), 'text-anchor': v >= 0 ? 'start' : 'end', dy: '0.35em' });
              } else if (len >= tw2 + 8) {
                L.text(marks, (lo2 + hi2b) / 2, c + thick / 2, txt2, { 'font-size': num(dfs), 'text-anchor': 'middle', dy: '0.35em', fill: inkOn(colourOf(s, k)) });
              }
            } else if (tw2 <= slot + 2 || m === 1 || relief) {
              var ly = v >= 0 ? lo2 - 3 : hi2b + dfs;
              if (place(c + thick / 2 - tw2 / 2, ly - dfs, tw2, dfs * 1.2)) {
                L.text(marks, c + thick / 2, ly, txt2, { 'font-size': num(dfs), 'text-anchor': 'middle' });
              }
            }
          }
        }
      });
      // Stack totals at the outer end of each sign.
      if (wantLabels && stacked) {
        for (var i3 = 0; i3 < n; i3++) {
          [posTot[i3], negTot[i3]].forEach(function (tot, sign) {
            if (!tot) return;
            var txt3 = L.label(tot);
            var e = vpos(tot);
            var c3 = cpos(i3);
            if (horizontal) {
              L.text(marks, sign ? e - 4 : e + 4, c3, txt3, { 'font-size': num(dfs), 'text-anchor': sign ? 'end' : 'start', dy: '0.35em' });
            } else if (estWidth(txt3, dfs) <= band - 2) {
              L.text(marks, c3, sign ? e + dfs : e - 3, txt3, { 'font-size': num(dfs), 'text-anchor': 'middle' });
            }
          });
        }
      }
      return;
    }

    /* Lines and areas. A null is a gap in a line; in a stack it counts as
       nothing so the layers above still add up. Stacks are sign-separated:
       positive layers pile up from zero, negative ones pile down. */
    var showMarkers = band >= 10;
    var labelEvery = (wantLabels && n * m <= 36) ? 1 : 0;   // 0 = last point and maximum only
    if (stacked) {
      var upTop = [], downTop = [];
      for (i = 0; i < n; i++) { upTop.push(0); downTop.push(0); }
      var layers = series.map(function (ser) {
        var lower = [], upper = [];
        ser.values.forEach(function (v, i2) {
          var val = v === null ? 0 : v;
          if (val >= 0) { lower.push(upTop[i2]); upTop[i2] += val; upper.push(upTop[i2]); }
          else { lower.push(downTop[i2]); downTop[i2] += val; upper.push(downTop[i2]); }
        });
        return { lower: lower, upper: upper };
      });
      // The top of the stack first, so lower layers paint over it.
      for (var k2 = series.length - 1; k2 >= 0; k2--) {
        (function (k) {
          var lay = layers[k];
          var d = '';
          var runStart = -1;
          for (var i2 = 0; i2 <= n; i2++) {
            var v = i2 < n ? series[k].values[i2] : null;
            var sign = v === null ? 0 : (v >= 0 ? 1 : -1);
            var prevSign = runStart >= 0 ? (series[k].values[i2 - 1] >= 0 ? 1 : -1) : 0;
            if (v === null || (runStart >= 0 && sign !== prevSign)) {
              if (runStart >= 0 && i2 - 1 >= runStart) {
                var path = 'M' + num(cpos(runStart)) + ' ' + num(vpos(lay.upper[runStart]));
                for (var j = runStart + 1; j <= i2 - 1; j++) path += 'L' + num(cpos(j)) + ' ' + num(vpos(lay.upper[j]));
                for (var j2 = i2 - 1; j2 >= runStart; j2--) path += 'L' + num(cpos(j2)) + ' ' + num(vpos(lay.lower[j2]));
                path += 'Z';
                var area = L.mk('path', { d: path, 'fill-opacity': 0.18 }, marks);
                L.paint(area, k, 'fill');
                L.tip(area, series[k].name);
                var ln = 'M' + num(cpos(runStart)) + ' ' + num(vpos(lay.upper[runStart]));
                for (var j3 = runStart + 1; j3 <= i2 - 1; j3++) ln += 'L' + num(cpos(j3)) + ' ' + num(vpos(lay.upper[j3]));
                var line = L.mk('path', { d: ln, fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, marks);
                L.paint(line, k, 'stroke');
              }
              runStart = v === null ? -1 : i2;
            } else if (runStart < 0) runStart = i2;
          }
          void d;
        })(k2);
      }
      if (wantLabels) {
        series.forEach(function (ser, k) {
          for (var i4 = 0; i4 < n; i4++) {
            var v2 = ser.values[i4];
            if (v2 === null || (labelEvery === 0 && i4 !== n - 1)) continue;
            var mid = vpos((layers[k].upper[i4] + layers[k].lower[i4]) / 2);
            var txt4 = L.label(v2);
            var tw4 = estWidth(txt4, dfs);
            if (tw4 <= band * 0.9 && Math.abs(vpos(layers[k].upper[i4]) - vpos(layers[k].lower[i4])) >= dfs * 1.2 &&
                place(cpos(i4) - tw4 / 2, mid - dfs * 0.6, tw4, dfs * 1.2)) {
              L.text(marks, cpos(i4), mid, txt4, { 'font-size': num(dfs), 'text-anchor': 'middle', dy: '0.35em', fill: inkOn(colourOf(s, k)) });
            }
          }
        });
      }
      return;
    }

    series.forEach(function (ser, k) {
      var runs = [];
      var run = [];
      for (var i5 = 0; i5 < n; i5++) {
        if (ser.values[i5] === null) { if (run.length) runs.push(run); run = []; continue; }
        run.push(i5);
      }
      if (run.length) runs.push(run);
      runs.forEach(function (r) {
        var d = '';
        r.forEach(function (i6, j) { d += (j ? 'L' : 'M') + num(cpos(i6)) + ' ' + num(vpos(ser.values[i6])); });
        if (t.family === 'area') {
          var ad = d + 'L' + num(cpos(r[r.length - 1])) + ' ' + num(zero) + 'L' + num(cpos(r[0])) + ' ' + num(zero) + 'Z';
          var area = L.mk('path', { d: ad, 'fill-opacity': 0.12 }, marks);
          L.paint(area, k, 'fill');
          L.tip(area, ser.name);
        }
        if (r.length > 1) {
          var line = L.mk('path', { d: d, fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, marks);
          L.paint(line, k, 'stroke');
        }
      });
      var maxAt = -1, maxV = -Infinity, lastAt = -1;
      ser.values.forEach(function (v, i7) { if (v !== null) { lastAt = i7; if (v > maxV) { maxV = v; maxAt = i7; } } });
      for (var i8 = 0; i8 < n; i8++) {
        var v3 = ser.values[i8];
        if (v3 === null) continue;
        if (showMarkers || runs.some(function (r) { return r.length === 1 && r[0] === i8; })) {
          var dot = L.mk('circle', { cx: num(cpos(i8)), cy: num(vpos(v3)), r: 4 }, marks);
          L.paint(dot, k, 'fill');
          if (L.surface) { dot.setAttribute('stroke', L.surface); dot.setAttribute('stroke-width', '2'); }
          L.tip(dot, tipText(i8, k));
        }
        var want = wantLabels ? (labelEvery === 1 ? (i8 % every === 0) : (i8 === lastAt || i8 === maxAt))
                              : (faint(k) && (i8 === lastAt || i8 === maxAt));
        if (want) {
          var txt5 = L.label(v3);
          var tw5 = estWidth(txt5, dfs);
          if (place(cpos(i8) - tw5 / 2, vpos(v3) - 7 - dfs, tw5, dfs * 1.2)) {
            L.text(marks, cpos(i8), vpos(v3) - 7, txt5, { 'font-size': num(dfs), 'text-anchor': 'middle' });
          }
        }
      }
    });
  }

  /** Two value axes; categories are the x values. At most three series. */
  function drawScatter(svg, s, L) {
    var fs = L.fs;
    var m = L.m;
    var series = s.series.slice(0, m);
    var xs = s.categories.map(function (c) { return toNumber(c); });
    var pts = [];
    var xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity;
    series.forEach(function (ser, k) {
      ser.values.forEach(function (v, i) {
        if (v === null || xs[i] === null) return;
        pts.push({ x: xs[i], y: v, k: k, i: i });
        if (xs[i] < xlo) xlo = xs[i]; if (xs[i] > xhi) xhi = xs[i];
        if (v < ylo) ylo = v; if (v > yhi) yhi = v;
      });
    });
    var g = L.mk('g', null, svg);
    if (!pts.length) {
      L.dimText(g, (L.left + L.right) / 2, (L.top + L.bottom) / 2, '（散佈圖的類別要是數字）', { 'text-anchor': 'middle', dy: '0.35em' });
      return;
    }
    var padX = (xhi - xlo) * 0.05, padY = (yhi - ylo) * 0.05;
    var sy = niceScale(ylo - padY, yhi + padY, { count: Math.max(3, Math.min(7, Math.floor((L.bottom - L.top) / (3 * fs)))), zero: 'auto' });
    var afs = fs * 0.9;
    var ylabels = sy.ticks.map(function (v) { return tickLabel(v, s.numFmt, sy.decimals); });
    var ylabelW = ylabels.reduce(function (a, l) { return Math.max(a, estWidth(l, afs)); }, 0);
    var left = L.left + (s.yTitle && L.showAxes ? fs * 1.4 : 0);
    var bottom = L.bottom - (s.xTitle && L.showAxes ? fs * 1.4 : 0);
    var plotLeft = left + (L.showAxes ? ylabelW + 8 : 0), plotRight = L.right - 12, plotTop = L.top + fs * 0.5, plotBottom = bottom - (L.showAxes ? afs * 1.6 : 0);
    var plotW = Math.max(10, plotRight - plotLeft), plotH = Math.max(10, plotBottom - plotTop);
    var sx = niceScale(xlo - padX, xhi + padX, { count: Math.max(3, Math.min(7, Math.floor(plotW / (estWidth(plainNumber(xhi), afs) + 12)))), zero: 'never' });
    function px(x) { return plotLeft + (x - sx.min) / (sx.max - sx.min || 1) * plotW; }
    function py(y) { return plotBottom - (y - sy.min) / (sy.max - sy.min || 1) * plotH; }
    sy.ticks.forEach(function (v, k) {
      L.hair(g, plotLeft, half(py(v)), plotRight, half(py(v)), v === 0);
      if (L.showAxes) L.dimText(g, plotLeft - 6, half(py(v)), ylabels[k], { 'font-size': num(afs), 'text-anchor': 'end', dy: '0.35em', style: 'font-variant-numeric: tabular-nums' });
    });
    sx.ticks.forEach(function (v) {
      L.hair(g, half(px(v)), plotTop, half(px(v)), plotBottom, v === 0);
      if (L.showAxes) L.dimText(g, half(px(v)), plotBottom + afs * 1.15, tickLabel(v, '', sx.decimals), { 'font-size': num(afs), 'text-anchor': 'middle', style: 'font-variant-numeric: tabular-nums' });
    });
    L.hair(g, plotLeft, half(plotBottom), plotRight, half(plotBottom), true);
    L.hair(g, half(plotLeft), plotTop, half(plotLeft), plotBottom, true);
    if (L.showAxes && s.xTitle) L.dimText(g, (plotLeft + plotRight) / 2, bottom + fs * 1.05, s.xTitle, { 'font-size': num(fs * 0.9), 'text-anchor': 'middle' });
    if (L.showAxes && s.yTitle) {
      var yx = L.left + fs * 0.5, yy = (plotTop + plotBottom) / 2;
      L.dimText(g, yx, yy, s.yTitle, { 'font-size': num(fs * 0.9), 'text-anchor': 'middle', transform: 'rotate(-90 ' + num(yx) + ' ' + num(yy) + ')' });
    }
    var marks = L.mk('g', null, svg);
    pts.forEach(function (p) {
      if (L.tips) {
        var hit = L.mk('circle', { cx: num(px(p.x)), cy: num(py(p.y)), r: 12, fill: '#000', 'fill-opacity': 0 }, marks);
        L.tip(hit, series[p.k].name + '：(' + plainNumber(p.x) + ', ' + L.label(p.y) + ')');
      }
      var dot = L.mk('circle', { cx: num(px(p.x)), cy: num(py(p.y)), r: 4.5 }, marks);
      L.paint(dot, p.k, 'fill');
      if (L.surface) { dot.setAttribute('stroke', L.surface); dot.setAttribute('stroke-width', '2'); }
      L.tip(dot, series[p.k].name + '：(' + plainNumber(p.x) + ', ' + L.label(p.y) + ')');
      if (s.labels && !L.marksOnly) L.text(marks, px(p.x), py(p.y) - 8, L.label(p.y), { 'font-size': num(fs * 0.85), 'text-anchor': 'middle' });
    });
  }

  function svgString(spec, opts) {
    return render(spec, opts).outerHTML;
  }

  /* --------------------------------------------------------- tables in */

  /**
   * Rows out of pasted text: tab-separated (what a spreadsheet copies), a
   * Markdown pipe table, or comma-separated with quotes. Chosen per text, not
   * per line, so a comma inside a TSV cell stays a comma.
   */
  function parseTable(text) {
    var src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    var lines = src.split('\n').filter(function (l) { return l.trim() !== ''; });
    if (!lines.length) return [];
    var pipe = lines.every(function (l) { return /^\s*\|.*\|\s*$/.test(l); });
    if (pipe) {
      return lines.filter(function (l) { return !/^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(l); })
        .map(function (l) {
          return l.trim().replace(/^\|/, '').replace(/\|$/, '').replace(/\\\|/g, '\uE000')
            .split('|').map(function (c) { return c.trim().replace(/\uE000/g, '|'); });
        });
    }
    if (lines.some(function (l) { return l.indexOf('\t') >= 0; })) {
      return lines.map(function (l) { return l.split('\t').map(function (c) { return c.trim(); }); });
    }
    var sep = lines.some(function (l) { return l.indexOf(',') >= 0; }) ? ','
      : lines.some(function (l) { return l.indexOf('、') >= 0; }) ? '、' : null;
    if (!sep) return lines.map(function (l) { return l.trim().split(/\s{2,}|\s+/); });
    return lines.map(function (l) {
      var out = [], cur = '', q = false;
      for (var i = 0; i < l.length; i++) {
        var ch = l.charAt(i);
        if (q) {
          if (ch === '"') { if (l.charAt(i + 1) === '"') { cur += '"'; i++; } else q = false; }
          else cur += ch;
        } else if (ch === '"') q = true;
        else if (ch === sep) { out.push(cur.trim()); cur = ''; }
        else cur += ch;
      }
      out.push(cur.trim());
      return out;
    });
  }

  /* --------------------------------------------------------- clipboard */

  /* A copied chart is held here, in the renderer, and its data goes to the
     system clipboard as tab-separated numbers -- what a person wants when they
     paste into some other program. The two are matched the way the spreadsheet
     matches its own copies: the rich object is trusted only while the system
     clipboard still holds exactly the text that was written with it. */
  var clip = null;

  function normText(text) {
    return String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  }
  function copy(spec) {
    var s = norm(spec);
    var text = tsv(toRows(s, { raw: true }));
    clip = { spec: s, text: normText(text) };
    var bridge = typeof window !== 'undefined' && window.aios && window.aios.clipboard;
    if (bridge && bridge.write) return bridge.write(text).then(function () { return text; });
    return Promise.resolve(text);
  }
  function pasteMatches(text) {
    return !!(clip && text && normText(text) === clip.text);
  }
  function clipSpec() { return clip ? norm(clip.spec) : null; }
  function clearClip() { clip = null; }

  /* ----------------------------------------------------------- send to */

  var APP_NAMES = { docs: '文件', slides: '簡報', sheets: '試算表' };
  var INSERT_ACTION = { docs: 'insertChart', slides: 'addChart', sheets: 'insertChart' };

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /**
   * Hand a chart to another program: the focused window of that program, the
   * one in front, or a freshly opened one, through the same action the model
   * would call. `opts` travels with the chart (an aspect, a slide request).
   * Resolves with the action's result.
   */
  async function sendTo(appId, spec, opts) {
    var action = INSERT_ACTION[appId];
    if (!action || !AIOS || !AIOS.apps) throw new Error('沒有這個程式：' + appId);
    var s = norm(spec);
    var apps = AIOS.apps;
    var live = apps.instances().filter(function (i) { return i.def.id === appId; });
    var inst = live.find(function (i) { return i.win && i.win.el && i.win.el.classList.contains('focus'); });
    if (!inst && live.length) {
      inst = live.slice().sort(function (a, b) { return ((b.win && b.win.z) || 0) - ((a.win && a.win.z) || 0); })[0];
    }
    var win = inst ? inst.win : await apps.launch(appId, undefined, { forceNew: false });
    for (var k = 0; k < 40; k++) {
      inst = apps.instances().find(function (i) { return i.win === win; });
      if (inst && inst.ctx && inst.ctx.api) break;
      await wait(100);
    }
    if (!inst || !inst.ctx || !inst.ctx.api) throw new Error(APP_NAMES[appId] + '沒有開起來');
    /* A chart arriving in a deck gets a page of its own unless the caller says
       otherwise: dropping it onto whichever slide happened to be in front lands
       it on top of that slide's own content, which is never what was meant by
       「插入到簡報」. The sending program does not have to know this; it is a
       fact about decks, so it lives on this side of the road. */
    var args = Object.assign({ chart: s }, opts || {});
    /* 「放在第 2 頁」: a page the caller named is that page, not a new one after
       it. A plan that builds the deck first reserves a page for the chart, and
       without this the chart landed on a fresh page while the reserved one
       stayed empty -- measured as a three-page plan saved as four pages. */
    if (args.page !== undefined && args.page !== null && args.page !== '') {
      if (appId === 'slides') {
        args.index = Number(args.page);
        args.newSlide = false;
      }
      delete args.page;
    }
    if (appId === 'slides' && args.newSlide === undefined) args.newSlide = true;
    var out = await apps.invoke(appId, action, args, win);
    if (AIOS.wm && AIOS.wm.focus && win) { try { AIOS.wm.focus(win); } catch (e) { /* not fatal */ } }
    return out;
  }

  /** Menu items 插入到文件／簡報／試算表 for the other programs, worded once. */
  function sendMenuItems(spec, exclude, toast, opts) {
    return Object.keys(APP_NAMES).filter(function (id) { return id !== exclude; }).map(function (id) {
      return {
        label: '插入到' + APP_NAMES[id],
        run: function () {
          var s = typeof spec === 'function' ? spec() : spec;
          sendTo(id, s, typeof opts === 'function' ? opts(id) : opts).then(function (out) {
            if (toast) toast((out && out.note) || ('已插入到' + APP_NAMES[id]), 't-ok');
          }, function (e) {
            if (toast) toast('插入失敗：' + (e && e.message ? e.message : e), 't-err');
          });
        }
      };
    });
  }

  /* ------------------------------------------------------------- panel */

  /** A small type glyph: the chart's family drawn in a 22x14 box. */
  function typeGlyph(id) {
    var t = typeOf(id);
    var g = document.createElementNS(SVG_NS, 'svg');
    g.setAttribute('viewBox', '0 0 22 14');
    g.setAttribute('width', '22');
    g.setAttribute('height', '14');
    g.setAttribute('aria-hidden', 'true');
    function add(tag, attrs) {
      var n = document.createElementNS(SVG_NS, tag);
      Object.keys(attrs).forEach(function (k) { n.setAttribute(k, String(attrs[k])); });
      g.appendChild(n);
    }
    var c = 'currentColor';
    if (t.family === 'bar' && !t.horizontal) {
      add('rect', { x: 2, y: 6, width: 4, height: 8, fill: c });
      add('rect', { x: 9, y: 2, width: 4, height: 12, fill: c, opacity: t.stacked ? 0.5 : 1 });
      add('rect', { x: 16, y: 8, width: 4, height: 6, fill: c });
      if (t.stacked) add('rect', { x: 9, y: 8, width: 4, height: 6, fill: c });
    } else if (t.family === 'bar') {
      add('rect', { x: 1, y: 1, width: 14, height: 3, fill: c });
      add('rect', { x: 1, y: 5.5, width: 20, height: 3, fill: c, opacity: t.stacked ? 0.5 : 1 });
      add('rect', { x: 1, y: 10, width: 9, height: 3, fill: c });
      if (t.stacked) add('rect', { x: 1, y: 5.5, width: 10, height: 3, fill: c });
    } else if (t.family === 'line') {
      add('polyline', { points: '1,12 7,5 12,9 20,2', fill: 'none', stroke: c, 'stroke-width': 1.6 });
    } else if (t.family === 'area') {
      add('path', { d: 'M1 13 L7 5 L12 9 L20 2 V13 Z', fill: c, opacity: t.stacked ? 0.45 : 0.35 });
      if (t.stacked) add('path', { d: 'M1 13 L7 9 L12 11 L20 7 V13 Z', fill: c });
      add('polyline', { points: '1,13 7,5 12,9 20,2', fill: 'none', stroke: c, 'stroke-width': 1.4 });
    } else if (t.family === 'pie') {
      add('circle', { cx: 11, cy: 7, r: 6, fill: 'none', stroke: c, 'stroke-width': t.hole ? 3 : 6, 'stroke-dasharray': '24 14' });
      if (!t.hole) add('path', { d: 'M11 7 L11 1 A6 6 0 0 1 17 7 Z', fill: c, opacity: 0.4 });
    } else {
      [[3, 10], [7, 6], [11, 8], [15, 3], [19, 5]].forEach(function (p) { add('circle', { cx: p[0], cy: p[1], r: 1.7, fill: c }); });
    }
    return g;
  }

  /**
   * The chart editor, built into a popover panel (`panelEl` is the `.ui-pop`
   * node; the popover itself is the caller's). One implementation for the
   * three programs: type, title, the data (a range in the spreadsheet, a table
   * of text elsewhere), which way the series run, what the first row and
   * column are, legend, labels, number format, axis titles.
   *
   * opts:
   *   spec          the chart being edited (or a starting point)
   *   mode          'data' (a table of text) or 'range' (a cell range)
   *   range         the current range text, range mode
   *   categories    a separate category range, range mode (optional)
   *   selection     the current selection's label, range mode: a button fills it in
   *   seriesIn      'auto' | 'cols' | 'rows'
   *   headers       { row: null|true|false, col: null|true|false }
   *   omitTotals    null | true | false
   *   note          a line under the heading
   *   detect(range) range mode: returns a one-line description of what the
   *                 range holds, shown live under the field
   *   onApply(spec, extras)   extras = { range, categories, seriesIn, headers, omitTotals } in
   *                 range mode; { seriesIn, headers, omitTotals, table: {…} } in data mode
   *   onCancel()
   *   applyLabel    text of the confirm button (default 套用)
   */
  function panel(panelEl, opts) {
    var o = opts || {};
    var host = panelEl;
    var s = norm(o.spec);
    var mode = o.mode === 'range' ? 'range' : 'data';
    var seriesIn = o.seriesIn === 'rows' ? 'rows' : o.seriesIn === 'cols' ? 'cols' : 'auto';
    var headers = { row: triState(o.headers && o.headers.row), col: triState(o.headers && o.headers.col) };
    var omitTotals = triState(o.omitTotals);
    var type = s.type;

    function triState(v) { return v === true ? true : v === false ? false : null; }
    function el(tag, cls, txt) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (txt != null) n.textContent = txt;
      return n;
    }
    function sub(label) { host.appendChild(el('div', 'ui-pop-sub', label)); }
    function field(value, placeholder, cls, parent) {
      var f = el('input', 'ui-pop-field' + (cls ? ' ' + cls : ''));
      f.type = 'text';
      f.value = value || '';
      if (placeholder) f.placeholder = placeholder;
      (parent || host).appendChild(f);
      return f;
    }
    function chip(row, label, on, onClick) {
      var b = el('button', 'fbtn' + (on ? ' on' : ''), label);
      b.type = 'button';
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', onClick);
      row.appendChild(b);
      return b;
    }
    function triSelect(row, label, current, onChange) {
      var wrap = el('label', 'ui-chart-inline');
      wrap.appendChild(el('span', null, label));
      var sel = el('select', 'ui-pop-field ui-chart-tri');
      [['auto', '自動'], ['yes', '是'], ['no', '否']].forEach(function (p) {
        var op = el('option', null, p[1]);
        op.value = p[0];
        sel.appendChild(op);
      });
      sel.value = current === true ? 'yes' : current === false ? 'no' : 'auto';
      sel.addEventListener('change', function () { onChange(sel.value === 'yes' ? true : sel.value === 'no' ? false : null); });
      wrap.appendChild(sel);
      row.appendChild(wrap);
      return sel;
    }

    if (o.note) host.appendChild(el('div', 'ui-pop-count', o.note));

    sub('類型');
    var grid = el('div', 'ui-chart-grid');
    var typeBtns = [];
    TYPES.forEach(function (t) {
      var b = el('button', 'ui-chart-btn' + (t.id === type ? ' on' : ''));
      b.type = 'button';
      b.title = t.name;
      b.dataset.type = t.id;
      b.appendChild(typeGlyph(t.id));
      b.appendChild(el('span', null, t.name));
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () {
        type = t.id;
        typeBtns.forEach(function (x) { x.classList.toggle('on', x.dataset.type === type); });
      });
      grid.appendChild(b);
      typeBtns.push(b);
    });
    host.appendChild(grid);

    sub('標題');
    var titleField = field(s.title, '（沒有標題）');

    var rangeField = null, catField = null, dataField = null, detectLine = null;
    if (mode === 'range') {
      sub('資料範圍');
      var rrow = el('div', 'ui-pop-row ui-chart-rangerow');
      rangeField = field(o.range || '', '例如 A1:D13 或 工作表2!A1:D13', 'ui-chart-range', rrow);
      if (o.selection) chip(rrow, '用目前選取', false, function () { rangeField.value = o.selection; sync(); });
      host.appendChild(rrow);
      sub('類別範圍（可留空：用第一欄或第一列）');
      catField = field(o.categories || '', '例如 A2:A13');
      detectLine = el('div', 'ui-pop-count');
      host.appendChild(detectLine);
      rangeField.addEventListener('input', sync);
      catField.addEventListener('input', sync);
    } else {
      sub('資料（第一列是數列名稱，第一欄是類別；可以直接從試算表貼上）');
      dataField = el('textarea', 'ui-pop-field ui-chart-data');
      dataField.rows = 8;
      dataField.spellcheck = false;
      dataField.value = tsv(toRows(s));
      // A tab is a column here, not the next control.
      dataField.addEventListener('keydown', function (e) {
        if (e.key !== 'Tab') return;
        e.preventDefault();
        var a = dataField.selectionStart, b = dataField.selectionEnd;
        dataField.value = dataField.value.slice(0, a) + '\t' + dataField.value.slice(b);
        dataField.selectionStart = dataField.selectionEnd = a + 1;
      });
      host.appendChild(dataField);
      detectLine = el('div', 'ui-pop-count');
      host.appendChild(detectLine);
      dataField.addEventListener('input', sync);
    }

    var orientRow = el('div', 'ui-pop-row');
    orientRow.appendChild(el('span', 'ui-chart-inline', '數列在'));
    var autoBtn = chip(orientRow, '自動', seriesIn === 'auto', function () { seriesIn = 'auto'; sync(); });
    var colsBtn = chip(orientRow, '欄', seriesIn === 'cols', function () { seriesIn = 'cols'; sync(); });
    var rowsBtn = chip(orientRow, '列', seriesIn === 'rows', function () { seriesIn = 'rows'; sync(); });
    host.appendChild(orientRow);
    var headRow = el('div', 'ui-pop-row');
    triSelect(headRow, '第一列是標題', headers.row, function (v) { headers.row = v; sync(); });
    triSelect(headRow, '第一欄是類別', headers.col, function (v) { headers.col = v; sync(); });
    triSelect(headRow, '略過合計', omitTotals, function (v) { omitTotals = v; sync(); });
    host.appendChild(headRow);

    function detectOpts() {
      return {
        seriesIn: seriesIn, headerRow: headers.row === null ? undefined : headers.row,
        headerCol: headers.col === null ? undefined : headers.col,
        omitTotals: omitTotals === null ? undefined : omitTotals
      };
    }
    function describeGot(got) {
      if (!got) return '';
      var bits = [];
      bits.push('標題列' + (got.layout.headerRow ? '✓' : '✗') + '　類別欄' + (got.layout.headerCol ? '✓' : '✗') +
        '　數列在' + (got.layout.seriesIn === 'rows' ? '列' : '欄'));
      bits.push(got.series.length + ' 個數列 × ' + got.categories.length + ' 個類別');
      if (got.omitted && got.omitted.length) bits.push('略過 ' + got.omitted.join('、'));
      if (got.skipped && got.skipped.length) bits.push('沒有數字：' + got.skipped.join('、'));
      if (got.series.length > MAX_SERIES) bits.push('只畫前 ' + MAX_SERIES + ' 個數列');
      return '偵測：' + bits.join('　·　');
    }
    function sync() {
      autoBtn.classList.toggle('on', seriesIn === 'auto');
      colsBtn.classList.toggle('on', seriesIn === 'cols');
      rowsBtn.classList.toggle('on', seriesIn === 'rows');
      if (!detectLine) return;
      try {
        if (mode === 'range') {
          detectLine.textContent = o.detect ? (o.detect(rangeField.value.trim(), Object.assign({ categories: catField.value.trim() }, detectOpts())) || '') : '';
        } else {
          var rows = parseTable(dataField.value);
          detectLine.textContent = rows.length ? describeGot(fromRows(rows, detectOpts())) : '';
        }
      } catch (e) {
        detectLine.textContent = e && e.message ? e.message : String(e);
      }
    }

    sub('圖例與標籤');
    var optRow = el('div', 'ui-pop-row');
    var legendSel = el('select', 'ui-pop-field ui-chart-legend');
    [['bottom', '圖例在下方'], ['right', '圖例在右側'], ['none', '不顯示圖例']].forEach(function (p) {
      var op = el('option', null, p[1]);
      op.value = p[0];
      legendSel.appendChild(op);
    });
    legendSel.value = s.legend;
    optRow.appendChild(legendSel);
    var labelWrap = el('label', 'ui-pop-check');
    var labelBox = el('input');
    labelBox.type = 'checkbox';
    labelBox.checked = !!s.labels;
    labelWrap.appendChild(labelBox);
    labelWrap.appendChild(el('span', null, '資料標籤'));
    optRow.appendChild(labelWrap);
    host.appendChild(optRow);

    sub('數字格式（Excel 格式碼，留空為一般）');
    var fmtField = field(s.numFmt, '例如 #,##0 或 NT$#,##0 或 0.0%');

    sub('座標軸標題');
    var axisRow = el('div', 'ui-pop-row ui-chart-axes');
    var xField = el('input', 'ui-pop-field');
    xField.type = 'text'; xField.placeholder = 'X 軸'; xField.value = s.xTitle;
    var yField = el('input', 'ui-pop-field');
    yField.type = 'text'; yField.placeholder = 'Y 軸'; yField.value = s.yTitle;
    axisRow.appendChild(xField);
    axisRow.appendChild(yField);
    host.appendChild(axisRow);

    var note = el('div', 'ui-pop-note');
    note.hidden = true;
    host.appendChild(note);
    function fail(msg) {
      note.textContent = msg;
      note.hidden = false;
    }

    var btnRow = el('div', 'ui-pop-row');
    var apply = el('button', 'fbtn fbtn-primary', o.applyLabel || '套用');
    apply.type = 'button';
    apply.addEventListener('mousedown', function (e) { e.preventDefault(); });
    apply.addEventListener('click', function () {
      note.hidden = true;
      var base = {
        type: type, title: titleField.value.trim(), legend: legendSel.value, labels: labelBox.checked,
        numFmt: fmtField.value.trim(), xTitle: xField.value.trim(), yTitle: yField.value.trim()
      };
      var extras = { seriesIn: seriesIn, headers: { row: headers.row, col: headers.col }, omitTotals: omitTotals };
      try {
        if (mode === 'range') {
          var range = rangeField.value.trim();
          if (!range) return fail('請填資料範圍，例如 A1:D13');
          extras.range = range;
          extras.categories = catField.value.trim();
          o.onApply(norm(Object.assign({}, s, base, { categories: s.categories, series: s.series })), extras);
        } else {
          var rows = parseTable(dataField.value);
          if (!rows.length) return fail('請填資料：第一列是數列名稱，第一欄是類別');
          var got = fromRows(rows, detectOpts());
          if (!got.series.length) return fail('找不到數字：值的欄位要是數字');
          got.series.forEach(function (ser) {
            var old = s.series.find(function (x) { return x.name === ser.name && x.colour; });
            if (old) ser.colour = old.colour;
          });
          if (!base.title && got.titleHint) base.title = got.titleHint;
          if (!base.xTitle && got.corner) base.xTitle = got.corner;
          if (!base.numFmt && got.numFmtHint) base.numFmt = got.numFmtHint;
          var next = norm(Object.assign({}, s, base, { categories: got.categories, series: got.series }));
          extras.table = got;
          o.onApply(next, extras);
        }
      } catch (e) {
        fail(e && e.message ? e.message : String(e));
      }
    });
    btnRow.appendChild(apply);
    if (o.onCancel) {
      var cancel = el('button', 'fbtn', '取消');
      cancel.type = 'button';
      cancel.addEventListener('mousedown', function (e) { e.preventDefault(); });
      cancel.addEventListener('click', function () { o.onCancel(); });
      btnRow.appendChild(cancel);
    }
    host.appendChild(btnRow);
    sync();

    return {
      el: host,
      focus: function () { (rangeField || dataField || titleField).focus(); }
    };
  }

  /* ---------------------------------------------------------- table view */

  /** The chart's data as a small <table>, for a 檢視資料 popover. */
  function tableNode(spec) {
    var rows = toRows(spec);
    var tbl = document.createElement('table');
    tbl.className = 'ui-chart-table';
    rows.forEach(function (r, ri) {
      var tr = document.createElement('tr');
      r.forEach(function (c) {
        var td = document.createElement(ri === 0 ? 'th' : 'td');
        td.textContent = c;
        tr.appendChild(td);
      });
      tbl.appendChild(tr);
    });
    return tbl;
  }

  return {
    TYPES: TYPES,
    COLOURS: COLOURS,
    COLOURS_DARK: COLOURS_DARK,
    COLOUR_NAMES: COLOUR_NAMES,
    OTHER_COLOUR: OTHER_COLOUR,
    MAX_SERIES: MAX_SERIES,
    SCATTER_SERIES: SCATTER_SERIES,
    MAX_POINTS: MAX_POINTS,
    LEGENDS: LEGENDS,
    APP_NAMES: APP_NAMES,
    INSERT_ACTION: INSERT_ACTION,
    typeOf: typeOf,
    resolveType: resolveType,
    requireType: requireType,
    typeName: typeName,
    hexOf: hexOf,
    requireColour: requireColour,
    luminanceOf: luminanceOf,
    inkOn: inkOn,
    colourOf: colourOf,
    sliceColour: sliceColour,
    pieSlices: pieSlices,
    withColours: withColours,
    overflow: overflow,
    toNumber: toNumber,
    isLabel: isLabel,
    fromRows: fromRows,
    toRows: toRows,
    tsv: tsv,
    fmtValue: fmtValue,
    excelFormatCode: excelFormatCode,
    tickLabel: tickLabel,
    plainNumber: plainNumber,
    norm: norm,
    describe: describe,
    niceScale: niceScale,
    quoteSheet: quoteSheet,
    parseRange: parseRange,
    rangeText: rangeText,
    rangeRefs: rangeRefs,
    embedPlan: embedPlan,
    refsToRange: refsToRange,
    indexToCol: indexToCol,
    colToIndex: colToIndex,
    estWidth: estWidth,
    fitText: fitText,
    wrapTwo: wrapTwo,
    render: render,
    svgString: svgString,
    parseTable: parseTable,
    copy: copy,
    pasteMatches: pasteMatches,
    clipSpec: clipSpec,
    clearClip: clearClip,
    sendTo: sendTo,
    sendMenuItems: sendMenuItems,
    typeGlyph: typeGlyph,
    panel: panel,
    tableNode: tableNode
  };
}));
