'use strict';

/* ===========================================================================
   AI-OS // Docs
   ---------------------------------------------------------------------------
   A block-structured word processor. The document is a list of typed blocks --
   heading, paragraph with formatted runs, list item, quote, table -- and the
   editor is a view onto that list, not a soup of contenteditable HTML.

   That structure is what makes the chat panel useful. "Rewrite the second
   paragraph" is a real instruction here, because paragraph two is an addressable
   object with an index. The model edits blocks by number, the document keeps a
   snapshot before each AI edit, and the change can be undone.

   Formats: .aiosdoc (JSON, lossless), .md and .docx.
   =========================================================================== */

/* global window, document, AIOS */

(function () {
  var A = window.aios;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var BLOCK_LABELS = {
    heading: '標題', para: '段落', list: '項目', quote: '引用', table: '表格', break: '分頁'
  };

  /* Blocks that hold no text of their own. Every command that reaches into a
     block's characters has to skip these, and naming the set once is cheaper
     than remembering to check for both in eight places. */
  function isTextBlock(b) {
    return !!b && b.type !== 'table' && b.type !== 'break';
  }

  /* Paragraph-level formatting. Kept apart from the run keys because these are
     properties of the whole block: half a paragraph cannot be centred. */
  var ALIGNS = [
    { id: '', label: '\u2261', title: '靠左（預設）' },
    { id: 'center', label: '\u2262', title: '置中' },
    { id: 'right', label: '\u2263', title: '靠右' },
    { id: 'justify', label: '\u2016', title: '左右對齊' }
  ];
  var LINE_HEIGHTS = [['', '預設'], ['1', '單行'], ['1.15', '1.15'], ['1.5', '1.5'], ['2', '兩倍']];
  var INDENT_PT = 24;                    // one level on screen; 720 twips in docx

  AIOS.apps.register({
    id: 'docs',
    name: '文件',
    contentApp: true,   // its chat panel gets the intent-enrichment guide
    icon: '\u25a7',
    kind: 'DOCS',
    width: 860,
    height: 600,
    purpose: '文書編輯，區塊結構，可存成 docx 或 Markdown',
    chatHint: '可以說「把第 2 段改寫得更正式」或「在最後加一個結論段」。每次 AI 編輯前會存快照。',

    accepts: function (p) { return /\.(aiosdoc|docx|md|markdown)$/i.test(p || ''); },

    actions: {
      setBlock: {
        args: '{index, text, type, level, rows, merges}',
        desc: '改寫第 index 個區塊（從 1 開始）。表格區塊可以給 rows（二維陣列）' +
              '與 merges（合併區域，[{c0,r0,c1,r1}]，0 起算含端點）',
        run: async function (args, ctx) {
          var i = Number(args.index) - 1;
          ctx.api.snapshot();
          ctx.api.setBlock(i, args);
          return { note: '已改寫第 ' + args.index + ' 個區塊' };
        }
      },
      insertBlock: {
        args: '{index, type:"heading"|"para"|"list"|"quote"|"table", text, level, rows}',
        desc: '在第 index 個位置插入區塊，index 省略就加在最後。' +
              'type 是 table 時給 rows（二維陣列），第一列是標題列',
        run: async function (args, ctx) {
          ctx.api.snapshot();
          var at = args.index === undefined ? null : Number(args.index) - 1;
          ctx.api.insertBlock(at, args);
          return { note: '已插入 ' + (BLOCK_LABELS[args.type] || '段落') };
        }
      },
      deleteBlock: {
        args: '{index}', desc: '刪掉第 index 個區塊',
        run: async function (args, ctx) {
          ctx.api.snapshot();
          ctx.api.deleteBlock(Number(args.index) - 1);
          return { note: '已刪除第 ' + args.index + ' 個區塊' };
        }
      },
      replaceAll: {
        args: '{markdown}', desc: '用 Markdown 重寫整份文件',
        run: async function (args, ctx) {
          ctx.api.snapshot();
          await ctx.api.fromMarkdown(String(args.markdown || ''));
          return { note: '整份文件已重寫' };
        }
      },
      save: { args: '{}', desc: '儲存', run: async function (_a, ctx) { return { note: await ctx.api.save() }; } },
      saveAs: {
        args: '{path}', desc: '另存新檔（不給 path 就問使用者；副檔名決定格式）',
        run: async function (a, ctx) { return { note: await ctx.api.saveAs(a.path || null) }; }
      },
      setFont: {
        args: '{font, size, scope:"document"|"block", index}',
        desc: '設定字型與字級。scope 省略或 document 就是整份文件；block 要給 index（從 1 開始）',
        run: async function (a, ctx) {
          return { note: ctx.api.setFont(a) };
        }
      },
      setPara: {
        args: '{index, align:"left"|"center"|"right"|"justify", indent, lineHeight, spaceBefore, spaceAfter}',
        desc: '設定第 index 個區塊的段落格式（縮排 0–8 級，段前段後是 pt，行距是倍數）。' +
              'index 省略就是每一個區塊',
        run: async function (a, ctx) { return { note: ctx.api.setPara(a) }; }
      },
      formatText: {
        args: '{index, find, bold, italic, under, strike, sup, sub, code, colour, mark, clear}',
        desc: '把第 index 個區塊裡的某段文字改成某種字元格式。給 find 就只套在那段字上，' +
              '省略就整個區塊；值給 true 是加上、false 是拿掉；clear:true 是清掉全部格式。' +
              'colour 與 mark 給顏色名或 hex',
        run: async function (a, ctx) { return { note: ctx.api.formatText(a) }; }
      },
      replaceText: {
        args: '{find, replace, caseSensitive}',
        desc: '整份文件的尋找取代（包含表格），每個字原本的格式會保留',
        run: async function (a, ctx) {
          // replaceAll takes its own snapshot, and drops it again when nothing
          // matched -- so an unsuccessful replace does not cost an undo step.
          var n = ctx.api.replaceAll(String(a.find || ''), String(a.replace == null ? '' : a.replace),
            !!a.caseSensitive);
          return { note: n ? '取代了 ' + n + ' 處' : '沒有找到「' + a.find + '」' };
        }
      },
      setLayout: {
        args: '{header, footer, pageNumbers}',
        desc: '設定頁首、頁尾與頁碼（匯出 PDF 與 docx 時會逐頁重複）',
        run: async function (a, ctx) { return { note: ctx.api.setLayout(a) }; }
      },
      setTableStyle: {
        args: '{index, c0, r0, c1, r1, border, borderStyle, borderWidth, borderColour, fill}',
        desc: '設定第 index 個表格區塊的框線與網底。範圍用 0 起算的 c0/r0/c1/r1，' +
              '省略就是整張表格。border 是 all/box/inside/insideH/insideV/top/bottom/left/right/none；' +
              'borderStyle 是 single/double/dashed/dotted/dashDot；borderWidth 是 pt；' +
              'fill 與 borderColour 給顏色名或 hex',
        run: async function (a, ctx) {
          ctx.api.snapshot();
          return { note: ctx.api.setTableStyle(a) };
        }
      },
      exportAs: {
        args: '{format:"md"|"docx"|"pdf"}', desc: '匯出成 Markdown、docx 或 PDF',
        run: async function (args, ctx) { return { note: await ctx.api.exportAs(args.format) }; }
      }
    },

    mount: function (ctx) {
      ctx.body.classList.add('flush');

      var blocks = [];
      var path = null;
      /* The mtime of `path` as this window last saw it. A save hands it back so
         the sandbox can refuse to replace a different version -- another window,
         the kernel, an import. Null means no claim: a new document, or one whose
         version we cannot know. */
      var pathMtime = null;
      var title = '未命名文件';
      var dirty = false;
      var focusIndex = -1;
      var undoStack = [];

      /* Document defaults. A run or a block may override them; anything that
         does not is rendered and exported with these, which is what makes
         "change the font of the whole document" one action instead of N. */
      var docFont = '微軟正黑體';
      var docSize = 11;

      /* Page furniture. Properties of the document rather than of any block, so
         they live here and are written into the docx section rather than into the
         body. `docPageNum` puts the page number in the footer, which is the one
         thing a footer is used for often enough to deserve a checkbox. */
      var docHeader = '';
      var docFooter = '';
      var docPageNum = false;

      /* The last thing 尋找 was asked for, so 找下一個 continues instead of
         starting over, and reopening the panel remembers what you typed. */
      var findState = { needle: '', repl: '', caseSensitive: false, at: -1 };

      /* ---------------------------------------------------------- chrome */

      var bar = el('div', 'dc-bar');
      var nameTag = el('span', 'dc-name', title);
      var styleSel = el('select', 'dc-style');
      styleSel.setAttribute('aria-label', '區塊樣式');
      [['para', '正文'], ['heading1', '標題 1'], ['heading2', '標題 2'], ['heading3', '標題 3'],
       ['list', '項目符號'], ['listOrdered', '編號清單'], ['quote', '引用']].forEach(function (o) {
        var opt = el('option', null, o[1]);
        opt.value = o[0];
        styleSel.appendChild(opt);
      });
      var fontSel = el('select', 'dc-font');
      fontSel.setAttribute('aria-label', '字型');
      fontSel.title = '有選取範圍就套用在選取的字上，沒有就套用整個區塊';
      AIOS.fonts.fillSelect(fontSel, { inheritLabel: '字型：預設' });

      var sizeSel = el('select', 'dc-size');
      sizeSel.setAttribute('aria-label', '字級');
      sizeSel.title = '字級（pt）。有選取範圍就只套用在選取的字上';
      AIOS.fonts.fillSizeSelect(sizeSel, { inheritLabel: 'pt' });

      /**
       * A toolbar button that acts on the text.
       *
       * `mousedown` is cancelled on every one of them. Without that, pressing the
       * button moves focus out of the paragraph and collapses the selection, so
       * the command that follows has nothing to act on -- the button appears to
       * do nothing on the first click and works on the second. Cancelling the
       * default keeps the caret exactly where the user left it.
       */
      function fbtn(label, title, onClick) {
        var b = el('button', 'fbtn', label);
        b.type = 'button';
        if (title) b.title = title;
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        if (onClick) b.addEventListener('click', onClick);
        return b;
      }

      var btnBold = fbtn('B', '粗體 (Ctrl+B)', function () { toggleFormat('bold'); });
      var btnItalic = fbtn('I', '斜體 (Ctrl+I)', function () { toggleFormat('italic'); });
      var btnUnder = fbtn('U', '底線 (Ctrl+U)', function () { toggleFormat('under'); });
      var btnStrike = fbtn('S', '刪除線', function () { toggleFormat('strike'); });
      btnStrike.style.textDecoration = 'line-through';
      btnUnder.style.textDecoration = 'underline';
      var btnRunMore = fbtn('\u25b8 字元', '上下標、行內程式碼、文字色、螢光、清除格式');
      var btnPara = fbtn('\u25b8 段落', '對齊、縮排、行距、段距');
      /* On the toolbar as well as in the table's own menu. The menu is where a
         hand goes after clicking a cell, but a toolbar is where people look for a
         control they have not found yet -- and Word puts these on the ribbon. */
      var btnBorder = fbtn('\u229e 框線', '框線與網底（游標要在表格裡）');

      var bar2 = el('div', 'dc-bar dc-bar2');
      var btnInsert = fbtn('\u25a6 插入', '表格、分頁');
      var btnFind = fbtn('\u2315 尋找', '尋找與取代 (Ctrl+F)');
      var btnLayout = fbtn('\u25a4 版面', '整份字型、頁首、頁尾、頁碼');
      var btnUndo = fbtn('\u21b6', '復原上一步 (Ctrl+Z)');
      var btnSave = fbtn('儲存', '儲存 (Ctrl+S)');
      var btnSaveAs = fbtn('另存',
        '另存新檔 (Ctrl+Shift+S)。副檔名決定格式：.aiosdoc / .docx / .md / .pdf');
      var btnExport = fbtn('\u2913 匯出', 'Markdown、docx、PDF');

      [nameTag, styleSel, fontSel, sizeSel, btnBold, btnItalic, btnUnder, btnStrike,
       btnRunMore, btnPara, btnBorder].forEach(function (n) { bar.appendChild(n); });
      [btnInsert, btnFind, btnLayout, btnUndo, btnSave, btnSaveAs, btnExport]
        .forEach(function (n) { bar2.appendChild(n); });
      ctx.body.appendChild(bar);
      ctx.body.appendChild(bar2);

      /** Show which formats the caret is sitting in. */
      function syncMarks() {
        var t = formatTarget();
        var st = t ? inlineStateOf(t) : {};
        [[btnBold, 'bold'], [btnItalic, 'italic'], [btnUnder, 'under'], [btnStrike, 'strike']]
          .forEach(function (pair) {
            pair[0].classList.toggle('on', !!st[pair[1]]);
            pair[0].setAttribute('aria-pressed', st[pair[1]] ? 'true' : 'false');
          });
        var b = blocks[focusIndex];
        btnPara.classList.toggle('on', !!(b && (b.align || b.indent || b.lineHeight ||
          b.spaceBefore || b.spaceAfter)));
        /* Greyed out away from a table, rather than offered and then refused. A
           border command needs a cell to act on, and there is no honest thing for
           it to do in a paragraph. */
        btnBorder.disabled = !(b && b.type === 'table');
        btnBorder.title = btnBorder.disabled
          ? '框線與網底（游標要在表格裡）'
          : '框線與網底：' + AIOS.borders.describe(
              AIOS.grid.table.styleAt(b, (cellSel && cellSel.block === focusIndex ? cellSel.c0 : 0),
                                      (cellSel && cellSel.block === focusIndex ? cellSel.r0 : 0)).border);

        /* Move the current-block marker in place. It used to be set only while
           rendering, so the highlighted block number stayed on whichever block was
           current the last time something changed -- clicking into another
           paragraph did not move it. Re-rendering to fix that would cost the caret. */
        [].forEach.call(page.querySelectorAll('.dc-block.on'), function (n) {
          n.classList.remove('on');
        });
        var row = blockRow(focusIndex);
        if (row) row.classList.add('on');
      }

      var page = el('div', 'dc-page');
      page.setAttribute('role', 'document');
      ctx.body.appendChild(page);

      var status = el('div', 'dc-status');
      ctx.body.appendChild(status);

      /* -------------------------------------------------------- rendering */

      /* --------------------------------------------------------- tables ---

         A table block is { type: 'table', rows: [[text, ...], ...], merges: [] }.
         The row and column arithmetic and the merge algebra are AIOS.grid's,
         shared with the spreadsheet and the deck's table object -- the same
         rectangles mean the same thing in all three, and a row deleted here does
         to a merge exactly what it does there.
      */

      /** Which cells the next table command acts on, and in which block. */
      var cellSel = null;

      function normTable(b) {
        AIOS.grid.table.square(b);
        if (!b.rows.length) b.rows = [['', ''], ['', '']];
        var n = AIOS.grid.table.size(b);
        b.merges = AIOS.grid.norm(b.merges, { rows: n.rows, cols: n.cols, limit: 60 });
        /* Per-cell borders and shading, cleaned against the table's real size: a
           file or a chat action can name a cell the table does not have. Dropped
           when empty so an untouched table carries no field. */
        var styles = AIOS.borders.normCellStyles(b.cellStyles, { rows: n.rows, cols: n.cols });
        if (styles) b.cellStyles = styles;
        else delete b.cellStyles;
        return b;
      }

      function setCellSel(i, c, r) {
        cellSel = { block: i, c0: c, c1: c, r0: r, r1: r };
        paintCellSel();
      }

      /**
       * Adopt a rectangle the picker measured from its own anchor.
       *
       * The anchor is the picker's, not this range's first corner: once a range
       * has grown over a merged region its corner is no longer where the finger
       * went down, so measuring from it means a drag cannot shrink again.
       */
      function takeCellRect(i, rect) {
        var b = blocks[i];
        // Never half a merged region, for the same reason a spreadsheet's
        // selection is never half of one.
        var grown = AIOS.grid.grow((b && b.merges) || [], rect);
        cellSel = { block: i, c0: grown.c0, c1: grown.c1, r0: grown.r0, r1: grown.r1 };
        focusIndex = i;
        paintCellSel();
        syncMarks();
      }

      /** Repaint the marks in place; a rebuild would drop the caret. */
      function paintCellSel() {
        [].forEach.call(page.querySelectorAll('.ui-cellsel'), function (n) {
          n.classList.remove('ui-cellsel');
        });
        if (!cellSel) return;
        if (cellSel.c0 === cellSel.c1 && cellSel.r0 === cellSel.r1) return;
        // By block number: the page also holds the running-head strips, so its
        // child list stopped agreeing with the block indices.
        var host = blockRow(cellSel.block);
        if (!host) return;
        [].forEach.call(host.querySelectorAll('[data-r]'), function (td) {
          var c = Number(td.dataset.c);
          var r = Number(td.dataset.r);
          if (c >= cellSel.c0 && c <= cellSel.c1 && r >= cellSel.r0 && r <= cellSel.r1) {
            td.classList.add('ui-cellsel');
          }
        });
      }

      /**
       * A table block as DOM.
       *
       * A covered cell produces no node -- that is what colSpan means, and it is
       * why the docx writer and the PDF export need to know nothing about which
       * cells are hidden.
       */
      function tableNode(b, i) {
        normTable(b);
        var t = el('table', 'dc-table');
        var mm = AIOS.grid.map(b.merges);

        b.rows.forEach(function (cells, ri) {
          var tr = el('tr');
          cells.forEach(function (cell, ci) {
            if (mm.coveredBy[AIOS.grid.key(ci, ri)]) return;
            var td = el(ri === 0 ? 'th' : 'td', null, cell);
            var span = mm.masterAt[AIOS.grid.key(ci, ri)];
            if (span) {
              if (span.c1 > span.c0) td.colSpan = span.c1 - span.c0 + 1;
              if (span.r1 > span.r0) td.rowSpan = span.r1 - span.r0 + 1;
            }
            /* The cell's own shading and borders. Inline, because these travel
               into the PDF export, which serialises the rendered node. */
            var cst = AIOS.grid.table.styleAt(b, ci, ri);
            if (cst.bg) {
              td.style.background = '#' + cst.bg;
              td.style.color = AIOS.palette.readableOn(cst.bg);
            }
            if (cst.border) AIOS.borders.paint(td, cst.border);
            td.dataset.r = String(ri);
            td.dataset.c = String(ci);
            td.contentEditable = 'true';
            td.spellcheck = false;
            td.title = '拖過相鄰的格子可以選一個範圍，選了範圍才能合併或畫框線';
            /* Written back by the coordinates this node was built with. It used to
               be `cells.indexOf(cell)`, which finds the *first* cell holding that
               text -- so typing into the second empty cell of a row wrote into the
               first one, and the row lost a value it looked like it still had. */
            td.addEventListener('input', function () {
              noteTyping();
              b.rows[ri][ci] = td.textContent;
              markDirty();
            });
            // syncMarks as well, so the toolbar's 框線 button knows it is live now
            // rather than at the next render.
            td.addEventListener('focus', function () { focusIndex = i; syncMarks(); });
            tr.appendChild(td);
          });
          t.appendChild(tr);
        });

        /* Press and drag across cells to select a range; a plain click still puts
           the caret in. Attached to the table rather than to each cell, so it also
           works while the pointer is over a cell the drag never started in. */
        AIOS.cellPicker(t, {
          onSelect: function (rect) { takeCellRect(i, rect); }
        });
        return t;
      }

      /** Every table command: one undo step, one redraw, one report. */
      function tableOp(b, label, fn) {
        try {
          snapshot();
          normTable(b);
          fn(AIOS.grid.table, b);
          normTable(b);
          if (cellSel) {
            var n = AIOS.grid.table.size(b);
            cellSel.c1 = Math.min(cellSel.c1, n.cols - 1);
            cellSel.r1 = Math.min(cellSel.r1, n.rows - 1);
            cellSel.c0 = Math.min(cellSel.c0, cellSel.c1);
            cellSel.r0 = Math.min(cellSel.r0, cellSel.r1);
          }
          markDirty();
          render();
          paintCellSel();
          if (label) ctx.toast(label, 't-ok');
        } catch (e) {
          undo();
          ctx.toast(e.message, 't-warn');
        }
      }

      /**
       * The table half of the right-click menu.
       *
       * The same set the deck's table object offers, worded the same way. A
       * document's table and a slide's table are the same object to a person, so
       * the two menus disagreeing about what they are called would be a puzzle
       * with no answer.
       */
      function tableMenu(b, i, ev) {
        normTable(b);
        var T = AIOS.grid.table;
        var cellEl = ev.target.closest ? ev.target.closest('[data-r]') : null;
        var at = cellEl
          ? { c: Number(cellEl.dataset.c), r: Number(cellEl.dataset.r) }
          : { c: 0, r: 0 };
        // Right-clicking outside the marked range moves to that cell, so the menu
        // and what it acts on agree.
        if (cellEl && (!cellSel || cellSel.block !== i ||
            at.c < cellSel.c0 || at.c > cellSel.c1 || at.r < cellSel.r0 || at.r > cellSel.r1)) {
          setCellSel(i, at.c, at.r);
        }
        var range = cellSel && cellSel.block === i
          ? cellSel
          : { c0: at.c, c1: at.c, r0: at.r, r1: at.r };
        var n = T.size(b);
        var wide = range.c0 !== range.c1 || range.r0 !== range.r1;
        var hit = AIOS.grid.within(b.merges, range);

        return [
          { label: '表格 ' + n.cols + ' 欄 × ' + n.rows + ' 列　·　' +
                   (wide ? '已選 ' + AIOS.grid.label(range)
                         : '第 ' + (at.r + 1) + ' 列第 ' + (at.c + 1) + ' 欄'), disabled: true },
          { label: '在上面插入一列', run: function () {
            tableOp(b, '已插入一列', function (t) { t.insertRow(b, range.r0); });
          } },
          { label: '在下面插入一列', run: function () {
            tableOp(b, '已插入一列', function (t) { t.insertRow(b, range.r1 + 1); });
          } },
          { label: '刪除' + (range.r0 === range.r1 ? '第 ' + (range.r0 + 1) + ' 列'
                                                   : '第 ' + (range.r0 + 1) + '–' + (range.r1 + 1) + ' 列'),
            danger: true, disabled: n.rows <= 1, run: function () {
              tableOp(b, '已刪除', function (t) {
                for (var k = range.r1; k >= range.r0; k--) t.deleteRow(b, k);
              });
            } },
          { sep: true },
          { label: '在左邊插入一欄', run: function () {
            tableOp(b, '已插入一欄', function (t) { t.insertCol(b, range.c0); });
          } },
          { label: '在右邊插入一欄', run: function () {
            tableOp(b, '已插入一欄', function (t) { t.insertCol(b, range.c1 + 1); });
          } },
          { label: '刪除' + (range.c0 === range.c1 ? '第 ' + (range.c0 + 1) + ' 欄'
                                                   : '第 ' + (range.c0 + 1) + '–' + (range.c1 + 1) + ' 欄'),
            danger: true, disabled: n.cols <= 1, run: function () {
              tableOp(b, '已刪除', function (t) {
                for (var k = range.c1; k >= range.c0; k--) t.deleteCol(b, k);
              });
            } },
          { sep: true },
          { label: '框線與網底…　' +
                   AIOS.borders.describe(AIOS.grid.table.styleAt(b, range.c0, range.r0).border),
            run: function () { borderPopover(b, i, range); } },
          { sep: true },
          hit.length
            ? { label: '取消合併', run: function () {
                tableOp(b, '已取消合併', function (t) { t.unmerge(b, range); });
              } }
            : null,
          { label: wide ? '跨欄置中 ' + AIOS.grid.label(range) : '跨欄置中（先按住 Shift 點另一格）',
            disabled: !wide, run: function () {
              var lost = 0;
              tableOp(b, null, function (t) { lost = t.merge(b, range); });
              ctx.toast('已合併 ' + AIOS.grid.label(range) +
                (lost ? '，捨棄 ' + lost + ' 格內容（可以復原）' : ''), lost ? 't-warn' : 't-ok');
            } },
          { sep: true }
        ].filter(Boolean);
      }

      function textOf(b) {
        if (b.type === 'break') return '';
        if (b.type === 'table') return (b.rows || []).map(function (r) { return r.join('\t'); }).join('\n');
        if (Array.isArray(b.runs) && b.runs.length) return b.runs.map(function (r) { return r.text; }).join('');
        return b.text || '';
      }

      /** How a block's paragraph settings read out loud, for the menu and describe. */
      function paraSummary(b) {
        var bits = [];
        if (b.align) {
          bits.push({ center: '置中', right: '靠右', justify: '左右對齊' }[b.align] || b.align);
        }
        if (b.indent) bits.push('縮排 ' + b.indent + ' 級');
        if (b.lineHeight) bits.push('行距 ' + b.lineHeight);
        if (b.spaceBefore) bits.push('段前 ' + b.spaceBefore + 'pt');
        if (b.spaceAfter) bits.push('段後 ' + b.spaceAfter + 'pt');
        return bits.join('、');
      }

      /** Which run formats appear anywhere in a block, named. */
      function runSummary(b) {
        var names = {
          bold: '粗體', italic: '斜體', under: '底線', strike: '刪除線',
          sup: '上標', sub: '下標', code: '程式碼', colour: '文字色', mark: '螢光'
        };
        var seen = {};
        (b.runs || []).forEach(function (r) {
          Object.keys(names).forEach(function (k) { if (r[k]) seen[k] = true; });
        });
        return Object.keys(seen).map(function (k) { return names[k]; }).join('、');
      }

      /* ===================================================== run formatting

         Formatting is applied by splitting the block's run list at character
         offsets, not by asking the browser to do it. document.execCommand is
         the usual route and it is the wrong one here: it invents its own markup
         (<font face>, nested spans, sometimes styles on the block itself),
         which then has to be reverse-engineered on read-back. Splitting runs
         ourselves means the model in memory is always the truth and the DOM is
         only a projection of it.
         ==================================================================== */

      /* Everything a run may carry. Order matters only for readability; what
         matters is that this is the single list -- writeRuns, sameFormat, the
         DOM read-back, the docx writer and find/replace all work from it, so
         adding a format here is one edit rather than six. */
      var RUN_KEYS = ['bold', 'italic', 'under', 'strike', 'sup', 'sub', 'code',
                      'colour', 'mark', 'font', 'size'];

      /* The subset that is on or off, which is what a toolbar button toggles.
         `colour` and `mark` hold a value, `font` and `size` belong to the block
         as much as to the run, so neither is a toggle. */
      var TOGGLE_KEYS = ['bold', 'italic', 'under', 'strike', 'sup', 'sub', 'code'];

      /* Tag names the read-back reads as a format. Written as a map from tag to
         key so pasted markup is understood too: a paste from a browser arrives
         as <b>/<i>/<strike>, not as the tags this app writes. */
      var TAG_FORMAT = {
        b: 'bold', strong: 'bold',
        i: 'italic', em: 'italic',
        u: 'under', ins: 'under',
        s: 'strike', strike: 'strike', del: 'strike',
        sup: 'sup', sub: 'sub',
        code: 'code', kbd: 'code', samp: 'code', tt: 'code'
      };

      function runsOf(b) {
        if (Array.isArray(b.runs) && b.runs.length) {
          return b.runs.map(function (r) { return Object.assign({}, r); });
        }
        return [{ text: b.text || '' }];
      }

      function sameFormat(a, b) {
        return RUN_KEYS.every(function (k) {
          return (a[k] || null) === (b[k] || null);
        });
      }

      /** Drop empty runs and fuse neighbours that now look identical. */
      function normaliseRuns(runs) {
        var out = [];
        runs.forEach(function (r) {
          if (!r.text) return;
          var prev = out[out.length - 1];
          if (prev && sameFormat(prev, r)) prev.text += r.text;
          else out.push(r);
        });
        return out;
      }

      function writeRuns(b, runs) {
        var clean = normaliseRuns(runs);
        b.text = clean.map(function (r) { return r.text; }).join('');
        var plain = clean.length <= 1 && RUN_KEYS.every(function (k) {
          return !clean.length || !clean[0][k];
        });
        if (plain) delete b.runs;
        else b.runs = clean;
      }

      /**
       * Character offsets of the current selection inside `node`, or null when
       * the selection is not in this node. A collapsed selection returns a zero
       * width range, which callers read as "no selection, act on the block".
       */
      function selectionOffsets(node) {
        var sel = window.getSelection();
        if (!sel || !sel.rangeCount) return null;
        var range = sel.getRangeAt(0);
        if (!node.contains(range.startContainer) || !node.contains(range.endContainer)) return null;

        var pos = 0;
        var start = null;
        var end = null;
        (function walk(n) {
          for (var i = 0; i < n.childNodes.length; i++) {
            var child = n.childNodes[i];
            if (child.nodeType === 3) {
              if (child === range.startContainer) start = pos + range.startOffset;
              if (child === range.endContainer) end = pos + range.endOffset;
              pos += child.nodeValue.length;
            } else if (child.nodeType === 1) {
              if (child === range.startContainer) start = pos;
              if (child === range.endContainer) end = pos;
              walk(child);
            }
          }
        })(node);

        if (start === null || end === null) return null;
        return { start: Math.min(start, end), end: Math.max(start, end) };
      }

      /** Apply `patch` to [start, end). A null value in the patch clears a key. */
      function applyRunFormat(b, start, end, patch) {
        var runs = runsOf(b);
        var out = [];
        var pos = 0;

        runs.forEach(function (r) {
          var from = pos;
          var to = pos + r.text.length;
          pos = to;
          if (to <= start || from >= end) { out.push(r); return; }

          var head = r.text.slice(0, Math.max(0, start - from));
          var mid = r.text.slice(Math.max(0, start - from), Math.min(r.text.length, end - from));
          var tail = r.text.slice(Math.min(r.text.length, end - from));

          if (head) out.push(Object.assign({}, r, { text: head }));
          if (mid) {
            var m = Object.assign({}, r, { text: mid });
            Object.keys(patch).forEach(function (k) {
              if (patch[k] === null || patch[k] === '') delete m[k];
              else m[k] = patch[k];
            });
            out.push(m);
          }
          if (tail) out.push(Object.assign({}, r, { text: tail }));
        });

        writeRuns(b, out);
      }

      /** Apply `patch` to every run in the block, and to the block itself. */
      function applyBlockFormat(b, patch) {
        Object.keys(patch).forEach(function (k) {
          if (patch[k] === null || patch[k] === '') delete b[k];
          else b[k] = patch[k];
        });
        if (Array.isArray(b.runs)) {
          // Block-level formatting is the fallback for runs that do not state
          // their own, so clearing the key on the runs is what lets the block's
          // value show through.
          b.runs.forEach(function (r) {
            Object.keys(patch).forEach(function (k) { delete r[k]; });
          });
          writeRuns(b, b.runs);
        }
      }

      /**
       * Programmatic font change, for the chat panel. Deliberately does not
       * touch the selection: the model has no view of where the caret is, so
       * "set the font" from a conversation means the document or a numbered
       * block, never "whatever happens to be highlighted".
       */
      function setFont(spec) {
        var s = spec || {};
        var font = s.font ? String(s.font).slice(0, 64) : null;
        var size = Number(s.size);
        if (!Number.isFinite(size) || size <= 0) size = null;
        if (!font && !size) throw new Error('要給 font 或 size');

        snapshot();
        if (s.scope === 'block') {
          var i = Number(s.index) - 1;
          if (!blocks[i]) throw new Error('沒有第 ' + s.index + ' 個區塊');
          var patch = {};
          if (font) patch.font = font;
          if (size) patch.size = size;
          applyBlockFormat(blocks[i], patch);
          markDirty();
          render();
          return '第 ' + s.index + ' 個區塊改成 ' +
            (font || '（不變）') + ' ' + (size ? size + 'pt' : '');
        }

        if (font) docFont = font;
        if (size) docSize = Math.max(4, Math.min(200, size));
        markDirty();
        render();
        return '整份文件改成 ' + docFont + ' ' + docSize + 'pt';
      }

      /**
       * Put the caret back over the same characters.
       *
       * Every formatting command re-renders, which throws away the DOM the
       * selection was anchored in. Without this the caret jumps to the end of the
       * paragraph after every click on B, so bolding three words in a row means
       * re-selecting them three times -- the command works and the feature does
       * not.
       */
      function setSelectionOffsets(node, start, end) {
        var range = document.createRange();
        var pos = 0;
        var gotStart = false;
        var gotEnd = false;
        (function walk(n) {
          for (var i = 0; i < n.childNodes.length; i++) {
            var c = n.childNodes[i];
            if (c.nodeType === 3) {
              var len = c.nodeValue.length;
              if (!gotStart && start <= pos + len) {
                range.setStart(c, Math.max(0, start - pos));
                gotStart = true;
              }
              if (gotStart && !gotEnd && end <= pos + len) {
                range.setEnd(c, Math.max(0, end - pos));
                gotEnd = true;
              }
              pos += len;
            } else if (c.nodeType === 1) {
              walk(c);
            }
          }
        })(node);

        node.focus();
        if (!gotStart) { range.selectNodeContents(node); range.collapse(false); }
        else if (!gotEnd) { range.setEnd(range.startContainer, range.startContainer.nodeValue.length); }
        var s = window.getSelection();
        s.removeAllRanges();
        s.addRange(range);
      }

      /**
       * The editable element for block `i`.
       *
       * By its block number, not by position in a node list. `querySelectorAll`
       * over the page returns a list whose indices stop matching the block
       * indices as soon as a table exists: `[contenteditable]` also matches every
       * one of its cells, and `.dc-block > [contenteditable]` matches no element
       * at all for the table itself. Either way a document with a table in it
       * formatted and focused the wrong paragraph.
       */
      function blockRow(i) {
        return page.querySelector('.dc-block[data-bi="' + i + '"]');
      }

      function editableFor(i) {
        var row = blockRow(i);
        return row ? row.querySelector(':scope > [contenteditable]') : null;
      }

      function textLen(b) {
        return runsOf(b).reduce(function (n, r) { return n + r.text.length; }, 0);
      }

      /** What a formatting command should act on right now, or null. */
      function formatTarget() {
        var b = blocks[focusIndex];
        if (!isTextBlock(b)) return null;
        var node = editableFor(focusIndex);
        var range = node ? selectionOffsets(node) : null;
        return {
          b: b, i: focusIndex, node: node,
          range: range && range.end > range.start ? range : null
        };
      }

      /**
       * Which on/off formats hold across the target.
       *
       * A key counts as on only when every run in range has it. Reporting "on"
       * for a partly bold selection would make the button's next click clear the
       * bold it can see, which is the opposite of what the pressed state promised.
       */
      /* A format chosen with the caret in an empty paragraph.
         There is nothing to apply it to yet, so it is held until the first
         character arrives. Without this, pressing B on an empty line does
         nothing at all -- which is one of the most ordinary gestures there is.
         Only one application is needed: once the text is inside <strong>, the
         browser keeps putting the next characters in there too. */
      var pendingFormat = null;              // { block, patch }

      function inlineStateOf(t) {
        var runs = runsOf(t.b);
        var slice = [];
        if (t.range) {
          var pos = 0;
          runs.forEach(function (r) {
            var from = pos;
            var to = pos + r.text.length;
            pos = to;
            if (to <= t.range.start || from >= t.range.end) return;
            slice.push(r);
          });
        } else {
          slice = runs.filter(function (r) { return r.text.length; });
        }
        var out = {};
        TOGGLE_KEYS.forEach(function (k) {
          out[k] = slice.length > 0 && slice.every(function (r) { return !!r[k]; });
        });
        // A format waiting for its first character counts as on, or the button
        // would light up and go out again with nothing to show for it.
        if (pendingFormat && pendingFormat.block === t.i && !t.range) {
          Object.keys(pendingFormat.patch).forEach(function (k) {
            if (TOGGLE_KEYS.indexOf(k) >= 0) out[k] = !!pendingFormat.patch[k];
          });
        }
        return out;
      }

      /**
       * A run-level change: the selection, or the whole paragraph when there is
       * none.
       *
       * Bold with no selection means "bold this paragraph", and it is stored as a
       * run over the whole text rather than as a property of the block. Both would
       * work; one of them would need a second implementation in the renderer, the
       * docx writer and the Markdown writer, and the two would eventually
       * disagree about a paragraph that is half bold.
       */
      function applyRun(patch) {
        var t = formatTarget();
        if (!t) { ctx.toast('先把游標放進一段文字', 't-warn'); return; }

        if (!t.range && textLen(t.b) === 0) {
          var held = pendingFormat && pendingFormat.block === t.i ? pendingFormat.patch : {};
          pendingFormat = { block: t.i, patch: Object.assign({}, held, patch) };
          syncMarks();
          return;
        }

        snapshot();
        if (t.range) applyRunFormat(t.b, t.range.start, t.range.end, patch);
        else applyRunFormat(t.b, 0, textLen(t.b), patch);
        after(t);
      }

      /** A typeface change: the selection, or the block's own default. */
      function applyFont(patch) {
        var t = formatTarget();
        if (!t) { ctx.toast('先把游標放進一段文字', 't-warn'); return; }
        snapshot();
        if (t.range) applyRunFormat(t.b, t.range.start, t.range.end, patch);
        else applyBlockFormat(t.b, patch);
        after(t);
      }

      /** Redraw, then put the user back where they were. */
      function after(t) {
        markDirty();
        render();
        var node = editableFor(t.i);
        if (node && t.range) setSelectionOffsets(node, t.range.start, t.range.end);
        else focusBlock(t.i);
        syncFontSel();
        syncMarks();
      }

      /** Turn one on/off format on or off, reading the current state first. */
      function toggleFormat(key) {
        var t = formatTarget();
        if (!t) { ctx.toast('先把游標放進一段文字', 't-warn'); return; }
        var on = inlineStateOf(t)[key];
        var patch = {};
        patch[key] = on ? null : true;
        // Superscript and subscript are one axis; setting either clears the other.
        if (key === 'sup' && !on) patch.sub = null;
        if (key === 'sub' && !on) patch.sup = null;
        applyRun(patch);
      }

      /** Strip every run format from the selection, or from the whole paragraph. */
      function clearRunFormat() {
        var patch = {};
        RUN_KEYS.forEach(function (k) { patch[k] = null; });
        applyRun(patch);
      }

      /**
       * A paragraph-level change: alignment, indent, spacing, line height.
       *
       * Always the whole block, never the selection, because that is what these
       * properties are. A table takes them too -- a centred table is a real
       * request -- so this one does not go through formatTarget.
       */
      function applyPara(patch) {
        var b = blocks[focusIndex];
        if (!b) { ctx.toast('先選一個區塊', 't-warn'); return; }
        snapshot();
        Object.keys(patch).forEach(function (k) {
          if (patch[k] === null || patch[k] === '' || patch[k] === 0) delete b[k];
          else b[k] = patch[k];
        });
        markDirty();
        render();
        focusBlock(focusIndex);
        syncMarks();
      }

      /**
       * Put a run's typeface on an element. The family name is kept in a data
       * attribute as well as in the style: reading it back from the computed
       * CSS would return the whole fallback stack, and guessing which entry was
       * the chosen one is how the wrong name ends up in the exported file.
       */
      function applyFontStyle(node, spec) {
        if (spec.font) {
          node.dataset.font = spec.font;
          node.style.fontFamily = AIOS.fonts.cssFor(spec.font);
        }
        if (spec.size) {
          node.dataset.size = String(spec.size);
          node.style.fontSize = spec.size + 'pt';
        }
        /* Colours travel the same way as the typeface: in a data attribute as
           well as in the style. Reading them back from the style would mean
           parsing whatever form the browser chose to serialise rgb() in, and
           matching that against the palette's hex. */
        if (spec.colour) {
          node.dataset.colour = spec.colour;
          node.style.color = '#' + spec.colour;
        }
        if (spec.mark) {
          node.dataset.mark = spec.mark;
          node.style.backgroundColor = '#' + spec.mark;
          // A highlight is only legible if the text on it is chosen for it.
          if (!spec.colour) node.style.color = '#' + AIOS.palette.readableOn(spec.mark);
        }
      }

      /* Which element carries which run key. Nesting order is fixed so the same
         run always produces the same markup -- the read-back is order
         independent, but a stable shape makes a diff of two saved files
         readable. */
      var RUN_TAGS = [['code', 'code'], ['italic', 'em'], ['bold', 'strong'],
                      ['under', 'u'], ['strike', 's'], ['sup', 'sup'], ['sub', 'sub']];

      function runNode(r) {
        var inner = document.createTextNode(r.text);
        RUN_TAGS.forEach(function (pair) {
          if (!r[pair[0]]) return;
          // Superscript wins over subscript: they are one axis, and a run that
          // somehow claims both would otherwise be drawn as neither.
          if (pair[0] === 'sub' && r.sup) return;
          var n = el(pair[1], pair[0] === 'code' ? 'dc-code' : null);
          n.appendChild(inner);
          inner = n;
        });
        if (r.font || r.size || r.colour || r.mark) {
          var span = el('span', 'dc-run');
          applyFontStyle(span, r);
          span.appendChild(inner);
          inner = span;
        }
        return inner;
      }

      /** Paragraph geometry, as inline styles so a block's own value wins. */
      function applyParaStyle(node, b) {
        if (b.align) node.style.textAlign = b.align;
        if (b.indent) node.style.marginInlineStart = (b.indent * INDENT_PT) + 'px';
        if (b.spaceBefore) node.style.marginTop = b.spaceBefore + 'pt';
        if (b.spaceAfter) node.style.marginBottom = b.spaceAfter + 'pt';
        if (b.lineHeight) node.style.lineHeight = String(b.lineHeight);
      }

      function render() {
        page.innerHTML = '';
        if (!blocks.length) {
          blocks.push({ type: 'para', text: '' });
        }
        // The document default lives on the page, so every block inherits it
        // and only overrides need markup of their own.
        page.style.fontFamily = AIOS.fonts.cssFor(docFont);
        page.style.fontSize = docSize + 'pt';

        /* The running head, shown because a setting nobody can see is a setting
           people set twice. Not editable here: it belongs to the document, not to
           a position in it, and it is edited from the 版面 panel. */
        if (docHeader) page.appendChild(el('div', 'dc-hf', docHeader));

        blocks.forEach(function (b, i) {
          var row = el('div', 'dc-block' + (focusIndex === i ? ' on' : ''));
          // The block's number, so every lookup is by index instead of by
          // position in a node list. See editableFor().
          row.dataset.bi = String(i);
          row.appendChild(el('span', 'dc-num', String(i + 1)));

          if (b.type === 'table') {
            var tnode = tableNode(b, i);
            applyParaStyle(tnode, b);
            row.appendChild(tnode);
          } else if (b.type === 'break') {
            /* A page break has no text, so it is a marker rather than a field.
               It still occupies a numbered block, because that is how it is
               selected, moved and deleted like everything else. */
            var mark = el('div', 'dc-break', '分頁');
            mark.setAttribute('role', 'separator');
            mark.setAttribute('aria-label', '分頁 ' + (i + 1));
            mark.tabIndex = 0;
            mark.addEventListener('focus', function () { focusIndex = i; syncStyleSel(); syncMarks(); });
            row.appendChild(mark);
          } else {
            var tag = b.type === 'heading' ? ('h' + Math.min(6, b.level || 1))
                    : b.type === 'quote' ? 'blockquote'
                    : b.type === 'list' ? 'li'
                    : 'p';
            var node = el(tag, 'dc-' + b.type + (b.ordered ? ' ordered' : ''));
            node.contentEditable = 'true';
            node.spellcheck = false;
            node.setAttribute('role', 'textbox');
            node.setAttribute('aria-label', (BLOCK_LABELS[b.type] || '段落') + ' ' + (i + 1));

            // The block's own typeface, which its runs inherit unless they say
            // otherwise. Set on the element rather than baked into each run so
            // the cascade does the inheriting.
            applyFontStyle(node, b);
            applyParaStyle(node, b);

            // Runs are rendered as inline markup so formatting survives a
            // round trip through the DOM.
            if (Array.isArray(b.runs) && b.runs.length) {
              b.runs.forEach(function (r) { node.appendChild(runNode(r)); });
            } else {
              node.textContent = b.text || '';
            }

            node.addEventListener('focus', function () {
              // A format waiting for text belongs to the paragraph it was chosen
              // in; leaving without typing abandons it.
              if (pendingFormat && pendingFormat.block !== i) pendingFormat = null;
              focusIndex = i; syncStyleSel(); syncFontSel(); syncMarks();
            });
            // Moving the caret changes what the pickers should be showing.
            node.addEventListener('keyup', function () { syncFontSel(); syncMarks(); });
            node.addEventListener('mouseup', function () { syncFontSel(); syncMarks(); });
            node.addEventListener('input', function () { readBack(i, node); });
            node.addEventListener('keydown', function (e) { blockKeys(e, i, node); });
            row.appendChild(node);
          }

          page.appendChild(row);
        });

        if (docFooter || docPageNum) {
          page.appendChild(el('div', 'dc-hf',
            (docFooter || '') + (docPageNum ? (docFooter ? '　·　' : '') + '第 N 頁' : '')));
        }

        nameTag.textContent = title + (dirty ? ' \u25cf' : '');
        btnUndo.disabled = !undoStack.length;
        var words = blocks.reduce(function (n, b) { return n + textOf(b).replace(/\s+/g, '').length; }, 0);
        var breaks = blocks.filter(function (b) { return b.type === 'break'; }).length;
        status.textContent = (path || '（未儲存的新文件）') +
          '　·　' + blocks.length + ' 個區塊　·　' + words + ' 字' +
          (breaks ? '　·　' + breaks + ' 個分頁' : '') +
          (undoStack.length ? '　·　可復原 ' + undoStack.length + ' 步' : '');
        syncMarks();
        publish();
      }

      /** Pull the DOM back into the block model, preserving every run key. */
      function readBack(i, node) {
        noteTyping();
        var b = blocks[i];
        var runs = [];
        (function walk(n, fmt) {
          for (var k = 0; k < n.childNodes.length; k++) {
            var child = n.childNodes[k];
            if (child.nodeType === 3) {
              if (child.nodeValue) {
                var r = { text: child.nodeValue };
                RUN_KEYS.forEach(function (key) { if (fmt[key]) r[key] = fmt[key]; });
                runs.push(r);
              }
            } else if (child.nodeType === 1) {
              var next = Object.assign({}, fmt);
              var key = TAG_FORMAT[child.tagName.toLowerCase()];
              if (key) next[key] = true;
              /* Read the data attributes, never the computed style: the style
                 holds the whole font fallback stack, and rgb() for a colour that
                 was chosen as hex. */
              if (child.dataset.font) next.font = child.dataset.font;
              if (Number(child.dataset.size)) next.size = Number(child.dataset.size);
              if (child.dataset.colour) next.colour = child.dataset.colour;
              if (child.dataset.mark) next.mark = child.dataset.mark;
              walk(child, next);
            }
          }
        })(node, {});

        // The block's own font is on the element, so it must not be duplicated
        // onto every run when reading back.
        var blockFmt = { font: b.font || null, size: b.size || null };
        runs.forEach(function (r) {
          if (blockFmt.font && r.font === blockFmt.font) delete r.font;
          if (blockFmt.size && r.size === blockFmt.size) delete r.size;
        });

        writeRuns(b, runs);

        /* The format that was chosen while this paragraph was still empty. The
           text that just arrived is all of it, so the whole block is the range. */
        if (pendingFormat && pendingFormat.block === i) {
          var len = textLen(b);
          if (len > 0) {
            var patch = pendingFormat.patch;
            pendingFormat = null;
            applyRunFormat(b, 0, len, patch);
            markDirty();
            // The markup has to exist before the caret can go back inside it.
            render();
            var live = editableFor(i);
            if (live) setSelectionOffsets(live, len, len);
            return;
          }
        }
        markDirty();
      }

      function blockKeys(e, i, node) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          var from = blocks[i];
          var type = from.type === 'list' ? 'list' : 'para';
          var next = { type: type, ordered: from.ordered, text: '' };
          /* The new paragraph inherits the shape of the one it came from. Typing
             Enter after centring a line and getting a left-aligned one back means
             setting the alignment again on every line. */
          ['align', 'indent', 'lineHeight', 'spaceBefore', 'spaceAfter', 'font', 'size']
            .forEach(function (k) { if (from[k]) next[k] = from[k]; });
          snapshot();
          blocks.splice(i + 1, 0, next);
          markDirty();
          render();
          focusBlock(i + 1);
        } else if (e.key === 'Backspace' && node.textContent === '' && blocks.length > 1) {
          e.preventDefault();
          snapshot();
          blocks.splice(i, 1);
          markDirty();
          render();
          focusBlock(Math.max(0, i - 1));
        } else if ((e.ctrlKey || e.metaKey) && 'biu'.indexOf(e.key.toLowerCase()) >= 0) {
          /* Through the model, the same as the toolbar button. These used to call
             execCommand and then read the DOM back, which worked but meant two
             implementations of "make this bold" -- and the toolbar's copy did not
             read back at all, so the bold you could see was never saved. */
          e.preventDefault();
          toggleFormat({ b: 'bold', i: 'italic', u: 'under' }[e.key.toLowerCase()]);
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          findPopover();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          undo();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          save();
        } else if (e.key === 'ArrowDown' && i < blocks.length - 1) {
          /* Offsets within the whole block, not within the anchor text node: a
             paragraph with any formatting in it has several text nodes, and
             anchorOffset is measured inside whichever one the caret is in -- so
             the caret at the end of a bold word looked like the end of the
             paragraph. */
          var at = selectionOffsets(node);
          if (at && at.end >= textLen(blocks[i])) { e.preventDefault(); focusBlock(i + 1); }
        } else if (e.key === 'ArrowUp' && i > 0) {
          var at2 = selectionOffsets(node);
          if (at2 && at2.start === 0) { e.preventDefault(); focusBlock(i - 1); }
        }
      }

      function focusBlock(i) {
        var node = editableFor(i);
        if (!node) {
          // A page break has no editable text; focus the marker so the block is
          // still the one the toolbar and the menu act on.
          var row = blockRow(i);
          var mark = row && row.querySelector('.dc-break');
          if (mark) mark.focus();
          return;
        }
        node.focus();
        var r = document.createRange();
        r.selectNodeContents(node);
        r.collapse(false);
        var s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      }

      /**
       * Show what the cursor is actually sitting in. When a selection spans
       * runs with different fonts the picker goes blank rather than naming one
       * of them, because naming one would make the next click silently
       * overwrite the others.
       */
      function syncFontSel() {
        var b = blocks[focusIndex];
        if (!isTextBlock(b)) { fontSel.value = ''; sizeSel.value = ''; return; }

        var node = editableFor(focusIndex);
        var range = node ? selectionOffsets(node) : null;
        var runs = runsOf(b);
        var fonts = [];
        var sizes = [];

        if (range && range.end > range.start) {
          var pos = 0;
          runs.forEach(function (r) {
            var from = pos;
            var to = pos + r.text.length;
            pos = to;
            if (to <= range.start || from >= range.end) return;
            fonts.push(r.font || b.font || '');
            sizes.push(r.size || b.size || '');
          });
        } else {
          fonts.push(b.font || '');
          sizes.push(b.size || '');
        }

        var oneFont = fonts.length && fonts.every(function (f) { return f === fonts[0]; });
        var oneSize = sizes.length && sizes.every(function (s) { return s === sizes[0]; });
        fontSel.value = oneFont ? fonts[0] : '';
        sizeSel.value = oneSize && sizes[0] ? String(sizes[0]) : '';
      }

      function syncStyleSel() {
        var b = blocks[focusIndex];
        if (!isTextBlock(b)) return;
        styleSel.value = b.type === 'heading' ? 'heading' + (b.level || 1)
          : b.type === 'list' ? (b.ordered ? 'listOrdered' : 'list')
          : b.type === 'quote' ? 'quote' : 'para';
      }

      function markDirty() {
        dirty = true;
        nameTag.textContent = title + ' \u25cf';
        ctx.save();
        publish();
      }

      /* ------------------------------------------------------ block edits */

      /**
       * One step back, for everything a step can change.
       *
       * The whole document, not only the block list: the page furniture and the
       * default typeface are changed by the same buttons and go through the same
       * snapshot, so restoring blocks alone would undo half of a change and leave
       * the other half in place.
       */
      function snapshot() {
        undoStack.push(JSON.stringify({
          blocks: blocks, font: docFont, size: docSize,
          header: docHeader, footer: docFooter, pageNum: docPageNum
        }));
        if (undoStack.length > 60) undoStack.shift();
        // Any deliberate step ends the current typing burst, so the next
        // keystroke starts a new one.
        typingAt = 0;
      }

      /**
       * A burst of typing is one step.
       *
       * Without this, Ctrl+Z inside a paragraph reached past everything that had
       * been typed since the last button press -- the browser's own undo stack is
       * discarded on every re-render, so the only history is this one, and it has
       * to include typing to be worth reaching for.
       */
      var typingAt = 0;
      function noteTyping() {
        var now = Date.now();
        if (now - typingAt > 900) snapshot();
        typingAt = now;
      }

      function undo() {
        if (!undoStack.length) return;
        var st = JSON.parse(undoStack.pop());
        blocks = st.blocks;
        docFont = st.font;
        docSize = st.size;
        docHeader = st.header || '';
        docFooter = st.footer || '';
        docPageNum = !!st.pageNum;
        // A cell range from before the step may name a block or a column that no
        // longer exists, and a format held for an empty paragraph no longer has
        // one to wait for.
        cellSel = null;
        pendingFormat = null;
        if (focusIndex >= blocks.length) focusIndex = blocks.length - 1;
        markDirty();
        render();
      }

      function setBlock(i, spec) {
        if (i < 0 || i >= blocks.length) throw new Error('沒有第 ' + (i + 1) + ' 個區塊（共 ' + blocks.length + ' 個）');
        var b = blocks[i];
        if (spec.type) b.type = spec.type;
        if (spec.level) b.level = Number(spec.level);
        if (spec.text !== undefined) {
          b.text = String(spec.text);
          delete b.runs;
        }
        /* A table is rows and merged regions rather than text, and both are
           normalised on the way in: a region naming a column the table does not
           have cannot be drawn. */
        if (Array.isArray(spec.rows)) {
          b.rows = spec.rows.map(function (r) {
            return (Array.isArray(r) ? r : [r]).map(function (c) {
              return c == null ? '' : String(c);
            });
          });
        }
        if (spec.merges !== undefined) b.merges = spec.merges;
        if (spec.cellStyles !== undefined) b.cellStyles = spec.cellStyles;
        applyParaSpec(b, spec);
        if (b.type === 'table') normTable(b);
        markDirty();
        render();
      }

      /* Paragraph properties, cleaned. Shared by insertBlock and setBlock so a
         value the chat panel invents is checked in exactly one place. */
      var PARA_NUM = { indent: [0, 8], spaceBefore: [0, 96], spaceAfter: [0, 96], lineHeight: [0.5, 4] };

      function applyParaSpec(b, spec) {
        if (spec.align !== undefined) {
          var a = String(spec.align || '').toLowerCase();
          if (a === 'left' || !a) delete b.align;
          else if (a === 'center' || a === 'centre') b.align = 'center';
          else if (a === 'right') b.align = 'right';
          else if (a === 'justify') b.align = 'justify';
          else throw new Error('對齊只能是 left / center / right / justify');
        }
        Object.keys(PARA_NUM).forEach(function (k) {
          if (spec[k] === undefined) return;
          var n = Number(spec[k]);
          if (!Number.isFinite(n) || n <= 0) { delete b[k]; return; }
          b[k] = Math.max(PARA_NUM[k][0], Math.min(PARA_NUM[k][1], n));
        });
      }

      function insertBlock(at, spec) {
        var b = {
          type: spec.type || 'para',
          text: String(spec.text || ''),
          level: spec.level ? Number(spec.level) : undefined,
          ordered: !!spec.ordered
        };
        applyParaSpec(b, spec);
        /* A page break holds nothing. Carrying an empty `text` would make it look
           like an empty paragraph to every reader of the block list, including the
           model's. */
        if (b.type === 'break') {
          delete b.text;
          delete b.level;
          delete b.ordered;
        }
        /* A table is rows, not text. Built here rather than patched on afterwards
           by the caller, so the block is complete the moment it exists and the
           chat panel gets the same table the toolbar button does. */
        if (b.type === 'table') {
          b.rows = Array.isArray(spec.rows) && spec.rows.length
            ? spec.rows.map(function (r) {
              return (Array.isArray(r) ? r : [r]).map(function (c) {
                return c == null ? '' : String(c);
              });
            })
            : [['標題 A', '標題 B'], ['', ''], ['', '']];
          b.merges = [];
          delete b.text;
          normTable(b);
        }
        if (at === null || at === undefined || at > blocks.length) blocks.push(b);
        else blocks.splice(Math.max(0, at), 0, b);
        markDirty();
        render();
      }

      function deleteBlock(i) {
        if (i < 0 || i >= blocks.length) throw new Error('沒有第 ' + (i + 1) + ' 個區塊');
        blocks.splice(i, 1);
        if (!blocks.length) blocks.push({ type: 'para', text: '' });
        markDirty();
        render();
      }

      /* ---------------------------------------------------------- formats */

      async function toMarkdown() {
        var res = await A.office.convert('blocks->md', blocks);
        return res.ok ? res.data : '';
      }

      async function fromMarkdown(md) {
        var res = await A.office.convert('md->blocks', md);
        if (!res.ok) throw new Error(res.error);
        blocks = res.data.length ? res.data : [{ type: 'para', text: '' }];
        markDirty();
        render();
      }

      async function save() {
        if (!path) path = '/notes/' + title + '.aiosdoc';
        return writeTo(path);
      }

      /**
       * Save a copy somewhere else, then follow it. The extension decides the
       * format, so this is also how you convert: give it a .docx name and the
       * copy is a Word file.
       */
      async function saveAs(target) {
        var to = target || await AIOS.saveAsPath({
          host: ctx.win.el,
          current: path,
          defaultName: title + '.aiosdoc',
          formats: '.aiosdoc（不失真）、.docx、.md'
        });
        if (!to) return '取消';
        var written = await writeTo(to);
        path = written;
        title = written.split('/').pop().replace(/\.[^.]*$/, '');
        ctx.setTitle('文件 — ' + title);
        ctx.save();
        return written;
      }

      /** The one writer both paths go through, so the format rules cannot drift. */
      async function writeTo(target) {
        /* Saving to a lossy format still counts as saving. It used to not: the
           export ran, `dirty` stayed true, and a document whose name ended in
           .docx could never be marked saved -- so Ctrl+S looked like it did
           nothing, and closing the window asked about unsaved changes forever. */
        if (/\.(md|markdown|docx|pdf)$/i.test(target)) {
          var f = /\.docx$/i.test(target) ? 'docx' : /\.pdf$/i.test(target) ? 'pdf' : 'md';
          var written = await exportAs(f, target);
          dirty = false;
          render();
          return written;
        }

        var payload = {
          kind: 'aiosdoc', version: 4, title: title,
          font: docFont, size: docSize,
          header: docHeader, footer: docFooter, pageNumbers: docPageNum,
          blocks: blocks
        };
        /* Only claim a version when saving over the file this window opened. A
           save-as names a different file, which this document holds no version
           of, so there is nothing for it to be stale against. */
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
        var f = String(format || 'md').toLowerCase();
        var base = (path || ('/notes/' + title)).replace(/\.[^.]*$/, '');
        if (f === 'md' || f === 'markdown') {
          var md = await toMarkdown();
          var target = explicitTarget || (base + '.md');
          var w = await A.fs.write(target, md);
          if (!w.ok) throw new Error(w.error);
          await AIOS.afterFsChange();
          ctx.toast('已匯出 ' + target, 't-ok');
          return target;
        }
        if (f === 'docx') {
          var target2 = explicitTarget || (base + '.docx');
          var res = await A.office.writeDocx(target2, blocks, {
            font: docFont, size: docSize,
            header: docHeader, footer: docFooter, pageNumbers: docPageNum
          });
          if (!res.ok) throw new Error(res.error);
          await AIOS.afterFsChange();
          ctx.toast('已匯出 ' + target2 + '（Word 可直接開）', 't-ok');
          return target2;
        }
        if (f === 'pdf') {
          var target3 = explicitTarget || (base + '.pdf');
          /* The rendered page is the source, not the block model: the per-run font
             and size decisions are already applied to it as inline styles, so
             re-deriving them for print would be a second implementation of the
             same thing that could disagree with what is on screen. */
          var pageNode = ctx.body.querySelector('.dc-page');
          if (!pageNode) throw new Error('沒有內容可以匯出');

          var out = await AIOS.printing.toPdf(target3, {
            title: title,
            font: docFont,
            size: docSize,
            // Repeated on every page by the print engine, which is the only place
            // that knows where the page boundaries fell.
            header: docHeader,
            footer: docFooter,
            pageNumbers: docPageNum,
            bodyHtml: '<div class="doc">' + pageNode.innerHTML + '</div>',
            css: [
              // The editor's own affordances have no meaning on paper.
              '.doc [contenteditable] { }',
              '.doc { max-width: none; }',
              '.dc-run { font: inherit; }',
              '.dc-placeholder, .dc-caret { display: none; }',
              // The block numbers down the left are the editor's ruler.
              '.dc-num { display: none; }',
              '.dc-block { display: block; }',
              // The one-off preview of the running head belongs to the editor;
              // the printed pages get the real thing from the print engine.
              '.dc-hf { display: none; }',
              // A page break is a break, not a dashed line with a word on it.
              '.dc-break { break-after: page; page-break-after: always;',
              '  height: 0; margin: 0; border: 0; color: transparent;',
              '  font-size: 0; overflow: hidden; }',
              '.dc-code { font-family: Consolas, "Courier New", monospace;',
              '  background: #f4f6f9; padding: .1em .3em; border-radius: 3px; }'
            ].join('\n')
          });
          await AIOS.afterFsChange();
          ctx.toast('已匯出 ' + out.vpath + '（' + Math.round(out.bytes / 1024) + ' KB）', 't-ok');
          if (out.warning) ctx.toast(out.warning, 't-warn');
          return out.vpath;
        }
        throw new Error('不支援的格式：' + format);
      }

      async function open(vpath) {
        if (!vpath) return;
        /* Whichever branch loads it, remember which version was loaded: that is
           what a later save claims to be replacing. Every reader reports it, so
           no format is left without the guard. */
        var stamp = null;
        if (/\.aiosdoc$/i.test(vpath)) {
          var r = await A.fs.read(vpath);
          if (!r.ok) { ctx.toast('開啟失敗：' + r.error, 't-err'); return; }
          stamp = r.data.mtime;
          try {
            var d = JSON.parse(r.data.content);
            blocks = d.blocks || [];
            title = d.title || vpath.split('/').pop();
            // Version 1 files have no font, so keep the current defaults for
            // them rather than writing null into the model.
            if (d.font) docFont = d.font;
            if (d.size) docSize = d.size;
            /* Version 2 and earlier have no page furniture. Reset rather than
               inherit: whatever header the last document had has nothing to do
               with this one, and silently stamping it onto someone else's file is
               the kind of bug that only shows up in the printout. */
            docHeader = String(d.header || '');
            docFooter = String(d.footer || '');
            docPageNum = !!d.pageNumbers;
          } catch (e) { ctx.toast('格式不對：' + e.message, 't-err'); return; }
        } else if (/\.(md|markdown)$/i.test(vpath)) {
          var rm = await A.fs.read(vpath);
          if (!rm.ok) { ctx.toast('開啟失敗：' + rm.error, 't-err'); return; }
          stamp = rm.data.mtime;
          var conv = await A.office.convert('md->blocks', rm.data.content);
          blocks = conv.ok ? conv.data : [];
          title = vpath.split('/').pop().replace(/\.(md|markdown)$/i, '');
          // Markdown carries no page furniture; keeping the last document's would
          // put someone else's header on this one.
          docHeader = '';
          docFooter = '';
          docPageNum = false;
          if (rm.data.untrusted) ctx.toast('這份文件來自不可信來源', 't-taint');
        } else if (/\.docx$/i.test(vpath)) {
          var rd = await A.office.readDocx(vpath);
          if (!rd.ok) { ctx.toast('開啟失敗：' + rd.error, 't-err'); return; }
          stamp = rd.data.mtime;
          blocks = rd.data.blocks || [];
          title = vpath.split('/').pop().replace(/\.docx$/i, '');
          // The section's running head, if the file had one.
          docHeader = String(rd.data.header || '');
          docFooter = String(rd.data.footer || '');
          docPageNum = !!rd.data.pageNumbers;
          ctx.toast('已讀入 docx。存回 docx 時只會保留這裡看得到的結構，' +
            '原檔的複雜格式不會保留。', 't-warn');
        } else {
          ctx.toast('文件打不開 ' + vpath, 't-warn');
          return;
        }

        path = vpath;
        pathMtime = stamp;
        dirty = false;
        undoStack = [];
        render();
        ctx.setTitle('文件 — ' + title);
      }

      /* ===================================================== find and replace

         Over the block model, not over the DOM. A search that walked the rendered
         page would find the same word twice in a merged cell, would miss a word
         split across two runs by a bold in the middle of it, and would have
         nothing to say about which block a hit was in.
         ==================================================================== */

      function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

      function findRe(needle, caseSensitive, global) {
        return new RegExp(escapeRe(needle), (global ? 'g' : '') + (caseSensitive ? '' : 'i'));
      }

      /** Every hit, in reading order: {block, cell:{c,r}|null, start, end}. */
      function findAll(needle, caseSensitive) {
        var hits = [];
        if (!needle) return hits;
        blocks.forEach(function (b, i) {
          var re = findRe(needle, caseSensitive, true);
          if (b.type === 'table') {
            (b.rows || []).forEach(function (cells, r) {
              cells.forEach(function (text, c) {
                re.lastIndex = 0;
                var m;
                while ((m = re.exec(String(text || '')))) {
                  hits.push({ block: i, cell: { c: c, r: r }, start: m.index, end: m.index + m[0].length });
                  if (!m[0].length) re.lastIndex++;
                }
              });
            });
            return;
          }
          if (!isTextBlock(b)) return;
          var text = runsOf(b).map(function (x) { return x.text; }).join('');
          var mm;
          while ((mm = re.exec(text))) {
            hits.push({ block: i, cell: null, start: mm.index, end: mm.index + mm[0].length });
            if (!mm[0].length) re.lastIndex++;
          }
        });
        return hits;
      }

      /** Scroll to a hit and select it, so the next action is obvious. */
      function showHit(hit) {
        focusIndex = hit.block;
        render();
        var row = blockRow(hit.block);
        if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
        if (hit.cell) {
          var td = row && row.querySelector('[data-r="' + hit.cell.r + '"][data-c="' + hit.cell.c + '"]');
          if (td) { setCellSel(hit.block, hit.cell.c, hit.cell.r); setSelectionOffsets(td, hit.start, hit.end); }
          return;
        }
        var node = editableFor(hit.block);
        if (node) setSelectionOffsets(node, hit.start, hit.end);
      }

      /** Step through the hits, wrapping round. Returns the count. */
      function findNext(back) {
        var hits = findAll(findState.needle, findState.caseSensitive);
        if (!hits.length) { ctx.toast('找不到「' + findState.needle + '」', 't-warn'); return 0; }
        findState.at = back
          ? (findState.at <= 0 ? hits.length - 1 : findState.at - 1)
          : (findState.at + 1) % hits.length;
        showHit(hits[findState.at]);
        ctx.toast('第 ' + (findState.at + 1) + ' / ' + hits.length + ' 個，在第 ' +
          (hits[findState.at].block + 1) + ' 個區塊', 't-info');
        return hits.length;
      }

      /**
       * Replace inside a block's runs, keeping each surviving character's format.
       *
       * The naive version -- read the text, replace, write one plain run -- is why
       * search and replace in a formatted document is usually avoided: it silently
       * flattens the paragraph it edited. Here every character carries a pointer to
       * the run it came from, the replacement takes the format of the character it
       * starts at, and the result is folded back into runs afterwards.
       */
      function replaceInRuns(b, needle, repl, caseSensitive) {
        var runs = runsOf(b);
        var text = runs.map(function (r) { return r.text; }).join('');
        if (!text) return 0;

        var fmtAt = [];
        runs.forEach(function (r) {
          var f = {};
          RUN_KEYS.forEach(function (k) { if (r[k]) f[k] = r[k]; });
          for (var i = 0; i < r.text.length; i++) fmtAt.push(f);
        });

        var re = findRe(needle, caseSensitive, true);
        var out = [];
        var count = 0;
        var last = 0;
        var m;
        while ((m = re.exec(text))) {
          if (!m[0].length) { re.lastIndex++; continue; }
          for (var i = last; i < m.index; i++) out.push({ f: fmtAt[i], c: text[i] });
          var f0 = fmtAt[m.index] || {};
          for (var j = 0; j < repl.length; j++) out.push({ f: f0, c: repl[j] });
          last = m.index + m[0].length;
          count++;
        }
        if (!count) return 0;
        for (var k = last; k < text.length; k++) out.push({ f: fmtAt[k], c: text[k] });

        var built = [];
        out.forEach(function (ch) {
          var prev = built[built.length - 1];
          // Identity, not equality: characters from one source run share one
          // format object, and writeRuns fuses the rest by value afterwards.
          if (prev && prev.__f === ch.f) { prev.text += ch.c; return; }
          var r = Object.assign({}, ch.f, { text: ch.c });
          r.__f = ch.f;
          built.push(r);
        });
        built.forEach(function (r) { delete r.__f; });
        writeRuns(b, built);
        return count;
      }

      function replaceAll(needle, repl, caseSensitive) {
        if (!needle) throw new Error('要給尋找的字');
        snapshot();
        var n = 0;
        blocks.forEach(function (b) {
          if (b.type === 'table') {
            var re = findRe(needle, caseSensitive, true);
            (b.rows || []).forEach(function (cells, r) {
              cells.forEach(function (text, c) {
                var s = String(text || '');
                re.lastIndex = 0;
                if (!re.test(s)) return;
                var hits = s.match(findRe(needle, caseSensitive, true));
                n += hits ? hits.length : 0;
                b.rows[r][c] = s.replace(findRe(needle, caseSensitive, true), repl);
              });
            });
            return;
          }
          if (!isTextBlock(b)) return;
          n += replaceInRuns(b, needle, repl, caseSensitive);
        });
        if (!n) { undoStack.pop(); return 0; }
        findState.at = -1;
        markDirty();
        render();
        return n;
      }

      /* ------------------------------------------------------------ panels */

      function closePop() { AIOS.popover.close(ctx.body); }

      function popover(anchor, build, cls) {
        return AIOS.popover(ctx.body, anchor, build, cls).el;
      }

      function popRow(p) {
        var row = el('div', 'ui-pop-row');
        p.appendChild(row);
        return row;
      }

      function swatchRow(current, onPick, autoLabel) {
        var row = el('div', 'ui-swatches');
        AIOS.palette.fills.forEach(function (col) {
          var b = el('button', 'ui-swatch' + (current === col.hex ? ' on' : ''));
          b.type = 'button';
          b.title = col.name;
          b.setAttribute('aria-label', col.name);
          if (col.hex) b.style.background = '#' + col.hex;
          else b.classList.add('ui-swatch-none');
          b.addEventListener('mousedown', function (e) { e.preventDefault(); });
          b.addEventListener('click', function () { onPick(col.hex); });
          row.appendChild(b);
        });
        if (autoLabel) {
          var auto = el('button', 'ui-swatch ui-swatch-auto', 'A');
          auto.type = 'button';
          auto.title = autoLabel;
          auto.addEventListener('mousedown', function (e) { e.preventDefault(); });
          auto.addEventListener('click', function () { onPick(''); });
          row.appendChild(auto);
        }
        return row;
      }

      /** A small button inside a panel. Same no-focus-steal rule as the toolbar. */
      function popBtn(row, label, title, onClick, on) {
        var b = el('button', 'fbtn' + (on ? ' on' : ''), label);
        b.type = 'button';
        if (title) b.title = title;
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', onClick);
        row.appendChild(b);
        return b;
      }

      /* Character formats that are used less often than B and I, kept behind one
         button so the first toolbar row does not become a wall of glyphs. */
      function runMorePopover() {
        var t = formatTarget();
        var st = t ? inlineStateOf(t) : {};
        popover(btnRunMore, function (p) {
          AIOS.popover.label(p, '字元格式');
          var r1 = popRow(p);
          popBtn(r1, 'x\u00b2', '上標', function () { closePop(); toggleFormat('sup'); }, st.sup);
          popBtn(r1, 'x\u2082', '下標', function () { closePop(); toggleFormat('sub'); }, st.sub);
          popBtn(r1, '</>', '行內程式碼（等寬字）', function () { closePop(); toggleFormat('code'); }, st.code);

          p.appendChild(el('div', 'ui-pop-sub', '文字色'));
          p.appendChild(swatchRow(t && t.range ? null : (t ? runsOf(t.b)[0] && runsOf(t.b)[0].colour : null),
            function (hex) { closePop(); applyRun({ colour: hex || null }); }, '自動（回到預設字色）'));

          p.appendChild(el('div', 'ui-pop-sub', '螢光'));
          p.appendChild(swatchRow(null, function (hex) {
            closePop();
            applyRun({ mark: hex || null });
          }, '取消螢光'));

          var r2 = popRow(p);
          popBtn(r2, '清除格式', '把選取範圍的字元格式全部去掉', function () {
            closePop(); clearRunFormat();
          });
          p.appendChild(el('p', 'ui-pop-note',
            '有選取範圍就只套在選取的字上，沒有就套用整段。螢光的字色會自動挑對比夠的墨色。'));
        }, 'ui-pop-wide');
      }

      function paraPopover() {
        var b = blocks[focusIndex] || {};
        popover(btnPara, function (p) {
          AIOS.popover.label(p, '段落格式');

          p.appendChild(el('div', 'ui-pop-sub', '對齊'));
          var r1 = popRow(p);
          ALIGNS.forEach(function (a) {
            popBtn(r1, a.label, a.title, function () {
              applyPara({ align: a.id || null });
              closePop();
            }, (b.align || '') === a.id);
          });

          p.appendChild(el('div', 'ui-pop-sub', '縮排　目前 ' + (b.indent || 0) + ' 級'));
          var r2 = popRow(p);
          popBtn(r2, '\u2190 減少', '往左一級', function () {
            applyPara({ indent: Math.max(0, (blocks[focusIndex].indent || 0) - 1) });
            closePop();
          });
          popBtn(r2, '增加 \u2192', '往右一級（每級 0.5 英寸，和 Word 一樣）', function () {
            applyPara({ indent: Math.min(8, (blocks[focusIndex].indent || 0) + 1) });
            closePop();
          });

          p.appendChild(el('div', 'ui-pop-sub', '行距'));
          var lh = el('select', 'ui-pop-field');
          LINE_HEIGHTS.forEach(function (o) {
            var opt = el('option', null, o[1]);
            opt.value = o[0];
            lh.appendChild(opt);
          });
          lh.value = b.lineHeight ? String(b.lineHeight) : '';
          lh.addEventListener('change', function () {
            applyPara({ lineHeight: lh.value ? Number(lh.value) : null });
            closePop();
          });
          p.appendChild(lh);

          p.appendChild(el('div', 'ui-pop-sub', '段前 / 段後距離（pt）'));
          var r3 = popRow(p);
          [['spaceBefore', '段前'], ['spaceAfter', '段後']].forEach(function (pair) {
            var input = el('input', 'ui-pop-field');
            input.type = 'number';
            input.min = '0';
            input.max = '96';
            input.style.width = '78px';
            input.placeholder = pair[1];
            input.title = pair[1] + '距離（pt）';
            input.value = b[pair[0]] ? String(b[pair[0]]) : '';
            input.addEventListener('change', function () {
              var patch = {};
              patch[pair[0]] = input.value ? Math.max(0, Math.min(96, Number(input.value))) : null;
              applyPara(patch);
            });
            r3.appendChild(input);
          });

          var r4 = popRow(p);
          popBtn(r4, '清除段落格式', null, function () {
            applyPara({ align: null, indent: null, lineHeight: null, spaceBefore: null, spaceAfter: null });
            closePop();
          });
          p.appendChild(el('p', 'ui-pop-note', '段落格式屬於整個區塊：半段沒辦法置中。表格也吃這些設定。'));
        }, 'ui-pop-wide');
      }

      /** Table size grid and the page break, the two things worth inserting. */
      function insertPopover() {
        popover(btnInsert, function (p) {
          AIOS.popover.label(p, '插入表格');
          var read = el('div', 'ui-tgrid-read', '拖過去選格數');
          var grid = el('div', 'ui-tgrid-grid');
          var cells = [];
          for (var r = 1; r <= 8; r++) {
            for (var c = 1; c <= 10; c++) {
              (function (rr, cc) {
                var cell = el('span', 'ui-tgrid-cell');
                cell.dataset.r = String(rr);
                cell.dataset.c = String(cc);
                cell.addEventListener('mouseenter', function () { mark(rr, cc); });
                cell.addEventListener('click', function () {
                  closePop();
                  insertTable(rr, cc);
                });
                cells.push(cell);
                grid.appendChild(cell);
              })(r, c);
            }
          }
          function mark(rr, cc) {
            read.textContent = cc + ' 欄 × ' + rr + ' 列';
            cells.forEach(function (n) {
              n.classList.toggle('on', Number(n.dataset.r) <= rr && Number(n.dataset.c) <= cc);
            });
          }
          p.appendChild(read);
          p.appendChild(grid);

          p.appendChild(el('div', 'ui-pop-sub', '其他'));
          var row = popRow(p);
          popBtn(row, '\u2504 分頁', '從這裡開始新的一頁（匯出 PDF 與 docx 都會斷頁）', function () {
            closePop();
            snapshot();
            var at = focusIndex >= 0 ? focusIndex + 1 : null;
            insertBlock(at, { type: 'break' });
            ctx.toast('已插入分頁', 't-ok');
          });
          p.appendChild(el('p', 'ui-pop-note', '表格的列欄與合併都用表格上的右鍵選單操作。'));
        }, 'ui-pop-wide');
      }

      function insertTable(rows, cols) {
        snapshot();
        var grid = [];
        for (var r = 0; r < rows; r++) {
          var line = [];
          for (var c = 0; c < cols; c++) {
            line.push(r === 0 ? '標題 ' + String.fromCharCode(65 + c) : '');
          }
          grid.push(line);
        }
        var at = focusIndex >= 0 ? focusIndex + 1 : null;
        insertBlock(at, { type: 'table', rows: grid });
        ctx.toast('已插入 ' + cols + ' 欄 × ' + rows + ' 列的表格。在表格上按右鍵可以增刪列欄與跨欄置中', 't-ok');
      }

      /**
       * The shared border toolbox, for a table block.
       *
       * Anchored to the block itself rather than to a toolbar button: this is
       * raised from the table's own menu, and the panel should appear next to the
       * table it will change.
       */
      function borderPopover(b, i, range, from) {
        var anchor = from || blockRow(i) || btnInsert;
        var n = AIOS.grid.table.size(b);
        var wide = range.c0 !== range.c1 || range.r0 !== range.r1;
        popover(anchor, function (p) {
          AIOS.popover.label(p, '框線與網底');
          AIOS.borders.panel(p, {
            scope: '表格 ' + n.cols + ' 欄 × ' + n.rows + ' 列　·　' +
                   (wide ? '已選 ' + AIOS.grid.label(range) : '整張表格'),
            fill: AIOS.grid.table.styleAt(b, range.c0, range.r0).bg || null,
            whole: true,
            /* No marked range means no range was chosen, and 內框線 over one cell
               has no interior to draw -- so the command would appear to do nothing.
               Somebody who opened this without selecting anything means the table. */
            wholeDefault: !wide,
            onFill: function (hex, whole) {
              closePop();
              var area = whole ? { c0: 0, r0: 0, c1: n.cols - 1, r1: n.rows - 1 } : range;
              tableOp(b, hex ? '已套用網底' : '已清除網底', function () {
                AIOS.grid.table.applyFill(b, area, hex);
              });
            },
            onApply: function (kind, whole) {
              closePop();
              var area = whole ? { c0: 0, r0: 0, c1: n.cols - 1, r1: n.rows - 1 } : range;
              tableOp(b, null, function () {
                var touched = AIOS.grid.table.applyBorder(b, area, kind, null);
                ctx.toast('框線：' + kind + '，' + touched + ' 格',
                  touched ? 't-ok' : 't-warn');
              });
            }
          });
        }, 'ui-pop-wide');
      }

      function findPopover() {
        popover(btnFind, function (p) {
          AIOS.popover.label(p, '尋找與取代');

          var find = el('input', 'ui-pop-field');
          find.placeholder = '尋找';
          find.value = findState.needle;
          p.appendChild(find);

          p.appendChild(el('div', 'ui-pop-sub', '取代成'));
          var repl = el('input', 'ui-pop-field');
          repl.placeholder = '（留白就是刪掉）';
          repl.value = findState.repl;
          p.appendChild(repl);

          // Directly under the field it counts, not at the bottom of the panel:
          // a number four controls away from its cause is a number nobody reads.
          var count = el('div', 'ui-pop-count', '');
          p.insertBefore(count, p.children[1].nextSibling);

          function sync() {
            findState.needle = find.value;
            findState.repl = repl.value;
            var n = find.value ? findAll(find.value, findState.caseSensitive).length : 0;
            count.textContent = find.value ? '找到 ' + n + ' 處' : '輸入要找的字';
          }
          find.addEventListener('input', function () { findState.at = -1; sync(); });
          repl.addEventListener('input', sync);
          find.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); sync(); findNext(e.shiftKey); }
          });

          var r1 = popRow(p);
          popBtn(r1, '\u2191 上一個', null, function () { sync(); findNext(true); });
          popBtn(r1, '\u2193 下一個', 'Enter', function () { sync(); findNext(false); });

          var r2 = popRow(p);
          var cs = el('label', 'ui-pop-check');
          var box = el('input');
          box.type = 'checkbox';
          box.checked = findState.caseSensitive;
          box.addEventListener('change', function () {
            findState.caseSensitive = box.checked;
            findState.at = -1;
            sync();
          });
          cs.appendChild(box);
          cs.appendChild(document.createTextNode('區分大小寫'));
          r2.appendChild(cs);

          popBtn(r2, '全部取代', '一步完成，可以復原', function () {
            sync();
            try {
              var n = replaceAll(find.value, repl.value, findState.caseSensitive);
              ctx.toast(n ? '取代了 ' + n + ' 處（可以復原）' : '沒有找到可以取代的字',
                n ? 't-ok' : 't-warn');
              if (n) closePop();
            } catch (e) { ctx.toast(e.message, 't-warn'); }
          });
          p.appendChild(el('p', 'ui-pop-note',
            '取代會保留每個字原本的格式；被換上的字沿用它開頭那個字的格式。表格的格子也會一起找。'));
          sync();
          find.focus();
          find.select();
        }, 'ui-pop-wide');
      }

      function layoutPopover() {
        popover(btnLayout, function (p) {
          AIOS.popover.label(p, '版面');

          var r0 = popRow(p);
          popBtn(r0, '整份字型：' + docFont + ' ' + docSize + 'pt', '設定整份文件的預設字型與字級',
            function () { closePop(); docFontPrompt(); });

          p.appendChild(el('div', 'ui-pop-sub', '頁首'));
          var head = el('input', 'ui-pop-field');
          head.placeholder = '每一頁的最上面';
          head.value = docHeader;
          p.appendChild(head);

          p.appendChild(el('div', 'ui-pop-sub', '頁尾'));
          var foot = el('input', 'ui-pop-field');
          foot.placeholder = '每一頁的最下面';
          foot.value = docFooter;
          p.appendChild(foot);

          var r1 = popRow(p);
          var lab = el('label', 'ui-pop-check');
          var box = el('input');
          box.type = 'checkbox';
          box.checked = docPageNum;
          lab.appendChild(box);
          lab.appendChild(document.createTextNode('頁尾加頁碼'));
          r1.appendChild(lab);

          popBtn(r1, '套用', null, function () {
            snapshot();
            docHeader = head.value.slice(0, 200);
            docFooter = foot.value.slice(0, 200);
            docPageNum = box.checked;
            markDirty();
            render();
            closePop();
            ctx.toast('版面已更新（匯出 PDF 與 docx 都會帶上）', 't-ok');
          });
          p.appendChild(el('p', 'ui-pop-note',
            '頁首頁尾只有在匯出 PDF 或 docx 時才會逐頁重複；編輯畫面上顯示一份，讓你看得到設定。'));
        }, 'ui-pop-wide');
      }

      function exportPopover() {
        popover(btnExport, function (p) {
          AIOS.popover.label(p, '匯出');
          var row = popRow(p);
          popBtn(row, 'Markdown', '.md', function () { closePop(); exportAs('md'); });
          popBtn(row, 'docx', 'Word 可以直接開', function () { closePop(); exportAs('docx'); });
          popBtn(row, 'PDF', '用 Chromium 的列印引擎排版成 A4，文字可選取',
            function () { closePop(); exportAs('pdf'); });
          p.appendChild(el('p', 'ui-pop-note',
            'docx 只會帶上這裡看得到的結構與格式；要完全保真請用 .aiosdoc 存檔。'));
        });
      }

      async function docFontPrompt() {
        var name = await ctx.prompt({
          label: '整份文件的預設字型',
          note: '目前是 ' + docFont + ' ' + docSize + 'pt。留白代表不改字型。\n' +
                '可用：' + AIOS.fonts.families.map(function (f) { return f.name; }).join('、'),
          value: docFont,
          selectStem: false
        });
        if (name === null) return;
        var sizeStr = await ctx.prompt({
          label: '預設字級（pt）',
          value: String(docSize),
          selectStem: false
        });
        if (sizeStr === null) return;
        snapshot();
        if (name) docFont = name;
        var n = Number(sizeStr);
        if (Number.isFinite(n) && n > 0) docSize = Math.max(4, Math.min(200, n));
        markDirty();
        render();
        ctx.toast('整份文件改成 ' + docFont + ' ' + docSize + 'pt', 't-ok');
      }

      /* -------------------------------------------------------- listeners */

      styleSel.addEventListener('change', function () {
        var b = blocks[focusIndex];
        if (!isTextBlock(b)) { syncStyleSel(); ctx.toast('分頁與表格沒有段落樣式', 't-warn'); return; }
        var v = styleSel.value;
        // Undoable like every other change: a heading turned into a paragraph by
        // a mis-click is as much of a loss as deleted text.
        snapshot();
        if (v.indexOf('heading') === 0) { b.type = 'heading'; b.level = Number(v.replace('heading', '')) || 1; }
        else if (v === 'list') { b.type = 'list'; b.ordered = false; }
        else if (v === 'listOrdered') { b.type = 'list'; b.ordered = true; }
        else if (v === 'quote') { b.type = 'quote'; }
        else { b.type = 'para'; delete b.level; }
        markDirty();
        render();
        focusBlock(focusIndex);
      });

      fontSel.addEventListener('change', async function () {
        var chosen = await AIOS.fonts.resolveChoice(fontSel.value, ctx.win.el);
        if (chosen === null) { syncFontSel(); return; }
        applyFont({ font: chosen || null });
      });

      sizeSel.addEventListener('change', function () {
        var v = sizeSel.value;
        applyFont({ size: v ? Number(v) : null });
      });

      btnRunMore.addEventListener('click', function () { runMorePopover(); });
      btnPara.addEventListener('click', function () { paraPopover(); });
      btnBorder.addEventListener('click', function () {
        var b = blocks[focusIndex];
        if (!b || b.type !== 'table') { ctx.toast('先把游標放進表格的一個格子裡', 't-warn'); return; }
        // The marked cell range if there is one, otherwise the cell the caret is in.
        var range = cellSel && cellSel.block === focusIndex
          ? cellSel : { c0: 0, r0: 0, c1: 0, r1: 0 };
        borderPopover(b, focusIndex, range, btnBorder);
      });
      btnInsert.addEventListener('click', function () { insertPopover(); });
      btnFind.addEventListener('click', function () { findPopover(); });
      btnLayout.addEventListener('click', function () { layoutPopover(); });
      btnExport.addEventListener('click', function () { exportPopover(); });
      btnUndo.addEventListener('click', undo);
      btnSave.addEventListener('click', function () { save(); });
      btnSaveAs.addEventListener('click', function () { saveAs(); });

      /* ------------------------------------------------------------ wiring */

      function publish() {
        var text = blocks.map(function (b, i) {
          return (i + 1) + '. [' + (BLOCK_LABELS[b.type] || b.type) + '] ' + textOf(b);
        }).join('\n');
        ctx.publish('文件 ' + (path || title) + '：\n' + text.slice(0, 5000), 'app/docs');
      }

      ctx.describe(function () {
        return [
          '檔案：' + (path || '（新文件）') + (dirty ? '（未儲存）' : ''),
          '標題：' + title,
          '整份預設字型：' + docFont + ' ' + docSize + 'pt',
          '版面：頁首「' + (docHeader || '無') + '」、頁尾「' + (docFooter || '無') + '」' +
            (docPageNum ? '、頁尾有頁碼' : ''),
          '游標在第 ' + (focusIndex + 1) + ' 個區塊',
          '可用的字元格式：粗體、斜體、底線、刪除線、上標、下標、程式碼、文字色、螢光' +
            '（formatText 用，顏色名：' +
            AIOS.palette.fills.filter(function (c) { return c.hex; })
              .map(function (c) { return c.name; }).join('、') + '）',
          '段落格式：對齊 left/center/right/justify、縮排 0–8 級、行距倍數、段前段後 pt（setPara 用）',
          '區塊清單（編號就是 setBlock / deleteBlock 要用的 index）：',
          blocks.map(function (b, i) {
            var kind = BLOCK_LABELS[b.type] || b.type;
            if (b.type === 'heading') kind += ' H' + (b.level || 1);
            if (b.type === 'break') return '  ' + (i + 1) + '. [分頁] （這裡開始新的一頁）';
            var para = paraSummary(b);
            if (para) kind += '，' + para;
            var runs = runSummary(b);
            if (runs) kind += '，含 ' + runs;
            if (b.type === 'table') {
              /* Said out loud, because the text below shows a merged region as its
                 top-left value followed by blanks, and a model reading that would
                 conclude those cells are free. */
              var n = AIOS.grid.table.size(b);
              kind += ' ' + n.cols + '欄×' + n.rows + '列';
              if ((b.merges || []).length) {
                kind += '，合併 ' + b.merges.map(AIOS.grid.label).join('、');
              }
              var styled = Object.keys(b.cellStyles || {}).length;
              if (styled) kind += '，' + styled + ' 格有框線或網底';
            }
            return '  ' + (i + 1) + '. [' + kind + '] ' + textOf(b).slice(0, 300);
          }).join('\n')
        ].join('\n');
      });

      ctx.saveKeys(save, saveAs);

      /* Right-click. Blocks are addressable objects here, so the menu can offer
         block-level edits -- which is the whole reason this app stores a typed
         list instead of a blob of HTML. The contenteditable itself keeps the
         platform menu, so this fires on the block number and the chrome. */
      ctx.setMenu(function (ev) {
        var row = ev.target.closest ? ev.target.closest('.dc-block') : null;
        /* The block's own number, not its position among the page's children:
           the running-head strips are children too, so an indexOf here named the
           block after the one that was clicked. */
        var i = row ? Number(row.dataset.bi) : -1;
        var b = i >= 0 ? blocks[i] : null;

        var head = [];
        if (b && b.type === 'table') head = tableMenu(b, i, ev);
        if (b) {
          /* The character formats, when the click landed in text. Offered here as
             well as in the toolbar because a right-click is where a hand goes
             after selecting a word, and because the menu already knows which
             block it is in. */
          if (isTextBlock(b)) {
            /* A right-click selects the block it landed on, so the menu's items
               and the block it names are the same one. Without this the verbs act
               on wherever the caret happened to be left. */
            focusIndex = i;
            syncStyleSel();
            syncFontSel();
            var st = inlineStateOf({ b: b, i: i, node: editableFor(i), range: (function () {
              var node = editableFor(i);
              var r = node ? selectionOffsets(node) : null;
              return r && r.end > r.start ? r : null;
            })() });
            head = head.concat([
              { label: (st.bold ? '\u2713 ' : '') + '粗體', hint: 'Ctrl+B',
                run: function () { toggleFormat('bold'); } },
              { label: (st.italic ? '\u2713 ' : '') + '斜體', hint: 'Ctrl+I',
                run: function () { toggleFormat('italic'); } },
              { label: (st.under ? '\u2713 ' : '') + '底線', hint: 'Ctrl+U',
                run: function () { toggleFormat('under'); } },
              { label: (st.strike ? '\u2713 ' : '') + '刪除線',
                run: function () { toggleFormat('strike'); } },
              { label: (st.code ? '\u2713 ' : '') + '行內程式碼',
                run: function () { toggleFormat('code'); } },
              { label: '更多字元格式…', run: function () { runMorePopover(); } },
              { label: '清除字元格式', run: clearRunFormat },
              { sep: true }
            ]);
          }

          head = head.concat([
            { label: '第 ' + (i + 1) + ' 個區塊：' + (BLOCK_LABELS[b.type] || b.type) +
                     (b.font ? '　' + b.font : '') + (b.size ? '　' + b.size + 'pt' : '') +
                     (paraSummary(b) ? '　' + paraSummary(b) : ''), disabled: true },
            b.font || b.size
              ? { label: '清掉這個區塊的字型設定', run: function () {
                  focusIndex = i;
                  snapshot();
                  applyBlockFormat(b, { font: null, size: null });
                  markDirty();
                  render();
                } }
              : null,
            { label: '段落格式…', run: function () { focusIndex = i; paraPopover(); } },
            { label: '在下面插入段落', run: function () { snapshot(); insertBlock(i + 1, { type: 'para', text: '' }); focusBlock(i + 1); } },
            { label: '在下面插入項目', run: function () { snapshot(); insertBlock(i + 1, { type: 'list', text: '' }); focusBlock(i + 1); } },
            { label: '在下面插入分頁', run: function () { snapshot(); insertBlock(i + 1, { type: 'break' }); } },
            { label: '複製這個區塊的文字', disabled: b.type === 'break',
              run: function () { A.clipboard.write(textOf(b)); ctx.toast('已複製'); } },
            { label: '刪除這個區塊', danger: true, disabled: blocks.length <= 1, run: function () {
              snapshot(); deleteBlock(i);
            } },
            { sep: true }
          ]);
        }

        return head.concat([
          { label: '尋找與取代…', hint: 'Ctrl+F', run: function () { findPopover(); } },
          { label: '版面：' + docFont + ' ' + docSize + 'pt' +
                   (docHeader || docFooter || docPageNum ? '　·　有頁首頁尾' : ''),
            run: function () { layoutPopover(); } },
          { sep: true },
          { label: '儲存', hint: 'Ctrl+S', run: function () { save(); } },
          { label: '另存新檔…', hint: 'Ctrl+Shift+S', run: function () { saveAs(); } },
          { sep: true },
          { label: '匯出 Markdown', run: function () { exportAs('md'); } },
          { label: '匯出 docx（含格式與頁首頁尾）', run: function () { exportAs('docx'); } },
          { label: '匯出 PDF', run: function () { exportAs('pdf'); } },
          { sep: true },
          { label: '復原上一步', hint: 'Ctrl+Z', disabled: !undoStack.length, run: undo },
          { label: '開啟檔案…', run: function () { AIOS.apps.launch('files'); } }
        ]);
      });

      /* -------------------------------------------- the model's own handles

         Everything here is addressed by block number and by literal text, never
         by "the selection": the model has no view of where the caret is, and an
         action that acted on it would do something different every time it was
         replayed from the journal.
         ==================================================================== */

      function setParaApi(spec) {
        var s = spec || {};
        var one = s.index !== undefined;
        var i = Number(s.index) - 1;
        if (one && !blocks[i]) throw new Error('沒有第 ' + s.index + ' 個區塊（共 ' + blocks.length + ' 個）');
        snapshot();
        (one ? [blocks[i]] : blocks).forEach(function (b) { applyParaSpec(b, s); });
        markDirty();
        render();
        return one
          ? '第 ' + s.index + ' 個區塊：' + (paraSummary(blocks[i]) || '沒有特別的段落設定')
          : blocks.length + ' 個區塊的段落格式都改了';
      }

      function formatTextApi(spec) {
        var s = spec || {};
        var i = Number(s.index) - 1;
        var b = blocks[i];
        if (!isTextBlock(b)) throw new Error('第 ' + s.index + ' 個區塊沒有可以套格式的文字');

        var patch = {};
        if (s.clear) RUN_KEYS.forEach(function (k) { patch[k] = null; });
        TOGGLE_KEYS.forEach(function (k) {
          if (s[k] !== undefined) patch[k] = s[k] ? true : null;
        });
        if (s.colour !== undefined) patch.colour = s.colour ? AIOS.palette.hexOf(s.colour) : null;
        if (s.mark !== undefined) patch.mark = s.mark ? AIOS.palette.hexOf(s.mark) : null;
        if (!Object.keys(patch).length) throw new Error('要給至少一種格式，或 clear:true');

        var text = runsOf(b).map(function (r) { return r.text; }).join('');
        snapshot();
        var hits = 0;
        if (s.find) {
          var needle = String(s.find);
          // Every occurrence, not the first: "make the model numbers bold" means
          // all of them, and doing one silently is worse than refusing.
          var at = text.indexOf(needle);
          if (at < 0) {
            undoStack.pop();
            throw new Error('第 ' + s.index + ' 個區塊裡沒有「' + needle + '」');
          }
          while (at >= 0) {
            applyRunFormat(b, at, at + needle.length, patch);
            hits++;
            at = text.indexOf(needle, at + needle.length);
          }
        } else {
          applyRunFormat(b, 0, text.length, patch);
        }
        markDirty();
        render();
        return '第 ' + s.index + ' 個區塊' +
          (s.find ? ' 的 ' + hits + ' 處「' + s.find + '」' : '整段') +
          '：' + (runSummary(b) || '格式已清除');
      }

      function setLayout(spec) {
        var s = spec || {};
        if (s.header === undefined && s.footer === undefined && s.pageNumbers === undefined) {
          throw new Error('要給 header、footer 或 pageNumbers');
        }
        snapshot();
        if (s.header !== undefined) docHeader = String(s.header || '').slice(0, 200);
        if (s.footer !== undefined) docFooter = String(s.footer || '').slice(0, 200);
        if (s.pageNumbers !== undefined) docPageNum = !!s.pageNumbers;
        markDirty();
        render();
        return '頁首「' + (docHeader || '無') + '」、頁尾「' + (docFooter || '無') + '」' +
          (docPageNum ? '、頁尾加頁碼' : '');
      }

      /**
       * Borders and shading on a table block, by coordinates.
       *
       * The range arithmetic is the shared one, so a border asked for in a
       * conversation lands on exactly the cells the same command from the menu
       * would have touched.
       */
      function setTableStyle(spec) {
        var s = spec || {};
        var i = Number(s.index) - 1;
        var b = blocks[i];
        if (!b || b.type !== 'table') throw new Error('第 ' + s.index + ' 個區塊不是表格');
        normTable(b);
        var n = AIOS.grid.table.size(b);
        var area = {
          c0: s.c0 === undefined ? 0 : Math.max(0, Number(s.c0)),
          r0: s.r0 === undefined ? 0 : Math.max(0, Number(s.r0)),
          c1: s.c1 === undefined ? n.cols - 1 : Math.min(n.cols - 1, Number(s.c1)),
          r1: s.r1 === undefined ? n.rows - 1 : Math.min(n.rows - 1, Number(s.r1))
        };
        if (![area.c0, area.r0, area.c1, area.r1].every(Number.isFinite) ||
            area.c1 < area.c0 || area.r1 < area.r0) {
          throw new Error('範圍不合法（0 起算，c1/r1 含端點）');
        }

        var said = [];
        if (s.fill !== undefined) {
          // Validated before anything is written, so a bad name changes nothing.
          var shade = AIOS.palette.require(s.fill, '網底');
          var count = AIOS.grid.table.applyFill(b, area, shade);
          said.push((shade ? '網底 #' + shade : '清除網底') + '（' + count + ' 格）');
        }
        if (s.border !== undefined) {
          var kind = String(s.border || 'none');
          if (!AIOS.borders.APPLY.some(function (a) { return a.id === kind; })) {
            throw new Error('不認得的框線種類「' + kind + '」；可用：' +
              AIOS.borders.APPLY.map(function (a) { return a.id; }).join('、'));
          }
          if (s.borderStyle &&
              !AIOS.borders.STYLES.some(function (x) { return x.id === s.borderStyle; })) {
            throw new Error('不認得的線條樣式「' + s.borderStyle + '」；可用：' +
              AIOS.borders.STYLES.map(function (x) { return x.id; }).join('、'));
          }
          // An explicit pen is a one-off; omitted, the shared pen is used, which is
          // what makes a border drawn from a conversation match one drawn by hand.
          var pen = kind === 'none' ? null : AIOS.borders.edge({
            style: s.borderStyle || AIOS.borders.pen.style,
            width: s.borderWidth || AIOS.borders.pen.width,
            colour: AIOS.palette.require(s.borderColour, '畫筆色彩') || AIOS.borders.pen.colour
          });
          var touched = AIOS.grid.table.applyBorder(b, area, kind, pen);
          said.push('框線 ' + kind + (pen ? '（' + AIOS.borders.styleOf(pen.style).name + ' ' +
            AIOS.borders.widthLabel(pen.width) + ' #' + pen.colour + '）' : '') +
            '（' + touched + ' 格）');
        }
        if (!said.length) throw new Error('要給 border 或 fill');

        markDirty();
        render();
        return '第 ' + s.index + ' 個表格 ' + AIOS.grid.label(area) + '：' + said.join('、');
      }

      ctx.api = {
        setBlock: setBlock, insertBlock: insertBlock, deleteBlock: deleteBlock,
        setTableStyle: setTableStyle,
        fromMarkdown: fromMarkdown, toMarkdown: toMarkdown,
        save: save, saveAs: saveAs, exportAs: exportAs, open: open, snapshot: snapshot, undo: undo,
        setFont: setFont, setPara: setParaApi, formatText: formatTextApi,
        replaceAll: replaceAll, setLayout: setLayout,
        fontState: function () { return { font: docFont, size: docSize }; }
      };

      (async function boot() {
        var st = ctx.state;
        if (st && st.blocks) {
          blocks = st.blocks;
          title = st.title || title;
          path = st.path || null;
          /* A restored window has not read the file this session, so it makes no
             claim about which version it is replacing: the first save after a
             restore is unconditional, and everything after it carries the stamp
             that save returned. Keeping a stamp across a restart would be worse
             than none -- it would name a version nobody here has seen. */
          pathMtime = null;
          dirty = !!st.dirty;
          if (st.font) docFont = st.font;
          if (st.size) docSize = st.size;
          docHeader = String(st.header || '');
          docFooter = String(st.footer || '');
          docPageNum = !!st.pageNumbers;
          render();
          if (path) ctx.setTitle('文件 — ' + title);
        } else if (typeof ctx.arg === 'string') {
          await open(ctx.arg);
        } else {
          blocks = [{ type: 'heading', level: 1, text: '未命名文件' }, { type: 'para', text: '' }];
          render();
          focusBlock(1);
        }
      })();

      return {
        getState: function () {
          return {
            blocks: blocks, title: title, path: path, dirty: dirty,
            // The typeface and the page furniture belong to the document, so a
            // restored window has to bring them back with the text -- otherwise
            // a reboot silently resets the header it was told to keep.
            font: docFont, size: docSize,
            header: docHeader, footer: docFooter, pageNumbers: docPageNum
          };
        },
        reopen: function (p) { if (typeof p === 'string') open(p); },
        /* Read by the window before it closes, so an edited document is not
           thrown away by one click on the X. */
        unsaved: function () { return dirty; },
        docName: function () { return path || title; },
        save: save,
        onClose: function () { ctx.publish(null); }
      };
    }
  });
})();
