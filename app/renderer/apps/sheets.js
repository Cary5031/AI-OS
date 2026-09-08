'use strict';

/* ===========================================================================
   AI-OS // Sheets
   ---------------------------------------------------------------------------
   A spreadsheet with a real evaluator behind it (see formula.js): dependency
   ordered recalculation, cycle detection, and roughly fifty functions.

   The grid is drawn as one table with a single floating editor positioned over
   the selected cell, rather than a thousand <input> elements. That keeps a
   26x50 sheet at a few hundred nodes instead of tens of thousands, and it is
   how a spreadsheet actually behaves: one cell is being edited at a time.

   Native format is .aiossheet (JSON, lossless). .xlsx and .csv import and export
   go through the main process, and the honest limits of that are stated in the
   README rather than discovered later.
   =========================================================================== */

/* global window, document, AIOS */

(function () {
  var A = window.aios;
  var F = AIOS.formula;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* An unformatted value, which is one particular format code rather than a
     separate code path. The engine owns what a number looks like, so a cell, the
     status bar, a CSV export and the TEXT function cannot disagree. */
  function fmt(v) {
    if (typeof v === 'number' && !isFinite(v)) return '#NUM!';
    return F.format(v, 'General');
  }

  /* ------------------------------------------------------- number formats ---

     The list offered in the toolbar. `code` is the same Excel format language the
     engine reads and .xlsx stores, so choosing 「日期」 here and opening the file
     in Excel produce the same text. An empty code means General.
  */
  var NUM_FORMATS = [
    { code: '', name: '一般' },
    { code: '0', name: '整數　1235' },
    { code: '0.00', name: '小數　1234.50' },
    { code: '#,##0', name: '千分位　1,235' },
    { code: '#,##0.00', name: '千分位小數　1,234.50' },
    { code: 'NT$#,##0', name: '貨幣　NT$1,235' },
    { code: 'NT$#,##0.00', name: '貨幣小數　NT$1,234.50' },
    { code: '0%', name: '百分比　12%' },
    { code: '0.00%', name: '百分比小數　12.34%' },
    { code: 'yyyy-mm-dd', name: '日期　2026-08-15' },
    { code: 'yyyy/m/d', name: '日期　2026/8/15' },
    { code: 'hh:mm', name: '時間　13:07' },
    { code: 'yyyy-mm-dd hh:mm', name: '日期時間' },
    { code: '0.00E+00', name: '科學記號　1.23E+07' },
    { code: '@', name: '文字' }
  ];

  /* Fill and font colours come from the shared document palette, so a colour
     picked by name here is the same colour picked by name in the deck. */
  var CELL_COLOURS = AIOS.palette.fills;

  /* Border commands and the pen come from the shared border toolbox, so a line
     drawn here is the same line drawn in a document's table. `thickBottom` is
     kept as an alias because saved chat journals and older callers name it; the
     pen now decides the weight. */
  var BORDERS = AIOS.borders.APPLY;

  var ALIGNS = [
    { id: '', name: '對齊：自動' },
    { id: 'left', name: '靠左' },
    { id: 'center', name: '置中' },
    { id: 'right', name: '靠右' }
  ];

  /* Which format to reach for when a formula obviously produces a date. Excel
     does this too: =TODAY() in a General cell shows a date, not 46249.

     Decided from the parsed formula rather than by looking for the function name
     in the text, because the text is misleading. `=B1-DATE(2026,8,1)` mentions
     DATE and produces a count of days; formatting that as a date turned 14 into
     1900-01-14, which is the exact failure this feature exists to prevent. So the
     rule is about the shape of the expression: a bare date call is a date, and a
     date call plus or minus a plain number is still a date, and nothing else is.
  */
  var DAY_FNS = ['TODAY', 'DATE', 'DATEVALUE', 'EDATE', 'EOMONTH', 'WORKDAY'];

  function dateFormatOfNode(node) {
    if (!node) return null;
    if (node.n === 'call') {
      var name = String(node.name || '').toUpperCase();
      if (name === 'NOW') return 'yyyy-mm-dd hh:mm';
      if (name === 'TIME' || name === 'TIMEVALUE') return 'hh:mm';
      if (DAY_FNS.indexOf(name) >= 0) return 'yyyy-mm-dd';
      return null;
    }
    // A date shifted by a literal number of days is still a date.
    if (node.n === 'bin' && (node.op === '+' || node.op === '-')) {
      if (node.b && node.b.n === 'num') return dateFormatOfNode(node.a);
      if (node.op === '+' && node.a && node.a.n === 'num') return dateFormatOfNode(node.b);
    }
    return null;
  }

  function dateFormatFor(formulaText) {
    try {
      return dateFormatOfNode(F.parse(String(formulaText).replace(/^=/, '')));
    } catch (e) {
      return null;                 // unparseable: leave the format alone
    }
  }

  AIOS.apps.register({
    id: 'sheets',
    name: '試算表',
    icon: '\u25a6',
    kind: 'SHEET',
    width: 900,
    height: 560,
    purpose: '試算表，含公式運算',
    chatHint: '可以說「在 D 欄算出小計」或「把這張表加總」。公式會真的算，不是填字串。',

    accepts: function (p) { return /\.(aiossheet|xlsx|csv)$/i.test(p || ''); },

    actions: {
      setCell: {
        args: '{ref, value}', desc: '設定一格內容，value 開頭是 = 就是公式',
        run: async function (args, ctx) {
          ctx.api.setCell(String(args.ref || '').toUpperCase(), args.value);
          return { note: args.ref + ' = ' + args.value };
        }
      },
      setRange: {
        args: '{start, rows}',
        desc: '從某格開始批次填入，rows 是陣列的陣列；某一列寫成字串時當成逗號分隔的一列，空字串代表跳過那一格',
        run: async function (args, ctx) {
          var refs = ctx.api.setRange(String(args.start || 'A1').toUpperCase(), args.rows || []);
          // Report the cells by name. A range write that lands one column off is
          // otherwise invisible in the chat log.
          return {
            note: refs.length
              ? '填入 ' + refs.length + ' 格：' + refs.slice(0, 12).join('、') +
                (refs.length > 12 ? ' …' : '')
              : '沒有填入任何內容'
          };
        }
      },
      clearRange: {
        args: '{start, end}', desc: '清空一個範圍',
        run: async function (args, ctx) {
          var n = ctx.api.clearRange(args.start, args.end);
          return { note: '清空 ' + n + ' 格' };
        }
      },
      saveAs: {
        args: '{path}', desc: '另存新檔（不給 path 就問使用者；副檔名決定格式）',
        run: async function (a, ctx) { return { note: await ctx.api.saveAs(a.path || null) }; }
      },
      setFont: {
        args: '{font, size, bold, italic, start, end, scope:"sheet"|"range"}',
        desc: '設定字型。scope 省略或 sheet 就是整張表；range 要給 start（與可選的 end）',
        run: async function (a, ctx) { return { note: ctx.api.setFont(a) }; }
      },
      setStyle: {
        args: '{start, end, numFmt, align, wrap, bg, fg, border, bold, italic, under, strike}',
        desc: '設定儲存格格式。start/end 指定範圍（省略就用目前選取的範圍）。' +
              'numFmt 用 Excel 格式碼：#,##0.00、0%、NT$#,##0、yyyy-mm-dd、hh:mm、@（文字）。' +
              'align 是 left/center/right；bg 與 fg 是 RRGGBB；' +
              'border 是 all/box/bottom/top/thickBottom/none',
        run: async function (a, ctx) { return { note: ctx.api.setStyle(a) }; }
      },
      save: {
        args: '{}', desc: '儲存',
        run: async function (_a, ctx) { return { note: await ctx.api.save() }; }
      },
      insertRows: {
        args: '{at, count}', desc: '在第 at 列之前插入 count 列（at 從 1 開始）。所有公式的參照會跟著改寫',
        run: async function (a, ctx) { return { note: ctx.api.insertRows(a) }; }
      },
      deleteRows: {
        args: '{at, count}', desc: '從第 at 列開始刪除 count 列（at 從 1 開始）',
        run: async function (a, ctx) { return { note: ctx.api.deleteRows(a) }; }
      },
      insertCols: {
        args: '{at, count}', desc: '在第 at 欄之前插入 count 欄，at 可以是欄名（例如 "C"）或數字',
        run: async function (a, ctx) { return { note: ctx.api.insertCols(a) }; }
      },
      deleteCols: {
        args: '{at, count}', desc: '從第 at 欄開始刪除 count 欄，at 可以是欄名或數字',
        run: async function (a, ctx) { return { note: ctx.api.deleteCols(a) }; }
      },
      sortRange: {
        args: '{start, end, by, descending}',
        desc: '排序一個範圍，整列一起移動。by 是要依據的欄名（例如 "B"），省略就用範圍的第一欄',
        run: async function (a, ctx) { return { note: ctx.api.sortRange(a) }; }
      },
      freezePanes: {
        args: '{rows, cols}', desc: '凍結前 rows 列與前 cols 欄；都給 0 就取消凍結',
        run: async function (a, ctx) { return { note: ctx.api.freeze(a) }; }
      },
      mergeCells: {
        args: '{start, end, centre, across}',
        desc: '合併儲存格（跨欄置中）。start/end 給範圍，省略就用目前選取的範圍。' +
              'centre 預設 true（合併後置中）；across 為 true 時範圍內每一列各自合併。' +
              '只有左上角那一格的內容會留下',
        run: async function (a, ctx) { return { note: ctx.api.mergeCells(a) }; }
      },
      unmergeCells: {
        args: '{start, end}', desc: '取消範圍內的合併，省略範圍就用目前選取的範圍',
        run: async function (a, ctx) { return { note: ctx.api.unmergeCells(a) }; }
      },
      addSheet: {
        args: '{name}', desc: '新增一張工作表並切換過去',
        run: async function (a, ctx) { return { note: ctx.api.addSheet(a && a.name) }; }
      },
      selectSheet: {
        args: '{name}', desc: '切換到某一張工作表',
        run: async function (a, ctx) { return { note: ctx.api.selectSheet(a && a.name) }; }
      },
      renameSheet: {
        args: '{name, to}', desc: '把工作表改名；指向它的公式會一起更新。name 省略就是目前這張',
        run: async function (a, ctx) { return { note: ctx.api.renameSheet(a) }; }
      },
      deleteSheet: {
        args: '{name}', desc: '刪除一張工作表（至少要留一張）',
        run: async function (a, ctx) { return { note: ctx.api.deleteSheet(a && a.name) }; }
      },
      exportAs: {
        args: '{format:"csv"|"xlsx"|"pdf"}', desc: '匯出成 CSV、xlsx 或 PDF',
        run: async function (args, ctx) { return { note: await ctx.api.exportAs(args.format) }; }
      }
    },

    mount: function (ctx) {
      ctx.body.classList.add('flush');

      var COLS = 26;
      var ROWS = 60;
      // ref -> { v } | { f } plus any of font, size, bold, italic
      var cells = {};
      var computed = { values: {}, errors: {} };
      /* Selection is a rectangle, held as two corners: `sel` is the active cell
         -- the one the formula bar edits and the one typing lands in -- and
         `anchor` is the corner it was extended from. A single cell is the case
         where they are equal, rather than a separate mode. */
      var sel = 'A1';
      var anchor = 'A1';

      var path = null;
      /* The mtime of `path` as this window last saw it, handed back on save so
         the sandbox can refuse to replace a version this window never had.
         Null means no claim: a new workbook, or one whose version is unknown. */
      var pathMtime = null;
      var sheetName = '工作表1';
      var dirty = false;

      /* Undo holds whole-sheet snapshots rather than inverse operations. A sheet
         is a few hundred small objects, and an inverse for every edit -- insert a
         row, sort a range, paste with translated formulas -- is a second
         implementation of each one, which is where undo bugs live. */
      var undoStack = [];
      var redoStack = [];
      var UNDO_LIMIT = 60;

      /* What a copy carries that text cannot: formulas before evaluation, cell
         formatting, and where the block came from, so a paste can move relative
         references by the right delta. `text` is the same block as TSV, kept so
         we can tell whether the system clipboard still holds our copy or whether
         the user has since copied something from another program. */
      var clip = null;

      /* Sheet-wide default. A cell may override any of it. */
      var sheetFont = '微軟正黑體';
      var sheetSize = 11;

      /* Geometry, keyed by index. Absent means the default, so a sheet nobody has
         resized carries nothing -- and the maps have to be shifted whenever rows
         or columns are inserted, or every width lands on the wrong column. */
      var colWidths = {};
      var rowHeights = {};
      var DEFAULT_COL_W = 78;
      var DEFAULT_ROW_H = 22;

      /* Frozen panes: how many leading rows and columns stay put while the rest
         scrolls. Implemented with sticky positioning, which needs the offsets in
         pixels, which is why it has to know the sizes above. */
      var freeze = { rows: 0, cols: 0 };

      /* ==================================================== merged regions

         A list of rectangles, zero-based and inclusive: [{ c0, r0, c1, r1 }].

         Rectangles rather than per-cell "I am merged" marks, for two reasons. It
         is the unit a person manipulates -- merge this block, unmerge it -- so
         nothing has to be reconstructed from fragments. And it is what .xlsx
         stores (`<mergeCell ref="A1:C1"/>`), so the round trip is a direct
         translation instead of an inference.

         Every rectangle has a master: its top-left cell. That cell holds the
         value and the formatting, and it is the only one that renders -- as a
         <td> with colSpan/rowSpan. The others produce no node at all, which is
         how a real table expresses a span and is why the PDF export gets merges
         for free.

         The invariant that keeps the rest of the file honest: THE SELECTION NEVER
         HOLDS HALF A MERGE. selRect() grows to cover any rectangle it touches, and
         select() lands on the master rather than inside one. Everything downstream
         -- styling, sorting, copying, Delete -- reads selRect(), so each of them
         sees whole regions without knowing merges exist.
      */
      var merges = [];

      /* The algebra is AIOS.grid's, shared with the deck's table object and the
         document's table block: merging behaves the same in all three and only the
         drawing differs. These are the sheet's own vocabulary over it -- a
         reference is a string here, and a rectangle has a bound. */
      var G = AIOS.grid;

      function normMerges(list) {
        return G.norm(list, { cols: 200, rows: 2000 });
      }

      function overlaps(a, b) { return G.overlaps(a, b); }
      function masterRef(m) { return F.makeRef(m.c0, m.r0); }
      function rectLabel(m) { return G.label(m); }

      /** The region covering this position, master included, or null. */
      function mergeAt(c, r) { return G.at(merges, c, r); }

      function mergeOfRef(ref) {
        var p = F.parseRef(ref);
        return p ? mergeAt(p.col, p.row) : null;
      }

      /** Every region that meets a rectangle. */
      function mergesIn(rect) { return G.within(merges, rect); }

      /** Where a reference's content actually lives. */
      function visibleRef(ref) {
        var m = mergeOfRef(ref);
        return m ? masterRef(m) : ref;
      }

      /**
       * A sheet's cells as a formula sees them: a covered cell has no value.
       *
       * Merging discards the covered contents, so this normally changes nothing.
       * It matters for the ways a value can arrive afterwards -- a paste, a range
       * write from the chat panel -- where a number nobody can see would otherwise
       * join a SUM and make the total disagree with the screen.
       */
      function visibleCells(s) {
        var list = s.merges || [];
        if (!list.length) return s.cells;
        var hidden = {};
        list.forEach(function (m) {
          G.covered(m).forEach(function (rc) { hidden[F.makeRef(rc[1], rc[0])] = true; });
        });
        var out = {};
        Object.keys(s.cells).forEach(function (ref) {
          if (!hidden[ref]) out[ref] = s.cells[ref];
        });
        return out;
      }

      /* ======================================================== the workbook

         Several sheets, one of them active. The variables above hold the *active*
         sheet's live state and every existing code path keeps working on them
         unchanged; `book` holds the rest, and stash()/activate() move state
         between the two.

         The alternative -- reading book[active].cells everywhere -- would have
         touched a hundred call sites to express the same thing, and each one
         would have been a chance to read the wrong sheet.
      */
      var book = [];
      var active = 0;

      /** Copy the live variables back into the sheet they belong to. */
      function stash() {
        if (!book[active]) return;
        book[active].name = sheetName;
        book[active].cells = cells;
        book[active].cols = COLS;
        book[active].rows = ROWS;
        book[active].colWidths = colWidths;
        book[active].rowHeights = rowHeights;
        book[active].freeze = freeze;
        book[active].merges = merges;
      }

      /** Make sheet `i` the live one. */
      function activate(i) {
        if (i < 0 || i >= book.length || i === active) return;
        stash();
        active = i;
        var s = book[active];
        sheetName = s.name;
        cells = s.cells;
        COLS = s.cols;
        ROWS = s.rows;
        colWidths = s.colWidths;
        rowHeights = s.rowHeights;
        freeze = s.freeze;
        merges = s.merges || [];
        sel = 'A1';
        anchor = 'A1';
        recalc();
        ctx.setTitle('試算表 — ' + (path ? path.split('/').pop() : sheetName));
      }

      /** A blank sheet, with the defaults the first one gets. */
      function blankSheet(name) {
        return {
          name: name,
          cells: {},
          cols: 26,
          rows: 60,
          colWidths: {},
          rowHeights: {},
          freeze: { rows: 0, cols: 0 },
          merges: []
        };
      }

      /** A name no other sheet is using. */
      function freeSheetName(base) {
        var taken = {};
        book.forEach(function (s) { taken[s.name] = true; });
        if (base && !taken[base]) return base;
        var stem = base || '工作表';
        var n = base ? 2 : book.length + 1;
        while (taken[stem + n]) n++;
        return stem + n;
      }

      /* Every sheet's cells, which is what a recalculation spans: a formula here
         may read a sheet the user is not looking at. Filtered through
         visibleCells, so what a formula reads is what the grid shows. */
      function bookCells() {
        stash();
        var map = {};
        book.forEach(function (s) { map[s.name] = visibleCells(s); });
        return map;
      }

      /* Formatting keys live on the same object as the value, so anything that
         rewrites a cell has to carry them across. Forgetting that is how
         "type a new number into a styled cell" silently clears the styling. */
      var CELL_FMT = ['font', 'size', 'bold', 'italic', 'under', 'strike',
        'numFmt', 'align', 'wrap', 'bg', 'fg', 'border'];

      function fmtOf(ref) {
        var c = cells[ref];
        var out = {};
        if (!c) return out;
        CELL_FMT.forEach(function (k) { if (c[k]) out[k] = c[k]; });
        return out;
      }

      function hasFmt(ref) {
        return Object.keys(fmtOf(ref)).length > 0;
      }

      /* ------------------------------------------------------- selection --- */

      /**
       * The selected rectangle in column/row indices, corners ordered.
       *
       * Grown to contain every merged region it touches, which is what makes the
       * rest of the file merge-aware for free: styling, sorting, copying and
       * Delete all read this, so none of them can act on half of one. Excel does
       * the same, and for the same reason -- there is no sensible meaning for
       * "the left two thirds of a merged cell".
       */
      function selRect() {
        var a = F.parseRef(anchor) || F.parseRef(sel) || { col: 0, row: 0 };
        var b = F.parseRef(sel) || a;
        var q = {
          c0: Math.min(a.col, b.col), c1: Math.max(a.col, b.col),
          r0: Math.min(a.row, b.row), r1: Math.max(a.row, b.row)
        };
        return G.grow(merges, q);
      }

      function selRefs() {
        var q = selRect();
        var out = [];
        for (var r = q.r0; r <= q.r1; r++) {
          for (var c = q.c0; c <= q.c1; c++) out.push(F.makeRef(c, r));
        }
        return out;
      }

      function selCount() {
        var q = selRect();
        return (q.c1 - q.c0 + 1) * (q.r1 - q.r0 + 1);
      }

      function isMulti() { return selCount() > 1; }

      /** `A1` or `A1:C4`, the way a person would write what is selected. */
      function selLabel() {
        var q = selRect();
        return isMulti()
          ? F.makeRef(q.c0, q.r0) + ':' + F.makeRef(q.c1, q.r1)
          : sel;
      }

      /* ------------------------------------------------------------ undo --- */

      /* The whole workbook, not the active sheet. Inserting a row on one sheet
         rewrites formulas on every other, and adding or removing a sheet is an
         edit too -- an undo that only remembered the sheet in front of you would
         put half of the change back. */
      function snapshot() {
        stash();
        return {
          book: JSON.parse(JSON.stringify(book)),
          active: active,
          font: sheetFont, size: sheetSize
        };
      }

      function restoreState(s) {
        book = JSON.parse(JSON.stringify(s.book));
        active = Math.min(s.active, book.length - 1);
        sheetFont = s.font;
        sheetSize = s.size;
        var live = book[active];
        sheetName = live.name;
        cells = live.cells;
        COLS = live.cols;
        ROWS = live.rows;
        colWidths = live.colWidths;
        rowHeights = live.rowHeights;
        freeze = live.freeze;
        merges = live.merges || [];
      }

      /**
       * Run one edit as one undo step.
       *
       * Everything that changes the sheet goes through here, which is what makes
       * a paste of forty cells one press of Ctrl+Z instead of forty. If `fn`
       * throws, the snapshot is put back: a half-applied edit is worse than a
       * refused one, and the refusal is the only part the user sees.
       *
       * `opts.recalc === false` for changes that cannot alter a value -- styling.
       * Recomputing the sheet for a colour is harmless but it is also a lie about
       * what happened.
       */
      function mutate(label, fn, opts) {
        var before = snapshot();
        var out;
        try {
          out = fn();
        } catch (e) {
          restoreState(before);
          throw e;
        }
        undoStack.push({ label: label, state: before });
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
        redoStack.length = 0;
        dirty = true;
        if (opts && opts.recalc === false) { render(); ctx.save(); }
        else recalc();
        return out;
      }

      function undo() {
        if (!undoStack.length) { ctx.toast('沒有可以復原的動作', 't-warn'); return; }
        var step = undoStack.pop();
        redoStack.push({ label: step.label, state: snapshot() });
        restoreState(step.state);
        dirty = true;
        clampSelection();
        recalc();
        ctx.toast('已復原：' + step.label);
      }

      function redo() {
        if (!redoStack.length) { ctx.toast('沒有可以重做的動作', 't-warn'); return; }
        var step = redoStack.pop();
        undoStack.push({ label: step.label, state: snapshot() });
        restoreState(step.state);
        dirty = true;
        clampSelection();
        recalc();
        ctx.toast('已重做：' + step.label);
      }

      /** After a shape change the selection may point off the grid. */
      function clampSelection() {
        var p = F.parseRef(sel) || { col: 0, row: 0 };
        var a = F.parseRef(anchor) || p;
        sel = F.makeRef(Math.min(p.col, COLS - 1), Math.min(p.row, ROWS - 1));
        anchor = F.makeRef(Math.min(a.col, COLS - 1), Math.min(a.row, ROWS - 1));
      }

      /* ---------------------------------------------------------- chrome */

      var bar = el('div', 'sh-bar');
      var nameTag = el('span', 'sh-name', sheetName);
      var refTag = el('span', 'sh-ref', 'A1');
      var input = el('input', 'sh-formula');
      input.setAttribute('aria-label', '公式列');
      input.placeholder = '值或 =公式';
      var fontSel = el('select', 'sh-font');
      fontSel.setAttribute('aria-label', '字型');
      fontSel.title = '套用在選取的儲存格。留「預設」就跟著整張表';
      AIOS.fonts.fillSelect(fontSel, { inheritLabel: '字型：預設' });

      var sizeSel = el('select', 'sh-size');
      sizeSel.setAttribute('aria-label', '字級');
      sizeSel.title = '字級（pt）';
      AIOS.fonts.fillSizeSelect(sizeSel, { inheritLabel: 'pt' });

      var btnBold = el('button', 'fbtn', 'B');
      btnBold.type = 'button'; btnBold.title = '粗體';
      var btnItalic = el('button', 'fbtn', 'I');
      btnItalic.type = 'button'; btnItalic.title = '斜體';
      var btnUnder = el('button', 'fbtn', 'U');
      btnUnder.type = 'button'; btnUnder.title = '底線';
      var btnStrike = el('button', 'fbtn', 'S');
      btnStrike.type = 'button'; btnStrike.title = '刪除線';

      var numSel = el('select', 'sh-numfmt');
      numSel.setAttribute('aria-label', '數字格式');
      numSel.title = '數字格式。用的是 Excel 的格式碼，匯出的 .xlsx 會帶著它';
      NUM_FORMATS.forEach(function (f) {
        var o = el('option', null, f.name);
        o.value = f.code;
        numSel.appendChild(o);
      });
      var CUSTOM_FMT = '__custom__';
      var customOpt = el('option', null, '自訂格式碼…');
      customOpt.value = CUSTOM_FMT;
      numSel.appendChild(customOpt);

      var alignSel = el('select', 'sh-align');
      alignSel.setAttribute('aria-label', '對齊');
      ALIGNS.forEach(function (a) {
        var o = el('option', null, a.name);
        o.value = a.id;
        alignSel.appendChild(o);
      });

      var btnMerge = el('button', 'fbtn', '跨欄置中');
      btnMerge.type = 'button';
      btnMerge.title = '把選取的範圍合併成一格並置中。' +
        '已經是一個合併區時，按一下取消合併。右鍵選單裡有不置中與跨列合併';

      /* Borders get their own toolbar button, dropping the shared toolbox straight
         onto the sheet. They were reachable through 樣式 already, but a control
         behind a control is a control people do not find -- and this is the one
         Word puts on the ribbon. */
      var btnBorder = el('button', 'fbtn', '\u229e 框線');
      btnBorder.type = 'button';
      btnBorder.title = '框線與網底：線條樣式、線寬、畫筆色彩、要哪幾邊';
      btnBorder.addEventListener('mousedown', function (e) { e.preventDefault(); });

      var btnStyle = el('button', 'fbtn', '樣式');
      btnStyle.type = 'button';
      btnStyle.title = '底色、文字色、框線、自動換行';

      var btnSheetFont = el('button', 'fbtn', '整張表');
      btnSheetFont.type = 'button';
      btnSheetFont.title = '設定整張表的預設字型與字級';

      var btnUndo = el('button', 'fbtn', '\u21b6');
      btnUndo.type = 'button'; btnUndo.title = '復原 (Ctrl+Z)';
      var btnRedo = el('button', 'fbtn', '\u21b7');
      btnRedo.type = 'button'; btnRedo.title = '重做 (Ctrl+Y)';

      var btnSave = el('button', 'fbtn', '儲存');
      btnSave.type = 'button'; btnSave.title = '儲存 (Ctrl+S)';
      var btnSaveAs = el('button', 'fbtn', '另存');
      btnSaveAs.type = 'button';
      btnSaveAs.title = '另存新檔 (Ctrl+Shift+S)。副檔名決定格式：.aiossheet / .xlsx / .csv';
      /* One export button rather than three, the way the deck and the word
         processor already do it. Three of them cost the width of the two controls
         that had nowhere to go. */
      var btnExport = el('button', 'fbtn', '\u2913 匯出');
      btnExport.type = 'button';
      btnExport.title = 'CSV、xlsx、PDF';
      var btnRows = el('button', 'fbtn', '\u002b 列');
      btnRows.type = 'button';
      var btnCols = el('button', 'fbtn', '\u002b 欄');
      btnCols.type = 'button';

      /* Two rows, deliberately. Everything fitted on one until the border toolbox
         arrived, and a toolbar that reflows as the window narrows moves the button
         you were reaching for. Split by what the controls are about: the cell in
         front of you above, the sheet and the file below. */
      var bar2 = el('div', 'sh-bar sh-bar2');
      [nameTag, refTag, input, numSel, alignSel]
        .forEach(function (n) { bar.appendChild(n); });
      [fontSel, sizeSel, btnBold, btnItalic, btnUnder, btnStrike,
       btnMerge, btnBorder, btnStyle, btnSheetFont, btnRows, btnCols,
       btnUndo, btnRedo, btnSave, btnSaveAs, btnExport]
        .forEach(function (n) { bar2.appendChild(n); });
      ctx.body.appendChild(bar);
      ctx.body.appendChild(bar2);

      var wrap = el('div', 'sh-wrap');
      var table = el('table', 'sh-grid');
      wrap.appendChild(table);
      ctx.body.appendChild(wrap);

      /* The sheet tabs, under the grid and above the status line -- where every
         spreadsheet puts them, so nobody has to be told what they are. */
      var tabs = el('div', 'sh-tabs');
      ctx.body.appendChild(tabs);

      var status = el('div', 'sh-status');
      ctx.body.appendChild(status);

      function renderTabs() {
        tabs.innerHTML = '';
        book.forEach(function (s, i) {
          var b = el('button', 'sh-tab' + (i === active ? ' on' : ''), s.name);
          b.type = 'button';
          b.dataset.sheet = String(i);
          b.title = s.name + '（雙擊可以改名）';
          b.addEventListener('click', function () { activate(i); });
          b.addEventListener('dblclick', async function () {
            var name = await ctx.prompt({
              label: '工作表名稱',
              value: s.name,
              note: '改名之後，所有指向這張表的公式會跟著更新。',
              selectStem: false
            });
            if (name === null) return;
            try { renameSheet(i, name); recalc(); } catch (e) { ctx.toast(e.message, 't-err'); }
          });
          tabs.appendChild(b);
        });
        var add = el('button', 'sh-tab sh-tab-add', '\u002b');
        add.type = 'button';
        add.title = '新增工作表';
        add.addEventListener('click', function () {
          try { addSheet(); } catch (e) { ctx.toast(e.message, 't-err'); }
        });
        tabs.appendChild(add);
      }

      /* --------------------------------------------------------- editing */

      var editor = el('input', 'sh-editor');
      editor.hidden = true;
      editor.setAttribute('aria-label', '儲存格編輯');
      wrap.appendChild(editor);
      var editing = null;

      var fillHandle = el('div', 'sh-fill');
      fillHandle.hidden = true;
      fillHandle.title = '拖曳可以往下或往右填滿';
      wrap.appendChild(fillHandle);

      function raw(ref) {
        var c = cells[ref];
        if (!c) return '';
        if (c.f) return c.f;
        if (c.v === null || c.v === undefined) return '';
        /* A date is stored as a number and edited as a date. Putting 46249 in the
           formula bar would be technically accurate and impossible to work with;
           the formatted text typed straight back produces the same serial, so
           this round-trips. */
        if (typeof c.v === 'number' && c.numFmt && F.isDateCode(c.numFmt)) {
          return F.format(c.v, c.numFmt);
        }
        return String(c.v);
      }

      /**
       * Write one cell and nothing else: no recalculation, no undo step, no
       * render. Everything that writes more than one cell goes through this and
       * lets `mutate` finish the job once, instead of recomputing the whole sheet
       * per cell and leaving forty entries in the undo stack for one paste.
       */
      function writeCell(ref, value) {
        if (!F.parseRef(ref)) throw new Error('不是合法的儲存格：' + ref);
        var s = value === null || value === undefined ? '' : String(value);
        var fmt = fmtOf(ref);

        /* Typing decides the type, and sometimes the format with it.
           A cell whose format was chosen deliberately is never overridden -- the
           `!fmt.numFmt` guard -- but a date typed into a General cell has to come
           back out as a date. Storing 2026-08-15 as the number 46249 and then
           showing 46249 is technically a date and practically useless. */
        var typed = null;

        if (s === '') {
          // An emptied cell that still carries formatting has to survive as a
          // formatting-only cell, or clearing a value would also clear the font.
          if (Object.keys(fmt).length) cells[ref] = Object.assign({ v: '' }, fmt);
          else delete cells[ref];
          return ref;
        }

        if (s.charAt(0) === '=') {
          typed = Object.assign({ f: s }, fmt);
          if (!fmt.numFmt) {
            var auto = dateFormatFor(s);
            if (auto) typed.numFmt = auto;
          }
        } else if (/^-?[\d,]*\.?\d+\s*%$/.test(s)) {
          // A typed percentage is a number and a format, the way it is in Excel.
          typed = Object.assign({ v: Number(s.replace(/[,%\s]/g, '')) / 100 }, fmt);
          if (!fmt.numFmt) typed.numFmt = /\./.test(s) ? '0.00%' : '0%';
        } else if (!isNaN(Number(s.replace(/,/g, '')))) {
          typed = Object.assign({ v: Number(s.replace(/,/g, '')) }, fmt);
        } else if (/^(true|false)$/i.test(s)) {
          typed = Object.assign({ v: /^true$/i.test(s) }, fmt);
        } else {
          var asDate = fmt.numFmt === '@' ? null : F.parseDateText(s);
          var asTime = fmt.numFmt === '@' ? null : F.parseTimeText(s);
          if (asDate !== null) {
            /* A date with a clock after it keeps the clock. parseDateText reads
               only the date, matching DATEVALUE; putting them back together is
               this layer's job, because "2026-08-15 13:07" is one thing a person
               typed and losing half of it silently is not acceptable. */
            var withTime = asTime !== null && /\d:\d{2}/.test(s);
            typed = Object.assign({ v: asDate + (withTime ? asTime : 0) }, fmt);
            if (!fmt.numFmt) typed.numFmt = withTime ? 'yyyy-mm-dd hh:mm' : 'yyyy-mm-dd';
          } else if (asTime !== null && /^\d{1,2}:\d{2}/.test(s)) {
            typed = Object.assign({ v: asTime }, fmt);
            if (!fmt.numFmt) typed.numFmt = /:\d{2}:\d{2}/.test(s) ? 'hh:mm:ss' : 'hh:mm';
          } else {
            typed = Object.assign({ v: s }, fmt);
          }
        }
        cells[ref] = typed;

        // Grow the sheet if the model writes past the current edge.
        var pos = F.parseRef(ref);
        if (pos.col >= COLS) COLS = Math.min(200, pos.col + 1);
        if (pos.row >= ROWS) ROWS = Math.min(2000, pos.row + 1);

        return ref;
      }

      /** One cell, as one undo step. The public single-cell entry point. */
      function setCell(ref, value) {
        var at = String(ref).toUpperCase();
        return mutate('編輯 ' + at, function () { return writeCell(at, value); });
      }

      /**
       * Set formatting on one cell or a range, leaving values alone. A null in
       * the patch clears that key, which is how a cell falls back to the
       * sheet default.
       */
      function applyFormat(list, patch) {
        list.forEach(function (ref) {
          var r = String(ref || '').toUpperCase();
          if (!F.parseRef(r)) return;
          var c = cells[r] || { v: '' };
          Object.keys(patch).forEach(function (k) {
            if (patch[k] === null || patch[k] === '' || patch[k] === false) delete c[k];
            else c[k] = patch[k];
          });
          // Nothing left worth storing.
          var empty = (c.v === '' || c.v === undefined) && !c.f && !hasFmtOn(c);
          if (empty) delete cells[r];
          else cells[r] = c;
        });
      }

      function setFormat(refs, patch) {
        var list = Array.isArray(refs) ? refs : [refs];
        // Styling cannot change a value, so the sheet is not recomputed for it.
        return mutate('格式 ' + (list.length > 1 ? list.length + ' 格' : list[0]),
          function () { applyFormat(list, patch); },
          { recalc: false });
      }

      function hasFmtOn(c) {
        return CELL_FMT.some(function (k) { return !!c[k]; });
      }

      /**
       * Programmatic font change for the chat panel. Takes an explicit range
       * rather than acting on the selection, because the model cannot see where
       * the cursor is.
       */
      function setFont(spec) {
        var s = spec || {};
        var patch = {};
        if (s.font) patch.font = String(s.font).slice(0, 64);
        if (s.size !== undefined && s.size !== null) {
          var n = Number(s.size);
          if (Number.isFinite(n) && n > 0) patch.size = Math.max(4, Math.min(200, n));
        }
        if (s.bold !== undefined) patch.bold = !!s.bold;
        if (s.italic !== undefined) patch.italic = !!s.italic;
        if (!Object.keys(patch).length) throw new Error('要給 font、size、bold 或 italic');

        if (s.scope === 'range' || s.start) {
          var start = String(s.start || '').toUpperCase();
          if (!F.parseRef(start)) throw new Error('start 不是合法的儲存格：' + s.start);
          var refs = s.end ? F.expandRange(start, String(s.end).toUpperCase()) : [start];
          if (!refs) throw new Error('範圍太大');
          setFormat(refs, patch);
          return refs.length + ' 格套用了 ' +
            (patch.font || '') + (patch.size ? ' ' + patch.size + 'pt' : '');
        }

        return mutate('整張表字型', function () {
          if (patch.font) sheetFont = patch.font;
          if (patch.size) sheetSize = patch.size;
          return '整張表改成 ' + sheetFont + ' ' + sheetSize + 'pt';
        }, { recalc: false });
      }

      /** A sheet by name, or -1. */
      function sheetIndexOf(name) {
        var want = String(name === undefined || name === null ? '' : name).trim();
        for (var i = 0; i < book.length; i++) if (book[i].name === want) return i;
        return -1;
      }

      /** A column as either a letter or a 1-based number -> a zero-based index. */
      function colIndexOf(value) {
        if (value === undefined || value === null || value === '') return 0;
        var s = String(value).trim().toUpperCase();
        if (/^[A-Z]+$/.test(s)) return F.colToIndex(s);
        var n = Number(s);
        return Number.isFinite(n) && n >= 1 ? Math.round(n) - 1 : 0;
      }

      /** `#1F4E79`, `1f4e79` or a name from the palette -> the stored form. */
      function hexOf(value) { return AIOS.palette.hexOf(value); }

      /**
       * Everything about how a range looks, for the chat panel.
       *
       * Borders are handled apart from the rest because a border choice is about
       * the range and not about a cell: 「外框」 means different edges for the
       * corner cells than for the ones in the middle.
       */
      function setStyle(spec) {
        var s = spec || {};
        var refs;
        var rect;
        var where;

        if (s.start) {
          var start = String(s.start).toUpperCase();
          if (!F.parseRef(start)) throw new Error('start 不是合法的儲存格：' + s.start);
          var end = s.end ? String(s.end).toUpperCase() : start;
          if (!F.parseRef(end)) throw new Error('end 不是合法的儲存格：' + s.end);
          refs = F.expandRange(start, end);
          if (!refs) throw new Error('範圍太大');
          var A1 = F.parseRef(start);
          var B1 = F.parseRef(end);
          rect = {
            c0: Math.min(A1.col, B1.col), c1: Math.max(A1.col, B1.col),
            r0: Math.min(A1.row, B1.row), r1: Math.max(A1.row, B1.row)
          };
          where = refs.length > 1 ? start + ':' + end : start;
        } else {
          refs = selRefs();
          rect = selRect();
          where = selLabel() + '（目前選取的範圍）';
        }

        var patch = {};
        var said = [];
        if (s.numFmt !== undefined) {
          patch.numFmt = s.numFmt ? String(s.numFmt).slice(0, 60) : null;
          said.push(patch.numFmt ? '格式 ' + patch.numFmt : '清除數字格式');
        }
        if (s.align !== undefined) {
          patch.align = ['left', 'center', 'right'].indexOf(s.align) >= 0 ? s.align : null;
          said.push(patch.align ? '對齊 ' + patch.align : '自動對齊');
        }
        if (s.wrap !== undefined) { patch.wrap = s.wrap ? true : null; said.push(s.wrap ? '自動換行' : '不換行'); }
        /* A colour name nobody has is refused rather than read as "no colour":
           asking for a fill and getting it cleared is the same silent wrong answer
           the border commands already refuse for their own vocabulary. */
        if (s.bg !== undefined) {
          patch.bg = AIOS.palette.require(s.bg, '底色');
          said.push(patch.bg ? '底色 #' + patch.bg : '清除底色');
        }
        if (s.fg !== undefined) {
          patch.fg = AIOS.palette.require(s.fg, '文字色');
          said.push(patch.fg ? '文字色 #' + patch.fg : '清除文字色');
        }
        ['bold', 'italic', 'under', 'strike'].forEach(function (k) {
          if (s[k] !== undefined) { patch[k] = s[k] ? true : null; said.push((s[k] ? '' : '取消') + k); }
        });
        if (s.font !== undefined) { patch.font = s.font ? String(s.font).slice(0, 64) : null; said.push('字型 ' + s.font); }
        if (s.size !== undefined) {
          var n = Number(s.size);
          patch.size = Number.isFinite(n) && n > 0 ? Math.max(4, Math.min(200, n)) : null;
          said.push('字級 ' + patch.size);
        }

        /* A border is named by what it means, not by which edges it happens to
           produce. An unrecognised name is refused rather than falling through to
           "no border" -- clearing the border because the caller used the wrong
           word is a silent wrong answer. */
        var borderKind = null;
        if (s.border !== undefined) {
          var asked = s.border === null ? '' : String(s.border);
          // 'thickBottom' is what the previous vocabulary called a heavy bottom
          // rule. Translated rather than dropped: journals and habits both have it.
          if (asked === 'thickBottom') { asked = 'bottom'; s.borderWidth = s.borderWidth || 2.25; }
          if (asked === '' || asked === 'none') borderKind = 'none';
          else if (BORDERS.some(function (b) { return b.id === asked; })) borderKind = asked;
          else {
            throw new Error('不認得的框線種類「' + asked + '」；可用：' +
              BORDERS.map(function (b) { return b.id; }).join('、'));
          }
        }

        /* The pen the border is drawn with. Given here it is a one-off; omitted,
           the shared pen from the border panel is used, which is how a border
           drawn from a conversation matches one drawn by hand. */
        var pen = null;
        if (borderKind && borderKind !== 'none') {
          if (s.borderStyle &&
              !AIOS.borders.STYLES.some(function (x) { return x.id === s.borderStyle; })) {
            throw new Error('不認得的線條樣式「' + s.borderStyle + '」；可用：' +
              AIOS.borders.STYLES.map(function (x) { return x.id; }).join('、'));
          }
          pen = AIOS.borders.edge({
            style: s.borderStyle || AIOS.borders.pen.style,
            width: s.borderWidth || AIOS.borders.pen.width,
            colour: AIOS.palette.require(s.borderColour, '畫筆色彩') || AIOS.borders.pen.colour
          });
        }

        if (!Object.keys(patch).length && borderKind === null) {
          throw new Error('沒有指定任何格式；可用：numFmt、align、wrap、bg、fg、border、' +
            'borderStyle、borderWidth、borderColour、bold、italic、under、strike、font、size');
        }
        if (borderKind !== null) {
          said.push('框線 ' + borderKind +
            (pen ? '（' + AIOS.borders.styleOf(pen.style).name + ' ' +
                   AIOS.borders.widthLabel(pen.width) + ' #' + pen.colour + '）' : ''));
        }

        mutate('格式 ' + where, function () {
          if (Object.keys(patch).length) applyFormat(refs, patch);
          if (borderKind !== null) applyBorder(rect, borderKind, pen);
        }, { recalc: false });

        return where + ' 套用了：' + said.join('、');
      }

      /**
       * A row given as a string is read as one comma-separated line, not as a
       * single cell. Models mix the two shapes freely -- asked for a formula in
       * B3 one answered with rows [[...], [...], ",=B2*3"], meaning "column A
       * empty, column B this formula". Taking that literally wrote the text
       * ",=B2*3" into A3 and reported success, which is the worst outcome
       * available: wrong data, right-looking receipt.
       *
       * Quoted fields are honoured so a value that genuinely contains a comma
       * can still be written as "台北, 台灣".
       */
      function splitRow(row) {
        if (Array.isArray(row)) return row;
        if (row === null || row === undefined) return [''];
        var s = String(row);
        if (s.indexOf(',') < 0) return [s];
        var out = [];
        var cur = '';
        var quoted = false;
        for (var i = 0; i < s.length; i++) {
          var ch = s[i];
          if (quoted) {
            if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; }
            else if (ch === '"') quoted = false;
            else cur += ch;
          } else if (ch === '"') {
            quoted = true;
          } else if (ch === ',') {
            out.push(cur.trim());
            cur = '';
          } else {
            cur += ch;
          }
        }
        out.push(cur.trim());
        return out;
      }

      function setRange(start, rows) {
        var pos = F.parseRef(String(start).toUpperCase());
        if (!pos) throw new Error('起點不合法：' + start);
        if (!Array.isArray(rows)) rows = [rows];
        return mutate('填入範圍', function () {
          var written = [];
          rows.forEach(function (row, ri) {
            splitRow(row).forEach(function (val, ci) {
              var ref = F.makeRef(pos.col + ci, pos.row + ri);
              writeCell(ref, val);
              // Blanks are written (they clear a cell) but not claimed as filled,
              // so the receipt matches what a person would count.
              if (val !== '' && val !== null && val !== undefined) written.push(ref);
            });
          });
          return written;
        });
      }

      function clearRange(start, end) {
        var refs = end
          ? F.expandRange(String(start).toUpperCase(), String(end).toUpperCase())
          : [String(start).toUpperCase()];
        if (!refs) throw new Error('範圍太大');
        return mutate('清空 ' + refs.length + ' 格', function () {
          var n = 0;
          refs.forEach(function (r) { if (cells[r]) { delete cells[r]; n++; } });
          return n;
        });
      }

      /* ------------------------------------------------------- structure ---

         Inserting and removing rows and columns. Two things move: the cells
         themselves, and every reference in every formula on the sheet -- including
         formulas nowhere near the change. Doing only the first is the bug that
         makes a spreadsheet quietly wrong: the numbers slide and the sums keep
         pointing at the addresses they used to be at.
      */

      /**
       * Move and resize the merged regions along with the structure.
       *
       * The same shape of question F.reshape answers for a range inside a formula,
       * and the same answers: a region entirely after the cut shifts, one the cut
       * lands inside grows or shrinks, and one whose every row is deleted goes with
       * them. A region reduced to a single cell stops being a merge -- keeping it
       * would leave the grid maintaining a colSpan of 1 forever.
       *
       * Only this sheet's regions. Inserting a row here rewrites formulas on every
       * sheet, because they may point at these rows; it does not move a merge on
       * another sheet, because a merge is a fact about its own grid.
       */
      function reshapeMerges(list, op) { return G.reshape(list, op); }

      /** Shift the keys of a size map (column widths, row heights) the same way. */
      function shiftSizes(map, op) {
        var out = {};
        Object.keys(map).forEach(function (k) {
          var i = Number(k);
          if (op.kind.indexOf('insert') === 0) {
            out[i >= op.at ? i + op.count : i] = map[k];
          } else if (i >= op.at + op.count) {
            out[i - op.count] = map[k];
          } else if (i < op.at) {
            out[i] = map[k];
          }
          // sizes of removed rows or columns go with them
        });
        return out;
      }

      function restructure(op, label) {
        var rowAxis = op.kind === 'insertRow' || op.kind === 'deleteRow';
        var dropped = 0;
        op.sheet = sheetName;

        mutate(label, function () {
          var moved = {};
          Object.keys(cells).forEach(function (ref) {
            var p = F.parseRef(ref);
            if (!p) return;
            var idx = rowAxis ? p.row : p.col;
            var to = idx;

            if (op.kind === 'insertRow' || op.kind === 'insertCol') {
              if (idx >= op.at) to = idx + op.count;
            } else if (idx >= op.at + op.count) {
              to = idx - op.count;
            } else if (idx >= op.at) {
              return;                        // this row or column is being removed
            }

            var limit = rowAxis ? 2000 : 200;
            if (to >= limit) { dropped++; return; }
            moved[rowAxis ? F.makeRef(p.col, to) : F.makeRef(to, p.row)] = cells[ref];
          });

          // Every formula on the sheet, not only the ones that moved.
          Object.keys(moved).forEach(function (ref) {
            if (moved[ref].f) moved[ref].f = F.reshape(moved[ref].f, op, sheetName);
          });
          cells = moved;

          /* And every formula on every *other* sheet, because one of them may be
             pointing at the rows that just moved. reshape() knows to leave alone
             the references that name a different sheet. */
          book.forEach(function (s, i) {
            if (i === active) return;
            Object.keys(s.cells).forEach(function (ref) {
              if (s.cells[ref].f) s.cells[ref].f = F.reshape(s.cells[ref].f, op, s.name);
            });
          });

          merges = reshapeMerges(merges, op);

          if (rowAxis) {
            rowHeights = shiftSizes(rowHeights, op);
            if (op.kind === 'insertRow') ROWS = Math.min(2000, ROWS + op.count);
            else ROWS = Math.max(10, ROWS - op.count);
          } else {
            colWidths = shiftSizes(colWidths, op);
            if (op.kind === 'insertCol') COLS = Math.min(200, COLS + op.count);
            else COLS = Math.max(4, COLS - op.count);
          }
        });

        clampSelection();
        if (dropped) {
          ctx.toast(dropped + ' 格被推出表格邊界而遺失（上限 2000 列 x 200 欄）', 't-warn');
        }
      }

      /* ---------------------------------------------------- sheet handling */

      function addSheet(name) {
        var wanted = String(name || '').trim() || freeSheetName();
        if (book.some(function (s) { return s.name === wanted; })) {
          throw new Error('已經有一張工作表叫「' + wanted + '」');
        }
        mutate('新增工作表 ' + wanted, function () {
          book.push(blankSheet(wanted));
        }, { recalc: false });
        activate(book.length - 1);
        return '已新增工作表「' + wanted + '」';
      }

      function removeSheet(i) {
        if (book.length <= 1) throw new Error('至少要留一張工作表');
        var index = i === undefined ? active : i;
        var gone = book[index].name;
        mutate('刪除工作表 ' + gone, function () {
          book.splice(index, 1);
          if (active >= book.length) active = book.length - 1;
          else if (index < active) active -= 1;
          var live = book[active];
          sheetName = live.name;
          cells = live.cells;
          COLS = live.cols;
          ROWS = live.rows;
          colWidths = live.colWidths;
          rowHeights = live.rowHeights;
          freeze = live.freeze;
          merges = live.merges || [];
          sel = 'A1';
          anchor = 'A1';
        });
        /* Formulas elsewhere that named the deleted sheet are left as they were
           written. They now read as blank, which is what Excel shows too -- and
           rewriting them to #REF! would destroy the name, so pasting the sheet
           back could not repair them. */
        return '已刪除工作表「' + gone + '」';
      }

      function renameSheet(i, name) {
        var index = i === undefined ? active : i;
        var from = book[index].name;
        var to = String(name || '').trim();
        if (!to) throw new Error('工作表名稱不能是空的');
        if (/[!'\[\]:*?\/\\]/.test(to)) throw new Error('工作表名稱不能包含 ! \' [ ] : * ? / \\');
        if (to === from) return '名稱沒有改變';
        if (book.some(function (s) { return s.name === to; })) {
          throw new Error('已經有一張工作表叫「' + to + '」');
        }

        mutate('工作表改名 ' + from + ' → ' + to, function () {
          book[index].name = to;
          if (index === active) sheetName = to;
          /* Every formula that named the old sheet has to follow it, or renaming a
             sheet would silently break every cross-sheet reference to it. Quoted
             and bare spellings both, because either is legal input. */
          var bare = new RegExp('(^|[^A-Za-z0-9_\\u4e00-\\u9fff!])' +
            from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '!', 'g');
          var quoted = new RegExp("'" + from.replace(/'/g, "''").replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'!", 'g');
          var written = /[\s!'\[\]]/.test(to) ? "'" + to.replace(/'/g, "''") + "'!" : to + '!';
          book.forEach(function (s) {
            Object.keys(s.cells).forEach(function (ref) {
              var c = s.cells[ref];
              if (!c.f) return;
              c.f = c.f.replace(quoted, written).replace(bare, function (m, pre) {
                return pre + written;
              });
            });
          });
        });
        return '工作表「' + from + '」改名為「' + to + '」';
      }

      function duplicateSheet(i) {
        var index = i === undefined ? active : i;
        stash();
        var src = book[index];
        var name = freeSheetName(src.name + ' 副本');
        mutate('複製工作表 ' + src.name, function () {
          var copy = JSON.parse(JSON.stringify(src));
          copy.name = name;
          book.splice(index + 1, 0, copy);
        }, { recalc: false });
        activate(index + 1);
        return '已複製為「' + name + '」';
      }

      /**
       * Freeze the first `rows` rows and `cols` columns in place.
       *
       * Named after the cell whose top-left corner the split sits at, which is how
       * every spreadsheet asks the question: freezing "at B3" keeps rows 1-2 and
       * column A visible.
       */
      /* ------------------------------------------------------- merging ---

         「跨欄置中」 and its relatives. Excel's rules, because they are the ones
         people arrive expecting:

           only the top-left cell's content survives -- there is one cell now, so
           there can be one value, and pretending otherwise would mean inventing a
           rule about which of nine values wins;

           an overlapping region is replaced rather than refused, so dragging over
           a merge and merging again does the obvious thing;

           merging is a property of the sheet, not formatting of a cell, so
           「清除所有格式」 does not silently unmerge everything.
      */

      /**
       * Merge a rectangle.
       *
       * `centre` also centres the surviving cell, which is the difference between
       * 「跨欄置中」 and 「合併儲存格」. `across` merges each row of the rectangle
       * separately -- three rows of four columns become three wide cells rather
       * than one block.
       */
      function mergeRect(rect, opts) {
        var o = opts || {};
        if (rect.c0 === rect.c1 && rect.r0 === rect.r1) {
          throw new Error('只有一格，沒有東西可以合併');
        }
        var bands = [];
        if (o.across) {
          for (var r = rect.r0; r <= rect.r1; r++) {
            if (rect.c0 !== rect.c1) bands.push({ c0: rect.c0, c1: rect.c1, r0: r, r1: r });
          }
          if (!bands.length) throw new Error('跨列合併需要選到兩欄以上');
        } else {
          bands.push({ c0: rect.c0, c1: rect.c1, r0: rect.r0, r1: rect.r1 });
        }

        var lost = 0;
        var label = rectLabel(rect);

        mutate((o.across ? '跨列合併 ' : o.centre ? '跨欄置中 ' : '合併 ') + label, function () {
          bands.forEach(function (band) {
            var home = masterRef(band);
            G.covered(band).forEach(function (rc) {
              var ref = F.makeRef(rc[1], rc[0]);
              if (ref === home) return;
              var c = cells[ref];
              if (c && (c.f || (c.v !== '' && c.v !== undefined && c.v !== null))) lost++;
              delete cells[ref];
            });
            // Anything this band overlaps gives way to it.
            merges = G.merge(merges, band);
            if (o.centre) applyFormat([home], { align: 'center' });
            // The sheet has to be big enough to hold what was just described.
            if (band.c1 >= COLS) COLS = Math.min(200, band.c1 + 1);
            if (band.r1 >= ROWS) ROWS = Math.min(2000, band.r1 + 1);
          });
        });

        /* Said out loud rather than swallowed. Losing the contents of eight cells
           is the one part of merging that surprises people, and a silent merge
           that ate their numbers is not something undo can suggest by itself. */
        if (lost) {
          ctx.toast('合併保留左上角的內容，另外 ' + lost + ' 格的內容已捨棄（Ctrl+Z 可以復原）', 't-warn');
        }
        return (o.across ? bands.length + ' 列各自合併' : '已合併 ' + label) +
               (o.centre ? ' 並置中' : '') + (lost ? '，捨棄 ' + lost + ' 格內容' : '');
      }

      /** Undo the merging of anything inside a rectangle. */
      function unmergeRect(rect) {
        var hit = mergesIn(rect);
        if (!hit.length) throw new Error('選取範圍裡沒有合併的儲存格');
        mutate('取消合併 ' + rectLabel(rect), function () {
          merges = G.clear(merges, rect);
        }, { recalc: false });
        return '已取消 ' + hit.length + ' 個合併區域';
      }

      /**
       * What the toolbar button does: merge, or unmerge if the selection is
       * already exactly one merged region. One button, because that is the state
       * the button is showing and toggling it is what a person expects of it.
       */
      function toggleMergeCentre() {
        var q = selRect();
        var hit = mergesIn(q);
        var exactly = hit.length === 1 && hit[0].c0 === q.c0 && hit[0].c1 === q.c1 &&
                      hit[0].r0 === q.r0 && hit[0].r1 === q.r1;
        return exactly ? unmergeRect(q) : mergeRect(q, { centre: true });
      }

      /** How a merge instruction from the chat panel names its rectangle. */
      function rectFromSpec(spec, what) {
        var s = spec || {};
        if (!s.start) {
          var q = selRect();
          return { c0: q.c0, c1: q.c1, r0: q.r0, r1: q.r1 };
        }
        var start = String(s.start).toUpperCase();
        var end = String(s.end || s.start).toUpperCase();
        var a = F.parseRef(start);
        var b = F.parseRef(end);
        if (!a) throw new Error('start 不是合法的儲存格：' + s.start);
        if (!b) throw new Error('end 不是合法的儲存格：' + s.end);
        var rect = {
          c0: Math.min(a.col, b.col), c1: Math.max(a.col, b.col),
          r0: Math.min(a.row, b.row), r1: Math.max(a.row, b.row)
        };
        if ((rect.c1 - rect.c0 + 1) * (rect.r1 - rect.r0 + 1) > 20000) {
          throw new Error((what || '範圍') + '太大');
        }
        return rect;
      }

      function setFreeze(rows, cols) {
        return mutate('凍結 ' + rows + ' 列 ' + cols + ' 欄', function () {
          freeze = {
            rows: Math.max(0, Math.min(ROWS - 1, Math.round(rows) || 0)),
            cols: Math.max(0, Math.min(COLS - 1, Math.round(cols) || 0))
          };
          return '凍結 ' + freeze.rows + ' 列、' + freeze.cols + ' 欄';
        }, { recalc: false });
      }

      /** Rows or columns spanned by the selection, which is what the menu acts on. */
      function selSpanRows() {
        var q = selRect();
        return { at: q.r0, count: q.r1 - q.r0 + 1 };
      }
      function selSpanCols() {
        var q = selRect();
        return { at: q.c0, count: q.c1 - q.c0 + 1 };
      }

      /* --------------------------------------------------------- sorting ---

         Sorting moves whole rows, and a formula that moves has to be rewritten
         for its new home: `=B2*2` landing in row 5 means `=B5*2`. That is a
         constant shift per row, so translate() is the right tool -- unlike
         insert and delete, which split the sheet.
      */

      function sortRange(byCol, descending) {
        var q = selRect();
        if (q.r1 === q.r0) throw new Error('只有一列，沒有東西可以排序');
        /* Refused rather than attempted. Sorting moves whole rows; a merged block
           spanning three of them belongs to none of the rows individually, so any
           answer here is a guess. Excel refuses too. */
        var blocked = mergesIn(q);
        if (blocked.length) {
          throw new Error('選取範圍裡有合併的儲存格（' + rectLabel(blocked[0]) +
            '），排序會把整列搬動而合併區屬於好幾列，請先取消合併');
        }
        var keyCol = byCol === undefined || byCol === null ? F.parseRef(sel).col : byCol;
        if (keyCol < q.c0 || keyCol > q.c1) keyCol = q.c0;

        mutate('排序 ' + selLabel(), function () {
          // Lift the rows out, keeping every cell of each row together.
          var block = [];
          for (var r = q.r0; r <= q.r1; r++) {
            var row = { key: computed.values[F.makeRef(keyCol, r)], from: r, cells: {} };
            for (var c = q.c0; c <= q.c1; c++) {
              var ref = F.makeRef(c, r);
              if (cells[ref]) row.cells[c] = JSON.parse(JSON.stringify(cells[ref]));
            }
            block.push(row);
          }

          block.sort(function (a, b) {
            var av = a.key;
            var bv = b.key;
            // Blanks sink to the bottom whichever way the sort runs, because a
            // blank is absence rather than a value smaller than everything.
            var aEmpty = av === '' || av === null || av === undefined;
            var bEmpty = bv === '' || bv === null || bv === undefined;
            if (aEmpty && bEmpty) return a.from - b.from;
            if (aEmpty) return 1;
            if (bEmpty) return -1;
            var cmp;
            if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
            else cmp = String(av).localeCompare(String(bv), 'zh-Hant');
            if (cmp === 0) return a.from - b.from;      // a stable sort
            return descending ? -cmp : cmp;
          });

          block.forEach(function (row, i) {
            var to = q.r0 + i;
            var dr = to - row.from;
            for (var c = q.c0; c <= q.c1; c++) {
              var ref = F.makeRef(c, to);
              var src = row.cells[c];
              if (!src) { delete cells[ref]; continue; }
              if (src.f && dr) src.f = F.translate(src.f, 0, dr);
              cells[ref] = src;
            }
          });
        });
      }

      /* ------------------------------------------------------------- fill ---

         The handle on the corner of the selection. One cell copies (a formula
         translated, a value repeated); two or more numbers extrapolate the step
         between them, which is what makes dragging 1, 2 give 3, 4, 5.
      */

      function fillTo(targetRef) {
        var q = selRect();
        var t = F.parseRef(targetRef);
        if (!t) return;

        // One axis only: whichever direction was dragged further.
        var downBy = t.row - q.r1;
        var rightBy = t.col - q.c1;
        var vertical = Math.abs(downBy) >= Math.abs(rightBy);
        if (vertical && downBy <= 0) return;
        if (!vertical && rightBy <= 0) return;

        var srcLen = vertical ? q.r1 - q.r0 + 1 : q.c1 - q.c0 + 1;
        var extra = vertical ? downBy : rightBy;

        /* Neither end may hold a merge. The source has no per-cell values to read
           a series from, and the target would be overwritten cell by cell
           underneath a block that still claims to cover it. */
        var reach = vertical
          ? { c0: q.c0, c1: q.c1, r0: q.r0, r1: q.r1 + extra }
          : { c0: q.c0, c1: q.c1 + extra, r0: q.r0, r1: q.r1 };
        var inWay = mergesIn(reach);
        if (inWay.length) {
          throw new Error('填滿的範圍裡有合併的儲存格（' + rectLabel(inWay[0]) + '），請先取消合併');
        }

        mutate('填滿 ' + selLabel(), function () {
          var lanes = vertical ? q.c1 - q.c0 + 1 : q.r1 - q.r0 + 1;
          for (var lane = 0; lane < lanes; lane++) {
            // The source cells along this lane.
            var series = [];
            for (var i = 0; i < srcLen; i++) {
              var ref = vertical
                ? F.makeRef(q.c0 + lane, q.r0 + i)
                : F.makeRef(q.c0 + i, q.r0 + lane);
              series.push({ ref: ref, cell: cells[ref], value: computed.values[ref] });
            }

            // A numeric run of two or more sets a step; anything else repeats.
            var nums = series.map(function (s) { return s.value; });
            var allNums = series.length >= 2 && nums.every(function (v) { return typeof v === 'number'; }) &&
              !series.some(function (s) { return s.cell && s.cell.f; });
            var step = allNums ? (nums[nums.length - 1] - nums[0]) / (nums.length - 1) : 0;

            for (var k = 1; k <= extra; k++) {
              var from = series[(k - 1) % srcLen];
              var toRef = vertical
                ? F.makeRef(q.c0 + lane, q.r1 + k)
                : F.makeRef(q.c1 + k, q.r0 + lane);

              if (allNums) {
                var next = nums[nums.length - 1] + step * k;
                var carry = from.cell ? fmtOf(from.ref) : {};
                cells[toRef] = Object.assign({ v: next }, carry);
                continue;
              }
              if (!from.cell) { delete cells[toRef]; continue; }
              var copy = JSON.parse(JSON.stringify(from.cell));
              if (copy.f) {
                var dc = vertical ? 0 : (q.c1 + k) - F.parseRef(from.ref).col;
                var dr = vertical ? (q.r1 + k) - F.parseRef(from.ref).row : 0;
                copy.f = F.translate(copy.f, dc, dr);
              }
              cells[toRef] = copy;
            }
          }
        });

        // Leave the filled block selected, the way a spreadsheet does.
        select(F.makeRef(q.c0, q.r0));
        select(vertical ? F.makeRef(q.c1, q.r1 + extra) : F.makeRef(q.c1 + extra, q.r1), true);
      }

      /* ------------------------------------------------------- clipboard --- */

      /** The selection as tab-separated text, which is what other programs read. */
      function selectionTsv() {
        var q = selRect();
        var lines = [];
        for (var r = q.r0; r <= q.r1; r++) {
          var row = [];
          for (var c = q.c0; c <= q.c1; c++) {
            var v = computed.values[F.makeRef(c, r)];
            row.push(v === undefined || v === null ? '' : String(display(F.makeRef(c, r))));
          }
          lines.push(row.join('\t'));
        }
        return lines.join('\n');
      }

      async function copySelection(cut) {
        var q = selRect();
        var block = [];
        for (var r = q.r0; r <= q.r1; r++) {
          var row = [];
          for (var c = q.c0; c <= q.c1; c++) {
            var src = cells[F.makeRef(c, r)];
            row.push(src ? JSON.parse(JSON.stringify(src)) : null);
          }
          block.push(row);
        }
        /* Merged regions travel with the block, stored relative to its top-left
           corner so a paste can place them wherever it lands. Copying a merged
           header row and pasting it onto the next table is a real thing people do,
           and a copy that quietly dropped the merge would look like a bug in the
           paste. */
        var carried = mergesIn(q).map(function (m) {
          return { c0: m.c0 - q.c0, c1: m.c1 - q.c0, r0: m.r0 - q.r0, r1: m.r1 - q.r0 };
        });
        var text = selectionTsv();
        clip = { rect: q, block: block, text: text, cut: !!cut, merges: carried };
        await A.clipboard.write(text);
        ctx.toast((cut ? '已剪下 ' : '已複製 ') + selLabel() + '（' + selCount() + ' 格）');
      }

      /**
       * Paste at the active cell.
       *
       * Two sources, and which one to trust is decided by comparing them. The
       * system clipboard is what another program can put there, but it is only
       * text -- formulas and formatting do not survive it. So a copy also keeps
       * the cells themselves; that copy is used only when the clipboard still
       * holds the same text we wrote, which is how we know nothing else has
       * copied since.
       */
      async function pasteAt() {
        var read = await A.clipboard.read();
        var text = read.ok && read.data ? String(read.data.text || '') : '';
        var rich = clip && text && text === clip.text;

        var target = F.parseRef(sel);
        if (!target) return;

        if (rich) {
          var dc = target.col - clip.rect.c0;
          var dr = target.row - clip.rect.r0;
          var source = clip;
          var landing = {
            c0: target.col, r0: target.row,
            c1: target.col + blockWidth(source.block) - 1,
            r1: target.row + source.block.length - 1
          };
          var replaced = mergesIn(landing).length;
          mutate('貼上 ' + selLabel(), function () {
            if (source.cut) {
              for (var r0 = source.rect.r0; r0 <= source.rect.r1; r0++) {
                for (var c0 = source.rect.c0; c0 <= source.rect.c1; c0++) {
                  delete cells[F.makeRef(c0, r0)];
                }
              }
              // A cut region takes its merges with it.
              merges = merges.filter(function (m) { return !overlaps(m, source.rect); });
            }
            /* Whatever the block lands on gives way to it, merges included: a
               paste is a replacement, and leaving an old region claiming cells the
               new content now occupies would put values under a span that hides
               them. One Ctrl+Z puts it all back. */
            merges = merges.filter(function (m) { return !overlaps(m, landing); });
            source.block.forEach(function (row, ri) {
              row.forEach(function (cell, ci) {
                var ref = F.makeRef(target.col + ci, target.row + ri);
                if (!cell) { delete cells[ref]; return; }
                var copy = JSON.parse(JSON.stringify(cell));
                // A relative reference means "the same shape from here", so it
                // moves with the block; a pinned one does not.
                if (copy.f) copy.f = F.translate(copy.f, dc, dr);
                cells[ref] = copy;
                var pos = F.parseRef(ref);
                if (pos.col >= COLS) COLS = Math.min(200, pos.col + 1);
                if (pos.row >= ROWS) ROWS = Math.min(2000, pos.row + 1);
              });
            });
            // And the block's own merges, placed where it landed.
            (source.merges || []).forEach(function (m) {
              merges.push({
                c0: target.col + m.c0, c1: target.col + m.c1,
                r0: target.row + m.r0, r1: target.row + m.r1
              });
            });
            merges = normMerges(merges);
          });
          var wideRich = blockWidth(source.block);
          if (replaced) ctx.toast('貼上時取代了 ' + replaced + ' 個合併區域', 't-warn');
          if (source.cut) clip = null;
          // Leave the pasted block selected, so the next action can act on it.
          select(sel);
          select(F.makeRef(target.col + wideRich - 1, target.row + source.block.length - 1), true);
          return;
        }

        if (!text) { ctx.toast('剪貼簿是空的', 't-warn'); return; }

        // Foreign text: tab-separated columns, newline-separated rows. That is
        // what every spreadsheet and most tables on the web put on a clipboard.
        var rows = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
          .map(function (line) { return line.split('\t'); });
        var wide = rows.reduce(function (n, r) { return Math.max(n, r.length); }, 1);
        var area = {
          c0: target.col, r0: target.row,
          c1: target.col + wide - 1, r1: target.row + rows.length - 1
        };
        var lost = mergesIn(area).length;
        mutate('貼上文字', function () {
          // Same rule as the rich path: the incoming block owns the cells it fills.
          merges = merges.filter(function (m) { return !overlaps(m, area); });
          rows.forEach(function (row, ri) {
            row.forEach(function (val, ci) {
              writeCell(F.makeRef(target.col + ci, target.row + ri), val);
            });
          });
        });
        if (lost) ctx.toast('貼上時取消了 ' + lost + ' 個合併區域', 't-warn');
        select(sel);
        select(F.makeRef(target.col + wide - 1, target.row + rows.length - 1), true);
      }

      function blockWidth(block) {
        return block.reduce(function (n, r) { return Math.max(n, r.length); }, 1);
      }

      function recalc() {
        var out = F.recalcBook(bookCells());
        /* Only the active sheet's results reach the grid, but the pass covered
           every sheet -- a formula here may read one the user is not looking at,
           and computing sheet by sheet would leave those a recalculation behind. */
        computed = {
          values: out.values[sheetName] || {},
          errors: out.errors[sheetName] || {},
          cyclic: (out.cyclic || []).filter(function (key) {
            return key.indexOf('!') < 0 || key.indexOf(sheetName + '!') === 0;
          }).map(function (key) {
            var cut = key.lastIndexOf('!');
            return cut < 0 ? key : key.slice(cut + 1);
          })
        };
        render();
        publish();
        ctx.save();
      }

      /* -------------------------------------------------------- rendering */

      /* Borders are stored per cell as the edges that cell draws -- an object of
         up to four { style, width, colour } edges. Storing the *intent* instead
         ("this range has an outer box") would mean every cell had to know where
         it sat inside a range it no longer belongs to once a row is inserted.

         The arithmetic, the vocabulary and the pen are AIOS.borders', shared with
         the tables in a document and on a slide: the same line, drawn the same
         way, whichever program is in front of you. */

      /**
       * Apply a border command over a rectangle.
       *
       * A merged cell is measured by the region it covers, not by its top-left
       * corner: the node that draws the border reaches the far side of the span,
       * so asking whether its own column is the last one in the range would leave
       * the right-hand edge of every merged block undrawn. A swallowed cell draws
       * nothing, so it is given nothing.
       */
      function applyBorder(rect, kind, pen) {
        var touched = 0;
        for (var r = rect.r0; r <= rect.r1; r++) {
          for (var c = rect.c0; c <= rect.c1; c++) {
            var m = mergeAt(c, r);
            if (m && (m.c0 !== c || m.r0 !== r)) continue;
            var own = m || { c0: c, r0: r, c1: c, r1: r };
            var ref = F.makeRef(c, r);
            var was = (cells[ref] || {}).border;
            var now = AIOS.borders.patch(was, AIOS.borders.edgesFor(kind, own, rect, pen));
            if (!AIOS.borders.same(was, now)) touched++;
            applyFormat([ref], { border: now });
          }
        }
        return touched;
      }

      /** What one cell shows. The single place a stored value becomes text. */
      function display(ref) {
        var c = cells[ref];
        var v = computed.values[ref];
        if (typeof v === 'number' && !isFinite(v)) return '#NUM!';
        return F.format(v, c && c.numFmt ? c.numFmt : 'General');
      }

      function render() {
        table.innerHTML = '';
        // The sheet default, inherited by every cell that does not override it.
        table.style.fontFamily = AIOS.fonts.cssFor(sheetFont);
        table.style.fontSize = sheetSize + 'pt';

        // Which cells span and which are swallowed, answered once for the draw.
        var mm = G.map(merges);

        /* Frozen panes need pixel offsets, so the leading sizes are added up once
           here rather than measured per cell. The row-header column is always
           frozen, which is why the column offsets start at its width. */
        var colLeft = [];
        var runningLeft = 34;
        for (var ci = 0; ci < COLS; ci++) {
          colLeft.push(runningLeft);
          runningLeft += colWidths[ci] || DEFAULT_COL_W;
        }
        var rowTop = [];
        var runningTop = DEFAULT_ROW_H;
        for (var ri = 0; ri < ROWS; ri++) {
          rowTop.push(runningTop);
          runningTop += rowHeights[ri] || DEFAULT_ROW_H;
        }

        /* Column widths live in a colgroup, and the table is laid out fixed.
           Measured before this existed: dragging a column edge did update
           colWidths and did write width:178px onto the header, and the column
           stayed 78px wide. Under `table-layout: auto` a cell's width is only a
           suggestion, and it loses to the min-width every cell in the column
           carries -- so the drag worked, saved, and changed nothing on screen.
           Row heights appeared to work because a row's height acts as a minimum,
           so growing one needs nobody's permission.

           A colgroup rather than widths on the header cells, because the PDF
           export reuses `table.innerHTML` with the header row hidden: widths
           carried by cells that are `display: none` would take the column sizes
           out of the exported page. A `col` is not part of any row. */
        var group = el('colgroup');
        var rowHeadCol = el('col');
        rowHeadCol.style.width = '34px';
        group.appendChild(rowHeadCol);
        for (var cg = 0; cg < COLS; cg++) {
          var colEl = el('col');
          colEl.dataset.col = String(cg);
          colEl.style.width = (colWidths[cg] || DEFAULT_COL_W) + 'px';
          group.appendChild(colEl);
        }
        table.appendChild(group);
        table.style.tableLayout = 'fixed';
        // runningLeft finished as the row header plus every column, which is
        // exactly the width the fixed layout needs to be given.
        table.style.width = runningLeft + 'px';

        var head = el('tr');
        head.appendChild(el('th', 'sh-corner', ''));
        for (var c = 0; c < COLS; c++) {
          var th = el('th', 'sh-colhead', F.indexToCol(c));
          th.dataset.col = String(c);
          if (c < freeze.cols) {
            th.classList.add('sh-frozen-col');
            th.style.left = colLeft[c] + 'px';
          }
          var grip = el('span', 'sh-colgrip');
          grip.dataset.col = String(c);
          grip.setAttribute('aria-hidden', 'true');
          th.appendChild(grip);
          head.appendChild(th);
        }
        table.appendChild(head);

        for (var r = 0; r < ROWS; r++) {
          var tr = el('tr');
          var rh = el('th', 'sh-rowhead', String(r + 1));
          rh.dataset.row = String(r);
          if (rowHeights[r]) rh.style.height = rowHeights[r] + 'px';
          if (r < freeze.rows) {
            rh.classList.add('sh-frozen-row');
            rh.style.top = rowTop[r] + 'px';
          }
          var rgrip = el('span', 'sh-rowgrip');
          rgrip.dataset.row = String(r);
          rgrip.setAttribute('aria-hidden', 'true');
          rh.appendChild(rgrip);
          tr.appendChild(rh);

          for (var c2 = 0; c2 < COLS; c2++) {
            var ref = F.makeRef(c2, r);
            // A covered cell produces no node. That is how a table spans, and it
            // is why colspan reaches the PDF export without the exporter knowing.
            if (mm.coveredBy[G.key(c2, r)]) continue;

            var td = el('td', 'sh-cell');
            td.dataset.ref = ref;
            var span = mm.masterAt[G.key(c2, r)];
            if (span) {
              td.classList.add('sh-merged');
              if (span.c1 > span.c0) td.colSpan = span.c1 - span.c0 + 1;
              if (span.r1 > span.r0) td.rowSpan = span.r1 - span.r0 + 1;
            }
            /* A spanning cell takes its size from the columns and rows it covers,
               so pinning it to the first one's width would fight the table. */
            if (colWidths[c2] && (!span || span.c1 === span.c0)) td.style.width = colWidths[c2] + 'px';
            if (rowHeights[r] && (!span || span.r1 === span.r0)) td.style.height = rowHeights[r] + 'px';
            /* A frozen cell is sticky on the axes it is frozen on. Both at once
               for the top-left block, which is why these are not exclusive. */
            if (r < freeze.rows) {
              td.classList.add('sh-frozen-row');
              td.style.top = rowTop[r] + 'px';
            }
            if (c2 < freeze.cols) {
              td.classList.add('sh-frozen-col');
              td.style.left = colLeft[c2] + 'px';
            }

            var cell = cells[ref];
            var val = computed.values[ref];
            if (cell && cell.f) td.classList.add('formula');
            if (F.isErr(val)) td.classList.add('err');
            if (typeof val === 'number') td.classList.add('num');
            td.textContent = display(ref);
            if (cell) {
              // Only overrides get inline styles; the rest inherit the sheet
              // default from the table, so changing that default is one write.
              if (cell.font) td.style.fontFamily = AIOS.fonts.cssFor(cell.font);
              if (cell.size) td.style.fontSize = cell.size + 'pt';
              if (cell.bold) td.style.fontWeight = '700';
              if (cell.italic) td.style.fontStyle = 'italic';
              if (cell.under || cell.strike) {
                td.style.textDecoration =
                  (cell.under ? 'underline ' : '') + (cell.strike ? 'line-through' : '');
              }
              if (cell.bg) td.style.background = '#' + cell.bg;
              if (cell.fg) td.style.color = '#' + cell.fg;
              // An explicit alignment beats the automatic right-align on numbers.
              if (cell.align) td.style.textAlign = cell.align;
              if (cell.wrap) { td.style.whiteSpace = 'pre-wrap'; td.classList.add('sh-wrapped'); }
              /* noneAs '' because what lies under a cell here is a gridline, not
                 the table's border. Excel keeps gridlines whatever the borders
                 say, so 無框線 goes back to the grid rather than to nothing. */
              if (cell.border) AIOS.borders.paint(td, cell.border, { noneAs: '' });
            }
            if (cell && cell.f) td.title = cell.f + (computed.errors[ref] ? '  ⟶ ' + computed.errors[ref] : '');
            tr.appendChild(td);
          }
          table.appendChild(tr);
        }

        renderTabs();
        paintSelection();
        syncBars();
        placeFillHandle();
      }

      /* The fill handle sits on the corner of the selection, positioned over the
         grid the way the editor is -- owned by the wrapper rather than by a cell,
         so a full redraw of the table does not have to know about it. */
      function placeFillHandle() {
        var q = selRect();
        // The far corner may be swallowed by a merge, in which case the node that
        // reaches that corner is its master.
        var corner = table.querySelector('td[data-ref="' +
          visibleRef(F.makeRef(q.c1, q.r1)) + '"]');
        if (!corner) { fillHandle.hidden = true; return; }
        var cr = corner.getBoundingClientRect();
        var wr = wrap.getBoundingClientRect();
        fillHandle.style.left = (cr.right - wr.left + wrap.scrollLeft - 4) + 'px';
        fillHandle.style.top = (cr.bottom - wr.top + wrap.scrollTop - 4) + 'px';
        fillHandle.hidden = false;
      }

      /* Selection is painted separately from the grid because dragging across a
         range redraws it on every pointer move, and rebuilding sixteen hundred
         cells at that rate is visible. Only the cells that were highlighted last
         time are cleared, so the work is proportional to the selection rather
         than to the sheet. */
      var painted = [];

      function paintSelection() {
        painted.forEach(function (n) {
          n.classList.remove('sh-sel', 'sh-active', 'on');
        });
        painted = [];

        var q = selRect();
        var done = {};
        for (var r = q.r0; r <= q.r1; r++) {
          for (var c = q.c0; c <= q.c1; c++) {
            // A merged region has one node for many positions; painting it once
            // per covered cell would push the same node onto `painted` repeatedly.
            var node = visibleRef(F.makeRef(c, r));
            if (done[node]) continue;
            done[node] = true;
            var td = table.querySelector('td[data-ref="' + node + '"]');
            if (!td) continue;
            td.classList.add('sh-sel');
            painted.push(td);
          }
        }
        var active = table.querySelector('td[data-ref="' + sel + '"]');
        if (active) { active.classList.add('sh-active'); painted.push(active); }

        // Headers show the whole span, which is how you can see what Ctrl+Space
        // actually selected.
        for (var hc = q.c0; hc <= q.c1; hc++) {
          var th = table.querySelector('th.sh-colhead[data-col="' + hc + '"]');
          if (th) { th.classList.add('on'); painted.push(th); }
        }
        for (var hr = q.r0; hr <= q.r1; hr++) {
          var rh2 = table.querySelector('th.sh-rowhead[data-row="' + hr + '"]');
          if (rh2) { rh2.classList.add('on'); painted.push(rh2); }
        }
      }

      /** Everything outside the grid that describes the selection. */
      function syncBars() {
        refTag.textContent = selLabel();
        input.value = raw(sel);
        nameTag.textContent = sheetName + (dirty ? ' \u25cf' : '');

        // Reflect the active cell's own formatting, not the sheet default, so
        // "預設" in the picker means the cell really is inheriting.
        var selFmt = fmtOf(sel);
        fontSel.value = selFmt.font || '';
        sizeSel.value = selFmt.size ? String(selFmt.size) : '';
        btnBold.setAttribute('aria-pressed', selFmt.bold ? 'true' : 'false');
        btnItalic.setAttribute('aria-pressed', selFmt.italic ? 'true' : 'false');
        btnUnder.setAttribute('aria-pressed', selFmt.under ? 'true' : 'false');
        btnStrike.setAttribute('aria-pressed', selFmt.strike ? 'true' : 'false');
        alignSel.value = selFmt.align || '';

        /* The merge button is a toggle, so it has to say which way it is pointing.
           Pressed means "this selection is one merged region and I will unmerge
           it"; unpressed means "I will merge what you have selected". */
        var mq = selRect();
        var mHit = mergesIn(mq);
        var mExact = mHit.length === 1 && mHit[0].c0 === mq.c0 && mHit[0].c1 === mq.c1 &&
                     mHit[0].r0 === mq.r0 && mHit[0].r1 === mq.r1;
        btnMerge.setAttribute('aria-pressed', mExact ? 'true' : 'false');
        btnMerge.classList.toggle('on', mExact);
        btnMerge.textContent = mExact ? '取消合併' : '跨欄置中';
        btnMerge.disabled = !mExact && !isMulti();

        /* A format code the toolbar has no entry for is still shown as itself,
           because silently falling back to 一般 would tell the user their custom
           code had been thrown away when it had not. */
        var code = selFmt.numFmt || '';
        if (code && !NUM_FORMATS.some(function (f) { return f.code === code; })) {
          customOpt.textContent = '自訂：' + code;
          customOpt.value = code;
          numSel.value = code;
        } else {
          customOpt.textContent = '自訂格式碼…';
          customOpt.value = CUSTOM_FMT;
          numSel.value = code;
        }
        btnUndo.disabled = !undoStack.length;
        btnRedo.disabled = !redoStack.length;

        var used = Object.keys(cells).length;
        var formulas = Object.keys(cells).filter(function (k) { return cells[k].f; }).length;
        var errs = Object.keys(computed.errors).length;

        var bits = [path || '（未儲存的新試算表）'];
        if (isMulti()) {
          /* What Excel puts in the status bar, and for the same reason: selecting
             a column of numbers to see their total is the most common thing
             anyone does with a spreadsheet, and it should not require typing a
             formula somewhere to find out. */
          var q = selRect();
          var nums = [];
          selRefs().forEach(function (ref) {
            var v = computed.values[ref];
            if (typeof v === 'number' && isFinite(v)) nums.push(v);
          });
          var filled = selRefs().filter(function (ref) {
            var v = computed.values[ref];
            return v !== '' && v !== undefined && v !== null;
          }).length;
          bits.push('已選 ' + (q.r1 - q.r0 + 1) + '×' + (q.c1 - q.c0 + 1) + '　' + selLabel());
          if (nums.length) {
            var total = nums.reduce(function (a, b) { return a + b; }, 0);
            bits.push('加總 ' + fmt(total));
            bits.push('平均 ' + fmt(total / nums.length));
          }
          bits.push('數值 ' + nums.length + '／有值 ' + filled);
        } else {
          bits.push(used + ' 格有值（' + formulas + ' 個公式）');
        }
        if (errs) bits.push(errs + ' 個錯誤');
        if (computed.cyclic && computed.cyclic.length) bits.push('循環參照：' + computed.cyclic.join(','));
        status.textContent = bits.join('　·　');
      }

      /**
       * Move or extend the selection. `extend` keeps the anchor where it is,
       * which is the whole difference between a click and a shift-click.
       */
      function select(ref, extend) {
        if (!F.parseRef(ref)) return;
        commitEditor();
        /* Land on the master, never on a covered cell. The active cell is what
           the formula bar edits and what typing lands in, and a covered cell has
           neither a value of its own nor a node to edit in. The rectangle is not
           narrowed by this: selRect() grows over the region either way. */
        var landing = visibleRef(ref);
        sel = landing;
        if (!extend) anchor = landing;
        paintSelection();
        syncBars();
        placeFillHandle();
        var td = table.querySelector('td[data-ref="' + landing + '"]');
        if (td) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }

      /** Select a whole column or row, and the used range for Ctrl+A. */
      function selectSpan(kind) {
        var p = F.parseRef(sel);
        if (kind === 'col') {
          anchor = F.makeRef(p.col, 0);
          sel = F.makeRef(p.col, ROWS - 1);
        } else if (kind === 'row') {
          anchor = F.makeRef(0, p.row);
          sel = F.makeRef(COLS - 1, p.row);
        } else {
          var maxC = 0;
          var maxR = 0;
          Object.keys(cells).forEach(function (ref) {
            var q = F.parseRef(ref);
            if (!q) return;
            maxC = Math.max(maxC, q.col);
            maxR = Math.max(maxR, q.row);
          });
          anchor = 'A1';
          sel = F.makeRef(maxC, maxR);
        }
        paintSelection();
        syncBars();
        placeFillHandle();
      }

      /**
       * Open the in-place editor over the active cell.
       *
       * `initial` given means a character was typed at a selected cell, which in
       * every spreadsheet replaces what was there -- that is how you overwrite a
       * cell without deleting it first.
       *
       * `initial` omitted means F2, Enter or a double-click: carry on editing what
       * is already in the cell. The caret goes to the end and **nothing is
       * selected**. It used to call editor.select(), so the existing value was
       * highlighted and the first keystroke wiped it -- which made double-click a
       * slower way of doing what typing already did, and left no way at all to
       * append to a long formula.
       */
      function beginEdit(initial) {
        var td = table.querySelector('td[data-ref="' + sel + '"]');
        if (!td) return;
        editing = sel;
        var r = td.getBoundingClientRect();
        var wr = wrap.getBoundingClientRect();
        editor.style.left = (r.left - wr.left + wrap.scrollLeft) + 'px';
        editor.style.top = (r.top - wr.top + wrap.scrollTop) + 'px';
        // Room for more text than the column is wide, because editing a formula in
        // a 78px box is editing it through a slot.
        editor.style.width = Math.max(r.width, 180) + 'px';
        editor.style.height = r.height + 'px';
        editor.hidden = false;
        editor.value = initial !== undefined ? initial : raw(sel);
        editor.focus();
        var end = editor.value.length;
        editor.setSelectionRange(end, end);
      }

      function commitEditor() {
        if (!editing) return;
        var ref = editing;
        editing = null;
        editor.hidden = true;
        try {
          setCell(ref, editor.value);
        } catch (e) {
          ctx.toast(e.message, 't-err');
        }
      }

      function cancelEditor() {
        editing = null;
        editor.hidden = true;
      }

      /**
       * One step of the arrow keys.
       *
       * A merged region is one cell to walk over, not several to walk through: an
       * arrow key leaving a three-column merge lands past it, and one arriving at
       * it lands on its master. Without this, pressing Right inside a merge does
       * nothing visible twice and then works, which reads as a stuck keyboard.
       */
      function move(dc, dr, extend) {
        var p = F.parseRef(sel);
        var c = p.col + dc;
        var r = p.row + dr;
        for (var guard = 0; guard < 64; guard++) {
          var m = mergeAt(c, r);
          if (!m || (m.c0 === c && m.r0 === r)) break;
          if (dc > 0) c = m.c1 + 1;
          else if (dc < 0) c = m.c0 - 1;
          else if (dr > 0) r = m.r1 + 1;
          else if (dr < 0) r = m.r0 - 1;
          else break;
        }
        c = Math.max(0, Math.min(COLS - 1, c));
        r = Math.max(0, Math.min(ROWS - 1, r));
        select(F.makeRef(c, r), extend);
      }

      /* ------------------------------------------------------ style panel ---

         Fill, text colour, borders and wrapping, in one small panel rather than
         four more controls on a toolbar that already wraps onto two rows. It is
         built here rather than in the shared UI because it is the only place in
         the machine that needs colour swatches; a general-purpose colour picker
         would be a bigger thing than the problem.
      */

      /**
       * The border toolbox, dropped from the toolbar.
       *
       * The same panel the style panel embeds and the same one a document's table
       * raises, so the pen carries between them: set a double 1 1/2 pt line here
       * and the next border drawn in a document is that line.
       */
      function openBorderPopover() {
        var rect = selRect();
        AIOS.popover(ctx.body, btnBorder, function (p) {
          AIOS.popover.label(p, '框線與網底');
          AIOS.borders.panel(p, {
            scope: '選取範圍：' + selLabel() + '　·　' +
                   AIOS.borders.describe((cells[sel] || {}).border),
            fill: (cells[sel] || {}).bg || null,
            onFill: function (hex) {
              AIOS.popover.close(ctx.body);
              setFormat(selRefs(), { bg: hex || null });
            },
            onApply: function (kind) {
              AIOS.popover.close(ctx.body);
              mutate('框線 ' + selLabel(), function () {
                applyBorder(rect, kind, null);
              }, { recalc: false });
            }
          });
        }, 'ui-pop-wide');
      }

      function openStylePanel() {
        var existing = ctx.body.querySelector('.sh-style-scrim');
        if (existing) { existing.remove(); return; }

        var refs = selRefs();
        var current = fmtOf(sel);

        var scrim = el('div', 'sh-style-scrim');
        var panel = el('div', 'sh-style');
        panel.appendChild(el('div', 'sh-style-head', '樣式：' + selLabel()));

        function swatchRow(title, key) {
          panel.appendChild(el('div', 'sh-style-label', title));
          var row = el('div', 'ui-swatches');
          CELL_COLOURS.forEach(function (col) {
            var b = el('button', 'ui-swatch' + (current[key] === col.hex || (!current[key] && !col.hex) ? ' on' : ''));
            b.type = 'button';
            b.title = col.name;
            b.setAttribute('aria-label', title + ' ' + col.name);
            if (col.hex) b.style.background = '#' + col.hex;
            else b.textContent = '\u2715';
            b.addEventListener('click', function () {
              var patch = {};
              patch[key] = col.hex || null;
              setFormat(refs, patch);
              scrim.remove();
            });
            row.appendChild(b);
          });
          panel.appendChild(row);
        }

        swatchRow('底色', 'bg');
        swatchRow('文字色', 'fg');

        /* The border toolbox is the shared one. A line drawn here and a line
           drawn in a document's table are the same line, chosen with the same
           pen -- and the pen is shared state, so setting it once is enough. */
        panel.appendChild(el('div', 'sh-style-label', '框線'));
        var borderBox = el('div', 'sh-style-borders');
        AIOS.borders.panel(borderBox, {
          scope: '目前的範圍：' + selLabel() + '　·　' + AIOS.borders.describe(current.border),
          onApply: function (kind) {
            var rect = selRect();
            mutate('框線 ' + selLabel(), function () {
              applyBorder(rect, kind, null);
            }, { recalc: false });
            scrim.remove();
          }
        });
        panel.appendChild(borderBox);

        panel.appendChild(el('div', 'sh-style-label', '其他'));
        var orow = el('div', 'sh-style-row');
        var wrapBtn = el('button', 'fbtn', current.wrap ? '取消自動換行' : '自動換行');
        wrapBtn.type = 'button';
        wrapBtn.addEventListener('click', function () {
          setFormat(refs, { wrap: !current.wrap });
          scrim.remove();
        });
        var clearBtn = el('button', 'fbtn', '清除所有格式');
        clearBtn.type = 'button';
        clearBtn.addEventListener('click', function () {
          var patch = {};
          CELL_FMT.forEach(function (k) { patch[k] = null; });
          setFormat(refs, patch);
          scrim.remove();
        });
        orow.appendChild(wrapBtn);
        orow.appendChild(clearBtn);
        panel.appendChild(orow);

        scrim.appendChild(panel);
        ctx.body.appendChild(scrim);
        scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) scrim.remove(); });
        panel.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') { e.preventDefault(); scrim.remove(); }
        });
        var firstBtn = panel.querySelector('button');
        if (firstBtn) firstBtn.focus();
      }

      /* -------------------------------------------------------- listeners */

      /* Pointer, not click: a range is selected by pressing on one corner and
         dragging to the other, and click fires too late to see that happen. */
      var dragging = false;

      /* Dragging the fill handle. Kept apart from range selection because it
         starts on the handle, not on a cell, and ends by writing rather than by
         selecting. */
      var filling = false;

      fillHandle.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        filling = true;
        try { fillHandle.setPointerCapture(e.pointerId); } catch (err) { /* older path */ }
        e.preventDefault();
        e.stopPropagation();
      });
      fillHandle.addEventListener('pointermove', function (e) {
        if (!filling) return;
        var node = document.elementFromPoint(e.clientX, e.clientY);
        var td = node && node.closest ? node.closest('td[data-ref]') : null;
        if (td) fillHandle.dataset.to = td.dataset.ref;
      });
      function endFill(e) {
        if (!filling) return;
        filling = false;
        try { fillHandle.releasePointerCapture(e.pointerId); } catch (err) { /* gone */ }
        var to = fillHandle.dataset.to;
        delete fillHandle.dataset.to;
        if (to) {
          try { fillTo(to); } catch (err) { ctx.toast(err.message, 't-err'); }
        }
      }
      fillHandle.addEventListener('pointerup', endFill);
      fillHandle.addEventListener('pointercancel', endFill);

      /* Resizing a column or a row by its header's edge. */
      var sizing = null;

      table.addEventListener('pointerdown', function (e) {
        var grip = e.target.closest && e.target.closest('.sh-colgrip, .sh-rowgrip');
        if (grip && e.button === 0) {
          var isCol = grip.classList.contains('sh-colgrip');
          sizing = {
            isCol: isCol,
            index: Number(isCol ? grip.dataset.col : grip.dataset.row),
            from: isCol ? e.clientX : e.clientY
          };
          sizing.start = isCol
            ? (colWidths[sizing.index] || DEFAULT_COL_W)
            : (rowHeights[sizing.index] || DEFAULT_ROW_H);
          try { table.setPointerCapture(e.pointerId); } catch (err) { /* older path */ }
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        onGridPointerDown(e);
      });

      function onGridPointerDown(e) {
        if (e.button !== 0) return;
        var td = e.target.closest && e.target.closest('td[data-ref]');
        if (td) {
          dragging = true;
          select(td.dataset.ref, e.shiftKey);
          wrap.focus();
          // Capture so the drag survives leaving the cell it started in.
          try { table.setPointerCapture(e.pointerId); } catch (err) { /* older path */ }
          e.preventDefault();
          return;
        }
        // A header selects its whole column or row.
        var th = e.target.closest && e.target.closest('th[data-col], th[data-row]');
        if (th) {
          if (th.dataset.col !== undefined) {
            select(F.makeRef(Number(th.dataset.col), 0));
            selectSpan('col');
          } else {
            select(F.makeRef(0, Number(th.dataset.row)));
            selectSpan('row');
          }
          wrap.focus();
          e.preventDefault();
        }
      }

      table.addEventListener('pointermove', function (e) {
        if (sizing) {
          var delta = (sizing.isCol ? e.clientX : e.clientY) - sizing.from;
          var next = Math.max(sizing.isCol ? 32 : 16, Math.round(sizing.start + delta));
          if (sizing.isCol) colWidths[sizing.index] = next;
          else rowHeights[sizing.index] = next;
          applyLiveSize(sizing.isCol, sizing.index, next);
          return;
        }
        if (!dragging) return;
        // elementFromPoint because the pointer is captured by the table, so the
        // event target no longer follows the cursor.
        var node = document.elementFromPoint(e.clientX, e.clientY);
        var td = node && node.closest ? node.closest('td[data-ref]') : null;
        if (td && td.dataset.ref !== sel) select(td.dataset.ref, true);
      });

      /* During a resize drag only the affected cells are touched. Redrawing the
         whole table on every pointer move would be a visible stutter, and the
         final render happens once on release. */
      function applyLiveSize(isCol, index, px) {
        if (isCol) {
          /* One col element and the table's own width, which is all a fixed
             layout reads. Setting it on the cells instead is what did not work:
             see the colgroup in the draw. */
          var colEl = table.querySelector('colgroup col[data-col="' + index + '"]');
          if (colEl) colEl.style.width = px + 'px';
          var total = 34;
          for (var k = 0; k < COLS; k++) total += (k === index ? px : (colWidths[k] || DEFAULT_COL_W));
          table.style.width = total + 'px';
        } else {
          var rh = table.querySelector('th.sh-rowhead[data-row="' + index + '"]');
          if (rh) rh.style.height = px + 'px';
          table.querySelectorAll('td[data-ref]').forEach(function (td) {
            var p2 = F.parseRef(td.dataset.ref);
            if (p2 && p2.row === index && td.rowSpan < 2) td.style.height = px + 'px';
          });
        }
      }

      function endDrag(e) {
        if (sizing) {
          var was = sizing;
          sizing = null;
          try { table.releasePointerCapture(e.pointerId); } catch (err) { /* gone */ }
          var px = was.isCol ? colWidths[was.index] : rowHeights[was.index];
          // Recorded as an undo step now that the size is settled, rather than
          // once per pixel of the drag.
          var before = was.isCol ? colWidths : rowHeights;
          var key = was.index;
          var restore = was.start;
          if (was.isCol) colWidths[key] = restore; else rowHeights[key] = restore;
          mutate((was.isCol ? '欄寬 ' + F.indexToCol(key) : '列高 ' + (key + 1)) + ' ' + px + 'px',
            function () { before[key] = px; }, { recalc: false });
          return;
        }
        if (!dragging) return;
        dragging = false;
        try { table.releasePointerCapture(e.pointerId); } catch (err) { /* gone */ }
      }
      table.addEventListener('pointerup', endDrag);
      table.addEventListener('pointercancel', endDrag);

      /**
       * Double-click a cell to carry on editing what is in it.
       *
       * The cell is found by coordinates, not from `e.target`. Pressing a cell
       * captures the pointer on the table, and pointer capture retargets the
       * compatibility mouse events to the capturing element -- so `e.target` here
       * is the table, `closest('td[data-ref]')` finds nothing, and the handler
       * returned without doing anything. Which is why only F2 worked.
       *
       * The pointermove handler above already resolves cells this way, for exactly
       * the same reason.
       */
      table.addEventListener('dblclick', function (e) {
        var node = document.elementFromPoint(e.clientX, e.clientY);
        var td = node && node.closest ? node.closest('td[data-ref]') : null;
        if (!td) return;
        if (editing === td.dataset.ref) return;      // already open on this cell
        select(td.dataset.ref);
        beginEdit();
      });

      editor.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commitEditor(); move(0, 1); }
        else if (e.key === 'Escape') { e.preventDefault(); cancelEditor(); }
        else if (e.key === 'Tab') { e.preventDefault(); commitEditor(); move(e.shiftKey ? -1 : 1, 0); }
      });
      editor.addEventListener('blur', commitEditor);

      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          try { setCell(sel, input.value); } catch (err) { ctx.toast(err.message, 't-err'); }
          move(0, 1);
        }
      });

      wrap.addEventListener('keydown', function (e) {
        if (editing) return;
        var k = e.key;
        var mod = e.ctrlKey || e.metaKey;

        if (mod) {
          var lower = k.toLowerCase();
          if (lower === 's') { e.preventDefault(); save(); return; }
          if (lower === 'z') {
            e.preventDefault();
            if (e.shiftKey) redo(); else undo();
            return;
          }
          if (lower === 'y') { e.preventDefault(); redo(); return; }
          if (lower === 'c') { e.preventDefault(); copySelection(false); return; }
          if (lower === 'x') { e.preventDefault(); copySelection(true); return; }
          if (lower === 'v') { e.preventDefault(); pasteAt(); return; }
          if (lower === 'a') { e.preventDefault(); selectSpan('used'); return; }
          if (k === ' ') { e.preventDefault(); selectSpan('col'); return; }
        }
        if (e.shiftKey && k === ' ') { e.preventDefault(); selectSpan('row'); return; }

        if (k === 'ArrowUp') { e.preventDefault(); move(0, -1, e.shiftKey); }
        else if (k === 'ArrowDown') { e.preventDefault(); move(0, 1, e.shiftKey); }
        else if (k === 'ArrowLeft') { e.preventDefault(); move(-1, 0, e.shiftKey); }
        else if (k === 'ArrowRight') { e.preventDefault(); move(1, 0, e.shiftKey); }
        else if (k === 'Tab') { e.preventDefault(); move(e.shiftKey ? -1 : 1, 0); }
        else if (k === 'Home') { e.preventDefault(); select(F.makeRef(0, F.parseRef(sel).row), e.shiftKey); }
        else if (k === 'Escape') { e.preventDefault(); select(sel); }
        else if (k === 'Enter' || k === 'F2') { e.preventDefault(); beginEdit(); }
        else if (k === 'Delete' || k === 'Backspace') {
          e.preventDefault();
          var refs = selRefs();
          try {
            mutate('清空 ' + selLabel(), function () {
              refs.forEach(function (ref) { writeCell(ref, ''); });
            });
          } catch (err) { ctx.toast(err.message, 't-err'); }
        } else if (k.length === 1 && !e.altKey) {
          e.preventDefault();
          beginEdit(k);
        }
      });
      wrap.tabIndex = 0;

      btnRows.addEventListener('click', function () { ROWS = Math.min(2000, ROWS + 20); render(); });
      btnCols.addEventListener('click', function () { COLS = Math.min(200, COLS + 5); render(); });
      btnUndo.addEventListener('click', undo);
      btnRedo.addEventListener('click', redo);
      btnUnder.addEventListener('click', function () {
        setFormat(selRefs(), { under: !fmtOf(sel).under });
      });
      btnStrike.addEventListener('click', function () {
        setFormat(selRefs(), { strike: !fmtOf(sel).strike });
      });
      alignSel.addEventListener('change', function () {
        setFormat(selRefs(), { align: alignSel.value || null });
      });
      numSel.addEventListener('change', async function () {
        if (numSel.value !== CUSTOM_FMT) {
          setFormat(selRefs(), { numFmt: numSel.value || null });
          return;
        }
        var code = await ctx.prompt({
          label: '自訂數字格式碼',
          note: '用 Excel 的格式語言，例如 #,##0.0「元」、0.000、yyyy"年"m"月"。\n' +
                '支援單一區段；分號條件式與顏色不支援。',
          value: fmtOf(sel).numFmt || '#,##0.00',
          selectStem: false
        });
        if (code === null) { syncBars(); return; }
        setFormat(selRefs(), { numFmt: code || null });
      });
      btnMerge.addEventListener('click', function () {
        try { ctx.toast(toggleMergeCentre(), 't-ok'); }
        catch (e) { ctx.toast(e.message, 't-warn'); }
      });
      btnStyle.addEventListener('click', function () { openStylePanel(); });
      btnBorder.addEventListener('click', function () { openBorderPopover(); });
      fontSel.addEventListener('change', async function () {
        var chosen = await AIOS.fonts.resolveChoice(fontSel.value, ctx.win.el);
        if (chosen === null) { render(); return; }
        setFormat(selRefs(), { font: chosen || null });
      });
      sizeSel.addEventListener('change', function () {
        var v = sizeSel.value;
        setFormat(selRefs(), { size: v ? Number(v) : null });
      });
      /* Toggling from the active cell, applied to the whole selection: that is
         what makes bolding a column one action, and it matches what the button
         is showing as pressed. */
      btnBold.addEventListener('click', function () {
        setFormat(selRefs(), { bold: !fmtOf(sel).bold });
      });
      btnItalic.addEventListener('click', function () {
        setFormat(selRefs(), { italic: !fmtOf(sel).italic });
      });
      btnSheetFont.addEventListener('click', async function () {
        var name = await ctx.prompt({
          label: '整張表的預設字型',
          note: '目前是 ' + sheetFont + ' ' + sheetSize + 'pt。留白代表不改字型。\n' +
                '可用：' + AIOS.fonts.families.map(function (f) { return f.name; }).join('、'),
          value: sheetFont,
          selectStem: false
        });
        if (name === null) return;
        var sizeStr = await ctx.prompt({ label: '預設字級（pt）', value: String(sheetSize), selectStem: false });
        if (sizeStr === null) return;
        if (name) sheetFont = name;
        var n = Number(sizeStr);
        if (Number.isFinite(n) && n > 0) sheetSize = Math.max(4, Math.min(200, n));
        dirty = true;
        render();
        ctx.toast('整張表改成 ' + sheetFont + ' ' + sheetSize + 'pt', 't-ok');
      });

      btnSave.addEventListener('click', function () { save(); });
      btnSaveAs.addEventListener('click', function () { saveAs(); });
      btnExport.addEventListener('click', function () {
        AIOS.popover(ctx.body, btnExport, function (p, close) {
          AIOS.popover.label(p, '匯出');
          var row = el('div', 'ui-pop-row');
          [['CSV', 'csv', '只有值，沒有格式'],
           ['xlsx', 'xlsx', 'Excel 可以直接開，帶公式與格式'],
           ['PDF', 'pdf', '排版成橫向 A4，表頭會在每一頁重複']].forEach(function (spec) {
            var b = el('button', 'fbtn', spec[0]);
            b.type = 'button';
            b.title = spec[2];
            b.addEventListener('click', function () { close(); exportAs(spec[1]); });
            row.appendChild(b);
          });
          p.appendChild(row);
        });
      });

      /* ------------------------------------------------------------- files */

      function grid() {
        var maxC = 0;
        var maxR = 0;
        Object.keys(cells).forEach(function (ref) {
          var p = F.parseRef(ref);
          if (!p) return;
          maxC = Math.max(maxC, p.col);
          maxR = Math.max(maxR, p.row);
        });
        var rows = [];
        for (var r = 0; r <= maxR; r++) {
          var row = [];
          for (var c = 0; c <= maxC; c++) {
            var v = computed.values[F.makeRef(c, r)];
            row.push(v === undefined ? '' : fmt(v));
          }
          rows.push(row);
        }
        return rows;
      }

      async function save() {
        if (!path) {
          path = '/notes/' + sheetName + '.aiossheet';
        }
        return writeTo(path);
      }

      /**
       * Save a copy somewhere else, then follow it. The extension picks the
       * format, so naming the copy .xlsx is also how you export one.
       */
      async function saveAs(target) {
        var to = target || await AIOS.saveAsPath({
          host: ctx.win.el,
          current: path,
          defaultName: sheetName + '.aiossheet',
          formats: '.aiossheet（不失真）、.xlsx、.csv'
        });
        if (!to) return '取消';
        var written = await writeTo(to);
        path = written;
        /* The sheet keeps its name. Renaming it after the file was reasonable when
           a document was one sheet; in a workbook it silently orphans every
           cross-sheet formula that named it -- `=工作表1!B4` still says 工作表1
           while no sheet does, so it quietly reads as blank. */
        ctx.setTitle('試算表 — ' + written.split('/').pop());
        ctx.save();
        return written;
      }

      /** The one writer both paths go through, so the format rules stay in step. */
      async function writeTo(target) {
        if (/\.csv$/i.test(target)) return exportAs('csv', target);
        if (/\.xlsx$/i.test(target)) return exportAs('xlsx', target);
        if (/\.pdf$/i.test(target)) return exportAs('pdf', target);

        stash();
        var payload = {
          /* Version 5 adds the merged regions, per sheet. An older build reading
             this file ignores them and shows an unmerged grid with the same
             values, which is a degraded view rather than a wrong one. */
          kind: 'aiossheet', version: 5,
          font: sheetFont, size: sheetSize,
          active: active,
          sheets: book,
          /* The version 3 fields, still written so an older build can open the
             file and show the sheet that was in front of you rather than refusing
             it. A reader that understands `sheets` ignores these. */
          sheetName: sheetName,
          cols: COLS, rows: ROWS, cells: cells,
          colWidths: colWidths, rowHeights: rowHeights, freeze: freeze,
          /* Written here as well as inside `sheets`, because these flat fields are
             a complete description of the active sheet and the single-sheet reader
             looks for merges among them. Two descriptions of one sheet that
             disagree is the bug this avoids. */
          merges: merges
        };
        /* Only claim a version when saving over the file this window opened; a
           save-as names a file this workbook holds no version of. */
        var res = await ctx.saveDoc(target, target === path ? pathMtime : null,
          function (expect) {
            return A.fs.write(target, JSON.stringify(payload, null, 2), expect);
          });
        if (res && res.canceled) { ctx.toast(res.error, 't-warn'); return path; }
        if (!res.ok) { ctx.toast('儲存失敗：' + res.error, 't-err'); throw new Error(res.error); }
        pathMtime = res.data.mtime;
        dirty = false;
        render();
        await AIOS.afterFsChange();
        ctx.toast('已儲存 ' + target, 't-ok');
        return target;
      }

      async function exportAs(format, explicitTarget) {
        var f = String(format || 'csv').toLowerCase();
        var base = (path || ('/notes/' + sheetName)).replace(/\.[^.]*$/, '');
        if (f === 'csv') {
          var conv = await A.office.convert('rows->csv', grid());
          if (!conv.ok) throw new Error(conv.error);
          var target = explicitTarget || (base + '.csv');
          var w = await A.fs.write(target, conv.data);
          if (!w.ok) throw new Error(w.error);
          await AIOS.afterFsChange();
          ctx.toast('已匯出 ' + target, 't-ok');
          return target;
        }
        if (f === 'pdf') {
          var target3 = explicitTarget || (base + '.pdf');
          /* The grid on screen, minus the parts that only make sense while
             editing: the row and column headers are navigation, and a spreadsheet
             printed with them looks like a screenshot rather than a table. */
          var table = ctx.body.querySelector('.sh-grid, table');
          if (!table) throw new Error('沒有內容可以匯出');

          var out = await AIOS.printing.toPdf(target3, {
            title: sheetName,
            font: sheetFont,
            size: sheetSize,
            // A grid is usually wider than tall.
            landscape: true,
            bodyHtml: '<h1>' + String(sheetName).replace(/[&<>]/g, '') + '</h1>' +
                      '<table>' + table.innerHTML + '</table>',
            css: [
              '.sh-colhead, .sh-rowhead, .sh-corner { display: none; }',
              'td { white-space: pre-wrap; }',
              // Selection and cursor styling from the editor.
              '.sh-sel, .sh-active { background: transparent !important; outline: none !important; }',
              'input { border: 0; background: transparent; font: inherit; color: inherit; padding: 0; }'
            ].join('\n')
          });
          await AIOS.afterFsChange();
          ctx.toast('已匯出 ' + out.vpath + '（' + Math.round(out.bytes / 1024) + ' KB）', 't-ok');
          if (out.warning) ctx.toast(out.warning, 't-warn');
          return out.vpath;
        }
        if (f === 'xlsx') {
          var target2 = explicitTarget || (base + '.xlsx');
          // Ship the computed value alongside each formula. A reader that
          // recalculates will overwrite it, and one that does not shows the
          // number instead of a blank cell.
          /* Every sheet, with each formula's computed value alongside it. The
             values come from one workbook-wide pass so a cross-sheet formula
             exports the number it actually shows. */
          var bookOut = F.recalcBook(bookCells());
          var sheetsOut = book.map(function (s) {
            var withValues = {};
            var vals = bookOut.values[s.name] || {};
            Object.keys(s.cells).forEach(function (ref) {
              var c = s.cells[ref];
              // Formatting rides along with the value, so a styled formula cell
              // exports as both a formula and a styled cell.
              withValues[ref] = c.f
                ? Object.assign({}, c, { f: c.f, v: vals[ref] })
                : c;
            });
            return {
              name: s.name, cells: withValues,
              colWidths: s.colWidths, rowHeights: s.rowHeights, freeze: s.freeze,
              merges: s.merges || []
            };
          });
          var res = await A.office.writeXlsx(target2, sheetName, sheetsOut[active].cells,
            { font: sheetFont, size: sheetSize, sheets: sheetsOut });
          if (!res.ok) throw new Error(res.error);
          await AIOS.afterFsChange();
          ctx.toast('已匯出 ' + target2 + '（公式一併寫入）', 't-ok');
          return target2;
        }
        throw new Error('不支援的格式：' + format);
      }

      async function open(vpath) {
        if (!vpath) return;
        /* Whichever branch loads it, remember which version was loaded: that is
           what a later save claims to be replacing. Every reader reports it, so
           no format is left without the guard. */
        var stamp = null;
        if (/\.aiossheet$/i.test(vpath)) {
          var r = await A.fs.read(vpath);
          if (!r.ok) { ctx.toast('開啟失敗：' + r.error, 't-err'); return; }
          stamp = r.data.mtime;
          try {
            var d = JSON.parse(r.data.content);
            // Version 1 files have no font; keep the current defaults for them.
            if (d.font) sheetFont = d.font;
            if (d.size) sheetSize = d.size;

            if (Array.isArray(d.sheets) && d.sheets.length) {
              book = d.sheets.map(function (s, i) {
                return {
                  name: s.name || ('工作表' + (i + 1)),
                  cells: s.cells || {},
                  cols: Math.max(26, Math.min(200, s.cols || 26)),
                  rows: Math.max(60, Math.min(2000, s.rows || 60)),
                  colWidths: s.colWidths || {},
                  rowHeights: s.rowHeights || {},
                  freeze: { rows: (s.freeze || {}).rows || 0, cols: (s.freeze || {}).cols || 0 },
                  // Absent before version 5, and sanitised whatever the version:
                  // an overlapping pair in a hand-edited file cannot be rendered.
                  merges: normMerges(s.merges)
                };
              });
              active = Math.max(0, Math.min(book.length - 1, d.active || 0));
            } else {
              /* Everything before version 4 is one sheet. Reading it as a
                 workbook of one keeps a single code path downstream, rather than
                 a "does this file have sheets" question at every use. */
              book = [{
                name: d.sheetName || '工作表1',
                cells: d.cells || {},
                cols: Math.max(26, Math.min(200, d.cols || 26)),
                rows: Math.max(60, Math.min(2000, d.rows || 60)),
                // Version 2 files have no geometry; an absent map is "all default".
                colWidths: d.colWidths || {},
                rowHeights: d.rowHeights || {},
                freeze: { rows: (d.freeze || {}).rows || 0, cols: (d.freeze || {}).cols || 0 },
                merges: normMerges(d.merges)
              }];
              active = 0;
            }
            var live = book[active];
            sheetName = live.name;
            cells = live.cells;
            COLS = live.cols;
            ROWS = live.rows;
            colWidths = live.colWidths;
            rowHeights = live.rowHeights;
            freeze = live.freeze;
            merges = live.merges;
          } catch (e) { ctx.toast('檔案格式不對：' + e.message, 't-err'); return; }
        } else if (/\.csv$/i.test(vpath)) {
          var rc = await A.fs.read(vpath);
          if (!rc.ok) { ctx.toast('開啟失敗：' + rc.error, 't-err'); return; }
          stamp = rc.data.mtime;
          var conv = await A.office.convert('csv->rows', rc.data.content);
          if (!conv.ok) { ctx.toast('解析失敗：' + conv.error, 't-err'); return; }
          cells = {};
          conv.data.forEach(function (row, ri) {
            row.forEach(function (val, ci) {
              if (val === '') return;
              var ref = F.makeRef(ci, ri);
              cells[ref] = isNaN(Number(val)) || val.trim() === '' ? { v: val } : { v: Number(val) };
            });
          });
          sheetName = vpath.split('/').pop().replace(/\.csv$/i, '');
          // A CSV carries no geometry, so anything left from the last file would
          // be applied to columns that mean something else now. Merges likewise:
          // a region from the previous file would cover unrelated data here.
          colWidths = {};
          rowHeights = {};
          freeze = { rows: 0, cols: 0 };
          merges = [];
          book = [blankSheet(sheetName)];
          active = 0;
          stash();
        } else if (/\.xlsx$/i.test(vpath)) {
          var rx = await A.office.readXlsx(vpath);
          if (!rx.ok) { ctx.toast('開啟失敗：' + rx.error, 't-err'); return; }
          stamp = rx.data.mtime;
          var incoming = rx.data.sheets && rx.data.sheets.length
            ? rx.data.sheets
            : [{ name: rx.data.sheet || '工作表1', cells: rx.data.cells || {},
                 cols: rx.data.cols, rows: rx.data.rows }];
          book = incoming.map(function (s, i) {
            return {
              name: s.name || ('工作表' + (i + 1)),
              cells: s.cells || {},
              cols: Math.max(26, Math.min(200, s.cols || 26)),
              rows: Math.max(60, Math.min(2000, s.rows || 60)),
              colWidths: s.colWidths || {},
              rowHeights: s.rowHeights || {},
              freeze: { rows: (s.freeze || {}).rows || 0, cols: (s.freeze || {}).cols || 0 },
              merges: normMerges(s.merges)
            };
          });
          active = 0;
          var first = book[0];
          sheetName = first.name;
          cells = first.cells;
          COLS = first.cols;
          ROWS = first.rows;
          colWidths = first.colWidths;
          rowHeights = first.rowHeights;
          freeze = first.freeze;
          merges = first.merges;
        } else {
          ctx.toast('試算表打不開 ' + vpath, 't-warn');
          return;
        }

        path = vpath;
        pathMtime = stamp;
        dirty = false;
        sel = 'A1';
        anchor = 'A1';
        undoStack.length = 0;
        redoStack.length = 0;
        recalc();
        ctx.setTitle('試算表 — ' + vpath.split('/').pop());
      }

      /* ------------------------------------------------------------ wiring */

      function publish() {
        var rows = grid();
        if (!rows.length) { ctx.publish(null); return; }
        ctx.publish('試算表 ' + (path || sheetName) + '：\n' +
          rows.slice(0, 30).map(function (r, i) { return '  ' + (i + 1) + ': ' + r.join(' | '); }).join('\n'),
          'app/sheets');
      }

      ctx.describe(function () {
        var rows = grid();
        var lines = [];
        lines.push('檔案：' + (path || '（新試算表）') + (dirty ? '（未儲存）' : ''));
        stash();
        lines.push('工作表：' + book.map(function (s) {
          return s.name + (s.name === sheetName ? '（目前）' : '');
        }).join('、'));
        if (book.length > 1) {
          lines.push('跨表參照寫成 工作表名!A1，名稱有空白就加單引號：' + "'我的表'!A1");
        }
        lines.push('以下的內容與公式都是「' + sheetName + '」這張表的。');
        lines.push('選取範圍：' + selLabel() +
          '（作用中的格 ' + sel + '，內容：' + (raw(sel) || '空') + '）');
        if (undoStack.length) {
          lines.push('可以復原：' + undoStack[undoStack.length - 1].label);
        }
        lines.push('大小：' + rows.length + ' 列 x ' + (rows[0] ? rows[0].length : 0) + ' 欄');
        if (merges.length) {
          /* Said explicitly, because the value grid below shows a merged region as
             its top-left value followed by blanks, and a model reading that would
             otherwise conclude those cells are empty and available. */
          lines.push('合併的儲存格：' + merges.map(rectLabel).join('、') +
            '（每個區域只有左上角那一格有值，其他格對公式來說是空的）');
        }
        lines.push('目前值（每列一行，欄以 | 分隔，第一列是第 1 列）：');
        lines.push(rows.slice(0, 40).map(function (r, i) {
          return '  ' + (i + 1) + ': ' + r.join(' | ');
        }).join('\n') || '  （空）');
        var fs = Object.keys(cells).filter(function (k) { return cells[k].f; });
        if (fs.length) {
          lines.push('公式：');
          lines.push(fs.slice(0, 40).map(function (k) { return '  ' + k + ': ' + cells[k].f; }).join('\n'));
        }
        var errs = Object.keys(computed.errors);
        if (errs.length) {
          lines.push('錯誤：' + errs.map(function (k) { return k + '=' + computed.values[k]; }).join('、'));
        }
        var formatted = Object.keys(cells).filter(function (k) { return cells[k].numFmt; });
        if (formatted.length) {
          lines.push('數字格式：' + formatted.slice(0, 20).map(function (k) {
            return k + '=' + cells[k].numFmt;
          }).join('、') + (formatted.length > 20 ? ' …' : ''));
        }
        lines.push('日期是序號（1 = 1900-01-01），要看起來像日期就用 setStyle 給 numFmt，' +
          '例如 yyyy-mm-dd。可用格式碼：#,##0.00、0%、NT$#,##0、yyyy-mm-dd、hh:mm、@');
        lines.push('可用函式：' + F.functions.join(', '));
        return lines.join('\n');
      });

      ctx.saveKeys(save, saveAs);

      /* Right-click. On a cell the menu acts on that cell, so it selects it
         first -- acting on the previously selected cell instead would be the
         kind of surprise that costs someone their data. */
      ctx.setMenu(function (ev) {
        var td = ev.target.closest ? ev.target.closest('td[data-ref]') : null;
        if (td) {
          var ref = td.dataset.ref;
          // Right-clicking inside the selection keeps it; right-clicking outside
          // moves to that cell, because acting on cells the menu is not pointing
          // at is the kind of surprise that costs someone their data.
          if (selRefs().indexOf(ref) < 0) select(ref);
          var cell = cells[ref];
          var many = isMulti();
          var refs = selRefs();
          // display(), not fmt(ref): fmt takes a value, so passing the reference
          // put the text "B3" on the clipboard instead of what B3 shows.
          var shown = display(ref);
          return [
            { label: many ? selLabel() + '（' + selCount() + ' 格）' : ref, disabled: true },
            { label: '編輯 ' + ref, hint: 'Enter', run: function () { beginEdit(); } },
            { label: many ? '清空 ' + selLabel() : '清空 ' + ref, hint: 'Del',
              run: function () {
                mutate('清空 ' + selLabel(), function () {
                  refs.forEach(function (r) { writeCell(r, ''); });
                });
              } },
            { sep: true },
            { label: many ? '複製 ' + selLabel() : '複製', hint: 'Ctrl+C',
              run: function () { copySelection(false); } },
            { label: '剪下', hint: 'Ctrl+X', run: function () { copySelection(true); } },
            { label: '貼到 ' + ref, hint: 'Ctrl+V', run: function () { pasteAt(); } },
            !many && shown
              ? { label: '只複製顯示的值', run: function () { A.clipboard.write(String(shown)); ctx.toast('已複製 ' + shown); } }
              : null,
            !many && cell && cell.f
              ? { label: '複製公式', run: function () { A.clipboard.write(cell.f); ctx.toast('已複製 ' + cell.f); } }
              : null,
            { sep: true },
            { label: (cell && cell.bold) ? '取消粗體' : '粗體',
              run: function () { setFormat(refs, { bold: !(cell && cell.bold) }); } },
            { label: (cell && cell.italic) ? '取消斜體' : '斜體',
              run: function () { setFormat(refs, { italic: !(cell && cell.italic) }); } },
            (cell && (cell.font || cell.size))
              ? { label: many ? '清掉選取範圍的字型設定' :
                         '清掉這格的字型設定（' + (cell.font || sheetFont) +
                         ' ' + (cell.size || sheetSize) + 'pt）',
                  run: function () { setFormat(refs, { font: null, size: null }); } }
              : null,
            { label: '整張表：' + sheetFont + ' ' + sheetSize + 'pt', run: function () { btnSheetFont.click(); } },
            { sep: true },
            mergesIn(selRect()).length
              ? { label: '取消合併', run: function () {
                  try { ctx.toast(unmergeRect(selRect()), 't-ok'); }
                  catch (err) { ctx.toast(err.message, 't-warn'); }
                } }
              : null,
            many
              ? { label: '跨欄置中 ' + selLabel(), run: function () {
                  try { ctx.toast(mergeRect(selRect(), { centre: true }), 't-ok'); }
                  catch (err) { ctx.toast(err.message, 't-warn'); }
                } }
              : null,
            many
              ? { label: '合併儲存格（不改對齊）', run: function () {
                  try { ctx.toast(mergeRect(selRect(), {}), 't-ok'); }
                  catch (err) { ctx.toast(err.message, 't-warn'); }
                } }
              : null,
            many && selRect().r1 > selRect().r0
              ? { label: '每列各自合併', run: function () {
                  try { ctx.toast(mergeRect(selRect(), { across: true, centre: true }), 't-ok'); }
                  catch (err) { ctx.toast(err.message, 't-warn'); }
                } }
              : null,
            { sep: true },
            { label: '在上面插入 ' + selSpanRows().count + ' 列', run: function () {
              var s = selSpanRows();
              restructure({ kind: 'insertRow', at: s.at, count: s.count },
                '插入 ' + s.count + ' 列');
            } },
            { label: '刪除第 ' + (selSpanRows().at + 1) +
                     (selSpanRows().count > 1 ? '–' + (selSpanRows().at + selSpanRows().count) : '') + ' 列',
              danger: true, run: function () {
                var s = selSpanRows();
                restructure({ kind: 'deleteRow', at: s.at, count: s.count },
                  '刪除 ' + s.count + ' 列');
              } },
            { label: '在左邊插入 ' + selSpanCols().count + ' 欄', run: function () {
              var s = selSpanCols();
              restructure({ kind: 'insertCol', at: s.at, count: s.count },
                '插入 ' + s.count + ' 欄');
            } },
            { label: '刪除 ' + F.indexToCol(selSpanCols().at) +
                     (selSpanCols().count > 1 ? '–' + F.indexToCol(selSpanCols().at + selSpanCols().count - 1) : '') + ' 欄',
              danger: true, run: function () {
                var s = selSpanCols();
                restructure({ kind: 'deleteCol', at: s.at, count: s.count },
                  '刪除 ' + s.count + ' 欄');
              } },
            { sep: true },
            many
              ? { label: '依 ' + F.indexToCol(F.parseRef(sel).col) + ' 欄排序（遞增）',
                  run: function () { sortRange(F.parseRef(sel).col, false); } }
              : null,
            many
              ? { label: '依 ' + F.indexToCol(F.parseRef(sel).col) + ' 欄排序（遞減）',
                  run: function () { sortRange(F.parseRef(sel).col, true); } }
              : null,
            { sep: true },
            { label: '凍結到這一格（' + ref + ' 左上都固定）', run: function () {
              var p = F.parseRef(ref);
              setFreeze(p.row, p.col);
            } },
            (freeze.rows || freeze.cols)
              ? { label: '取消凍結（目前 ' + freeze.rows + ' 列 ' + freeze.cols + ' 欄）',
                  run: function () { setFreeze(0, 0); } }
              : { label: '凍結首列', run: function () { setFreeze(1, 0); } },
            { sep: true },
            { label: '復原', hint: 'Ctrl+Z', disabled: !undoStack.length, run: undo },
            { label: '重做', hint: 'Ctrl+Y', disabled: !redoStack.length, run: redo },
            { sep: true },
            { label: '儲存', hint: 'Ctrl+S', run: function () { save(); } },
            { label: '另存新檔…', hint: 'Ctrl+Shift+S', run: function () { saveAs(); } }
          ];
        }

        /* On a sheet tab the menu acts on that sheet. */
        var tab = ev.target.closest ? ev.target.closest('.sh-tab[data-sheet]') : null;
        if (tab) {
          var si = Number(tab.dataset.sheet);
          return [
            { label: book[si].name, disabled: true },
            { label: '切換到這張表', run: function () { activate(si); } },
            { label: '改名…', run: async function () {
              var name = await ctx.prompt({
                label: '工作表名稱', value: book[si].name,
                note: '改名之後，所有指向這張表的公式會跟著更新。',
                selectStem: false
              });
              if (name === null) return;
              try { renameSheet(si, name); recalc(); } catch (e) { ctx.toast(e.message, 't-err'); }
            } },
            { label: '複製這張表', run: function () {
              try { ctx.toast(duplicateSheet(si)); } catch (e) { ctx.toast(e.message, 't-err'); }
            } },
            { label: '刪除這張表', danger: true, disabled: book.length <= 1, run: function () {
              try { ctx.toast(removeSheet(si)); } catch (e) { ctx.toast(e.message, 't-err'); }
            } },
            { sep: true },
            { label: '新增工作表', run: function () {
              try { addSheet(); } catch (e) { ctx.toast(e.message, 't-err'); }
            } }
          ];
        }

        return [
          { label: '復原', hint: 'Ctrl+Z', disabled: !undoStack.length, run: undo },
          { label: '重做', hint: 'Ctrl+Y', disabled: !redoStack.length, run: redo },
          { sep: true },
          { label: '新增工作表', run: function () {
            try { addSheet(); } catch (e) { ctx.toast(e.message, 't-err'); }
          } },
          { sep: true },
          { label: '儲存', hint: 'Ctrl+S', run: function () { save(); } },
          { label: '另存新檔…', hint: 'Ctrl+Shift+S', run: function () { saveAs(); } },
          { sep: true },
          { label: '匯出 CSV', run: function () { exportAs('csv'); } },
          { label: '匯出 xlsx（含公式）', run: function () { exportAs('xlsx'); } },
          { label: '匯出 PDF（橫向）', run: function () { exportAs('pdf'); } },
          { sep: true },
          { label: '選取有內容的範圍', hint: 'Ctrl+A', run: function () { selectSpan('used'); } },
          { label: '多加 20 列', run: function () { ROWS = Math.min(2000, ROWS + 20); render(); } },
          { label: '多加 5 欄', run: function () { COLS = Math.min(200, COLS + 5); render(); } },
          { sep: true },
          { label: '開啟檔案…', run: function () { AIOS.apps.launch('files'); } }
        ];
      });

      ctx.api = {
        setCell: setCell, setRange: setRange, clearRange: clearRange,
        setFormat: setFormat, setFont: setFont, setStyle: setStyle,
        fontState: function () { return { font: sheetFont, size: sheetSize }; },
        save: save, saveAs: saveAs, exportAs: exportAs, open: open,
        select: select,
        selection: function () { return { active: sel, range: selLabel(), refs: selRefs() }; },
        undo: undo, redo: redo,
        copy: copySelection, paste: pasteAt,
        fillTo: fillTo,

        /* The structural operations, taking the coordinates a person would say:
           row 1 is row 1, and a column may be named. */
        insertRows: function (a) {
          var at = Math.max(1, Math.round(Number((a || {}).at) || 1)) - 1;
          var n = Math.max(1, Math.round(Number((a || {}).count) || 1));
          restructure({ kind: 'insertRow', at: at, count: n }, '插入 ' + n + ' 列');
          return '已在第 ' + (at + 1) + ' 列前插入 ' + n + ' 列，公式參照已改寫';
        },
        deleteRows: function (a) {
          var at = Math.max(1, Math.round(Number((a || {}).at) || 1)) - 1;
          var n = Math.max(1, Math.round(Number((a || {}).count) || 1));
          restructure({ kind: 'deleteRow', at: at, count: n }, '刪除 ' + n + ' 列');
          return '已刪除第 ' + (at + 1) + ' 列起的 ' + n + ' 列；指向被刪內容的公式變成 #REF!';
        },
        insertCols: function (a) {
          var at = colIndexOf((a || {}).at);
          var n = Math.max(1, Math.round(Number((a || {}).count) || 1));
          restructure({ kind: 'insertCol', at: at, count: n }, '插入 ' + n + ' 欄');
          return '已在 ' + F.indexToCol(at) + ' 欄前插入 ' + n + ' 欄，公式參照已改寫';
        },
        deleteCols: function (a) {
          var at = colIndexOf((a || {}).at);
          var n = Math.max(1, Math.round(Number((a || {}).count) || 1));
          restructure({ kind: 'deleteCol', at: at, count: n }, '刪除 ' + n + ' 欄');
          return '已刪除 ' + F.indexToCol(at) + ' 欄起的 ' + n + ' 欄';
        },
        sortRange: function (a) {
          var s = a || {};
          if (s.start) {
            var start = String(s.start).toUpperCase();
            var end = String(s.end || s.start).toUpperCase();
            if (!F.parseRef(start) || !F.parseRef(end)) throw new Error('範圍不合法');
            select(start);
            select(end, true);
          }
          var by = s.by === undefined || s.by === null || s.by === ''
            ? selRect().c0
            : colIndexOf(s.by);
          sortRange(by, !!s.descending);
          return '已排序 ' + selLabel() + '，依 ' + F.indexToCol(by) + ' 欄' +
            (s.descending ? '遞減' : '遞增');
        },
        freeze: function (a) { return setFreeze((a || {}).rows || 0, (a || {}).cols || 0); },

        mergeCells: function (a) {
          var s = a || {};
          return mergeRect(rectFromSpec(s, '合併範圍'), {
            // Centring is the point of 跨欄置中, so it is what you get unless
            // asked otherwise.
            centre: s.centre === undefined ? true : !!s.centre,
            across: !!s.across
          });
        },
        unmergeCells: function (a) { return unmergeRect(rectFromSpec(a, '範圍')); },
        merges: function () {
          stash();
          return merges.map(rectLabel);
        },

        /* Sheets, addressed by name because that is what a formula uses and what
           the model can see in the description. */
        addSheet: function (name) { return addSheet(name); },
        selectSheet: function (name) {
          var i = sheetIndexOf(name);
          if (i < 0) throw new Error('沒有這張工作表：' + name);
          activate(i);
          return '已切換到「' + book[i].name + '」';
        },
        renameSheet: function (a) {
          var s = a || {};
          var i = s.name === undefined || s.name === null || s.name === '' ? active : sheetIndexOf(s.name);
          if (i < 0) throw new Error('沒有這張工作表：' + s.name);
          var note = renameSheet(i, s.to);
          recalc();
          return note;
        },
        deleteSheet: function (name) {
          var i = name === undefined || name === null || name === '' ? active : sheetIndexOf(name);
          if (i < 0) throw new Error('沒有這張工作表：' + name);
          return removeSheet(i);
        },
        sheets: function () {
          stash();
          return { active: sheetName, names: book.map(function (s) { return s.name; }) };
        }
      };

      (async function boot() {
        var st = ctx.state;
        // One sheet to begin with, so `book` is never empty and nothing has to
        // handle the "no sheets yet" case.
        book = [blankSheet(sheetName)];
        active = 0;
        stash();

        if (st && (st.sheets || st.cells)) {
          path = st.path || null;
          // Not read this session, so no claim about the version on disk.
          pathMtime = null;
          dirty = !!st.dirty;
          if (Array.isArray(st.sheets) && st.sheets.length) {
            book = st.sheets;
            active = Math.max(0, Math.min(book.length - 1, st.active || 0));
          } else {
            // A session snapshot from before the workbook existed.
            book = [{
              name: st.sheetName || sheetName,
              cells: st.cells || {},
              cols: st.cols || 26,
              rows: st.rows || 60,
              colWidths: st.colWidths || {},
              rowHeights: st.rowHeights || {},
              freeze: { rows: (st.freeze || {}).rows || 0, cols: (st.freeze || {}).cols || 0 },
              merges: normMerges(st.merges)
            }];
            active = 0;
          }
          var live = book[active];
          sheetName = live.name;
          cells = live.cells;
          COLS = live.cols;
          ROWS = live.rows;
          colWidths = live.colWidths;
          rowHeights = live.rowHeights;
          freeze = live.freeze;
          // A session snapshot from before merges existed has none.
          merges = normMerges(live.merges);
          live.merges = merges;
          recalc();
          if (path) ctx.setTitle('試算表 — ' + path.split('/').pop());
        } else if (typeof ctx.arg === 'string') {
          await open(ctx.arg);
        } else {
          recalc();
        }
        wrap.focus();
      })();

      return {
        getState: function () {
          stash();
          return {
            sheets: book, active: active,
            path: path, dirty: dirty,
            // The pre-workbook fields, so an older build restoring this session
            // shows the sheet that was in front of you instead of an empty grid.
            cells: cells, sheetName: sheetName,
            cols: COLS, rows: ROWS,
            colWidths: colWidths, rowHeights: rowHeights, freeze: freeze,
            merges: merges
          };
        },
        reopen: function (p) { if (typeof p === 'string') open(p); },
        /* Read by the window before it closes. A spreadsheet is the one document
           here whose value is entirely in what was typed into it. */
        unsaved: function () { return dirty; },
        docName: function () { return path || sheetName; },
        save: save,
        onClose: function () { ctx.publish(null); }
      };
    }
  });
})();
