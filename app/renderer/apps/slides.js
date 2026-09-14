'use strict';

/* ===========================================================================
   AI-OS // Slides
   ---------------------------------------------------------------------------
   A deck is an array of slides. Each slide has two parts:

     the layout   a named arrangement of a title and one or two text areas.
                  Named rather than free-form because "add a two-column slide
                  comparing these" is a real instruction a model can follow.

     the objects  a free layer of tables, pictures, shapes and text boxes, each
                  with its own position. This is the half that cannot be
                  expressed as a layout name, and the half every real
                  presentation needs.

   OBJECT GEOMETRY IS IN PERCENT, NEVER PIXELS

   The same slide is drawn at four sizes: the editing stage, a 170px thumbnail,
   a full-screen projection, and an A4 landscape page. Pixel coordinates would
   be correct in exactly one of them. Percentages of a 16:9 box are correct in
   all four, which is why the canvas has a fixed aspect ratio everywhere.

   Type sizes follow the same rule through container query units: `cqh` is a
   percentage of the canvas height, so a 24pt heading keeps its proportion at
   every one of those sizes. Sizes are stored in points as measured on a
   standard 7.5in-tall slide (540pt), because that is the number people know.

   ONE RENDERER, FOUR DESTINATIONS

   buildSlide() produces DOM, and the exports serialise that DOM rather than
   rebuilding the slide from strings. The old code had a string builder for HTML
   and another for print, and they had already drifted from what the editor
   showed. Objects carry their whole appearance as inline style for the same
   reason: those styles travel into the exported file, where this shell's
   stylesheet does not exist.
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

  var LAYOUTS = {
    title: '封面',
    bullets: '標題 + 項目',
    text: '標題 + 段落',
    two: '雙欄比較',
    quote: '大字引言',
    section: '章節分隔',
    blank: '空白（只有物件）'
  };

  var KINDS = { text: '文字方塊', image: '圖片', shape: '圖案', table: '表格', chart: '圖表' };

  /* The shape gallery.
     Drawn with clip-path rather than SVG because a clip is expressed in
     percentages of the box, so one shape definition is correct in the editor, in
     a thumbnail, on a projector and on paper. An outline is a second clipped
     layer behind the fill rather than a CSS border: a border on a clipped box is
     clipped along with it and comes out as fragments. */
  var SHAPES = {
    rect:      { name: '矩形' },
    round:     { name: '圓角矩形', radius: '6%' },
    pill:      { name: '膠囊', radius: '999px' },
    ellipse:   { name: '橢圓', clip: 'ellipse(50% 50% at 50% 50%)' },
    triangle:  { name: '三角形', clip: 'polygon(50% 0%, 100% 100%, 0% 100%)' },
    rtri:      { name: '直角三角形', clip: 'polygon(0% 0%, 0% 100%, 100% 100%)' },
    diamond:   { name: '菱形', clip: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)' },
    pentagon:  { name: '五邊形', clip: 'polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)' },
    hexagon:   { name: '六邊形', clip: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)' },
    star:      { name: '星形', clip: 'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)' },
    plus:      { name: '十字', clip: 'polygon(35% 0%, 65% 0%, 65% 35%, 100% 35%, 100% 65%, 65% 65%, 65% 100%, 35% 100%, 35% 65%, 0% 65%, 0% 35%, 35% 35%)' },
    para:      { name: '平行四邊形', clip: 'polygon(20% 0%, 100% 0%, 80% 100%, 0% 100%)' },
    trapezoid: { name: '梯形', clip: 'polygon(20% 0%, 80% 0%, 100% 100%, 0% 100%)' },
    arrowR:    { name: '右箭頭', clip: 'polygon(0% 30%, 62% 30%, 62% 4%, 100% 50%, 62% 96%, 62% 70%, 0% 70%)' },
    arrowL:    { name: '左箭頭', clip: 'polygon(100% 30%, 38% 30%, 38% 4%, 0% 50%, 38% 96%, 38% 70%, 100% 70%)' },
    arrowU:    { name: '上箭頭', clip: 'polygon(30% 100%, 30% 38%, 4% 38%, 50% 0%, 96% 38%, 70% 38%, 70% 100%)' },
    arrowD:    { name: '下箭頭', clip: 'polygon(30% 0%, 30% 62%, 4% 62%, 50% 100%, 96% 62%, 70% 62%, 70% 0%)' },
    chevron:   { name: '箭號', clip: 'polygon(0% 0%, 75% 0%, 100% 50%, 75% 100%, 0% 100%, 25% 50%)' },
    callout:   { name: '對話框', clip: 'polygon(0% 0%, 100% 0%, 100% 74%, 34% 74%, 18% 100%, 17% 74%, 0% 74%)' }
  };

  /* A slide is 540pt tall by convention (7.5 inches), so a point size converts
     to a percentage of the canvas height by dividing by 5.4. Everything about
     type size in this file goes through this one number. */
  var PT_PER_CQH = 5.4;

  var TEXT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 54, 60, 72, 88];

  var DEFAULTS = {
    text:  { w: 42, h: 16, size: 24, align: 'left', valign: 'top' },
    shape: { w: 26, h: 20, size: 18, align: 'center', valign: 'middle' },
    image: { w: 40, h: 34, size: 14, align: 'center', valign: 'middle' },
    table: { w: 62, h: 30, size: 14, align: 'left', valign: 'middle' },
    chart: { w: 56, h: 50, size: 12, align: 'center', valign: 'middle' }
  };

  var HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  /* The middle option of each pair says which axis it belongs to. Two unlabelled
     dropdowns side by side, both offering 「置中」, are indistinguishable without
     hovering for a tooltip -- which reads as "there is no vertical alignment". */
  var ALIGNS = [
    { id: 'left', name: '靠左' },
    { id: 'center', name: '水平置中' },
    { id: 'right', name: '靠右' }
  ];
  var VALIGNS = [
    { id: 'top', name: '靠上' },
    { id: 'middle', name: '垂直置中' },
    { id: 'bottom', name: '靠下' }
  ];
  var FITS = [{ id: 'contain', name: '完整顯示' }, { id: 'cover', name: '填滿裁切' }, { id: 'fill', name: '拉伸' }];

  var MAX_TABLE_ROWS = 20;
  var MAX_TABLE_COLS = 10;

  function uid() {
    return 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function span(v, dflt, lo, hi) {
    var n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, Math.round(n * 100) / 100));
  }

  /** Colours are stored the way the shared palette stores them: bare hex, or ''. */
  function hexOr(value, dflt) {
    if (value === '' || value === null) return '';
    if (value === undefined) return dflt === undefined ? '' : dflt;
    return AIOS.palette.hexOf(value) || (dflt === undefined ? '' : dflt);
  }

  function normRows(raw, fallbackRows, fallbackCols) {
    var rows = Array.isArray(raw) ? raw : null;
    if (!rows || !rows.length) {
      rows = [];
      for (var r = 0; r < (fallbackRows || 3); r++) {
        rows.push(new Array(fallbackCols || 3).fill(''));
      }
    }
    rows = rows.slice(0, MAX_TABLE_ROWS).map(function (row) {
      var cells = Array.isArray(row) ? row : [row];
      return cells.slice(0, MAX_TABLE_COLS).map(function (c) { return String(c == null ? '' : c); });
    });
    // Ragged input is normal from a model. A table has to be rectangular.
    var width = rows.reduce(function (m, row) { return Math.max(m, row.length); }, 1);
    return rows.map(function (row) {
      while (row.length < width) row.push('');
      return row;
    });
  }

  /**
   * The spec a chart object holds, from whichever shape it arrived in.
   *
   * A saved deck and a paste carry the spec itself. A conversation building a
   * whole deck in one call says `rows` inside a slide's objects, the way it
   * says them for a table -- so rows are read into categories and series here,
   * by the reader the editor's own panel uses. An object that carries neither
   * is handed over as it is; norm() reads what it can and draws 沒有資料.
   */
  function chartSpecOf(o) {
    if (o.chart && typeof o.chart === 'object') return o.chart;
    if (!Array.isArray(o.rows)) return o;
    var got = AIOS.charts.fromRows(o.rows, {
      seriesIn: o.seriesIn, headerRow: o.headerRow, headerCol: o.headerCol, omitTotals: o.omitTotals
    });
    return Object.assign({}, o, {
      categories: got.categories, series: got.series,
      title: o.title || got.titleHint, xTitle: o.xTitle || got.corner, numFmt: o.numFmt || got.numFmtHint
    });
  }

  /**
   * Everything an object needs, with anything missing filled in.
   *
   * The single gate for objects arriving from a saved file, from the chat model,
   * or from a toolbar button, so no other code has to ask whether a field is
   * there.
   */
  function normObject(raw) {
    var o = raw || {};
    var kind = KINDS[o.kind] ? o.kind : 'text';
    var d = DEFAULTS[kind];

    /* Objects may hang slightly off the slide -- that is a legitimate design --
       but not so far that they become unreachable in the editor. */
    var out = {
      id: String(o.id || uid()).slice(0, 24),
      kind: kind,
      x: span(o.x, 8, -25, 120),
      y: span(o.y, 20, -25, 120),
      w: span(o.w, d.w, 2, 150),
      h: span(o.h, d.h, 2, 150),
      size: span(o.size, d.size, 6, 200),
      align: ALIGNS.some(function (a) { return a.id === o.align; }) ? o.align : d.align,
      valign: VALIGNS.some(function (a) { return a.id === o.valign; }) ? o.valign : d.valign,
      bold: !!o.bold,
      italic: !!o.italic,
      fill: hexOr(o.fill, ''),
      stroke: hexOr(o.stroke, ''),
      colour: hexOr(o.colour, '')
    };

    if (kind === 'text') {
      out.text = String(o.text == null ? '' : o.text).slice(0, 4000);
    } else if (kind === 'shape') {
      out.shape = SHAPES[o.shape] ? o.shape : 'rect';
      out.text = String(o.text == null ? '' : o.text).slice(0, 1000);
      // A shape with no fill is an outline nobody asked for, so a new one gets a
      // colour. An explicit '' still clears it.
      out.fill = hexOr(o.fill, '1F4E79');
    } else if (kind === 'image') {
      out.src = String(o.src || '');
      out.alt = String(o.alt || '').slice(0, 200);
      out.fit = FITS.some(function (f) { return f.id === o.fit; }) ? o.fit : 'contain';
      out.round = !!o.round;
    } else if (kind === 'chart') {
      /* The chart's own fields are the shared module's business: one gate for
         a spec from a file, a chat action or a paste, the same gate the
         document and the spreadsheet use. No fill by default -- the drawing
         paints on the slide -- and the stroke is not read at all. */
      out.chart = AIOS.charts.norm(chartSpecOf(o));
    } else {
      out.rows = normRows(o.rows, o.rowCount, o.colCount);
      out.header = o.header === undefined ? true : !!o.header;
      out.banded = o.banded === undefined ? true : !!o.banded;
      out.fill = hexOr(o.fill, '1F4E79');
      out.stroke = hexOr(o.stroke, '8FA3B8');
      /* Merged cells, bounded by the rows that actually exist -- a region from a
         file describing a wider table than the one it arrived with cannot be
         drawn. The algebra is AIOS.grid's, the same one the spreadsheet uses. */
      out.merges = AIOS.grid.norm(o.merges, {
        rows: out.rows.length, cols: out.rows[0].length, limit: 60
      });
      /* Per-cell borders and shading, sparse and keyed by "c,r". Cleaned here so
         a saved file or a chat action cannot introduce a border shape the
         renderer would have to guess about, and dropped entirely when empty --
         an untouched table should cost nothing in the saved deck. */
      var styles = AIOS.borders.normCellStyles(o.cellStyles, {
        rows: out.rows.length, cols: out.rows[0].length
      });
      if (styles) out.cellStyles = styles;
    }
    return out;
  }

  function normObjects(list) {
    return (Array.isArray(list) ? list : []).slice(0, 40).map(normObject);
  }

  function normBody(body, layout) {
    if (body === undefined) return layout === 'two' ? ['', ''] : [''];
    var arr = Array.isArray(body) ? body.slice() : [String(body)];
    // Arrays of bullet lines are joined; two-column layouts need two entries.
    if (layout === 'two') {
      while (arr.length < 2) arr.push('');
      return arr.slice(0, 2).map(function (x) {
        return Array.isArray(x) ? x.join('\n') : String(x);
      });
    }
    return [arr.map(function (x) { return Array.isArray(x) ? x.join('\n') : String(x); }).join('\n')];
  }

  function blank(layout) {
    var l = LAYOUTS[layout] ? layout : 'bullets';
    return { layout: l, title: '', body: normBody(undefined, l), notes: '', objects: [] };
  }

  /** A slide from any source, including a version 1 or 2 file with no objects. */
  function normSlide(raw) {
    var s = raw || {};
    var layout = LAYOUTS[s.layout] ? s.layout : 'bullets';
    return {
      layout: layout,
      title: String(s.title == null ? '' : s.title),
      body: normBody(s.body, layout),
      notes: String(s.notes == null ? '' : s.notes),
      objects: normObjects(s.objects)
    };
  }

  /* One action under two names. The document and the spreadsheet call theirs
     insertChart, and another program's 插入到簡報 arrives as addChart; a model
     that learned either verb should not be told the deck has no such thing. */
  var ADD_CHART = {
    args: '{index, type:"column"|"bar"|"line"|"area"|"pie"|"doughnut"|"scatter"|"stackedColumn"|"stackedBar"|"stackedArea", title, rows:[["月份","收入","支出"],["1月",120,80]], categories:["1月"], series:[{name:"收入", values:[120]}], seriesIn:"auto"|"cols"|"rows", headerRow, headerCol, omitTotals, legend:"bottom"|"right"|"none", labels:true|false（資料標籤）, numFmt, xTitle, yTitle, x, y, w, h, newSlide:true|false}',
    desc: '在第 index 頁放一張圖表（省略 index 就是目前這頁）。資料給 rows（二維陣列，第一列是數列名稱、' +
          '第一欄是類別）或 categories + series；newSlide:true 會先在那頁後面插入一頁空白頁，把圖表放在新的一頁',
    run: async function (args, ctx) {
      ctx.api.snapshot();
      return { note: ctx.api.addChart(args.index === undefined ? null : Number(args.index) - 1, args) };
    }
  };

  AIOS.apps.register({
    id: 'slides',
    name: '簡報',
    contentApp: true,   // its chat panel gets the intent-enrichment guide
    icon: '\u25b0',
    kind: 'DECK',
    width: 1020,
    height: 680,
    purpose: '製作與放映簡報',
    chatHint: '可以說「幫我做一份五頁的簡報介紹這台機器」、「第 3 頁改成雙欄比較」、「在這頁加一個 3×4 表格」' +
              '或「用這些數字畫一張直條圖」。',

    /* `.pptx` opens here too, but as an import: the file is read and a new,
       untitled deck appears. See importPptx for why it can never be saved back. */
    accepts: function (p) { return /\.(aiosdeck|pptx)$/i.test(p || ''); },

    actions: {
      setSlide: {
        args: '{index, title, body, layout, notes}', desc: '改寫第 index 頁（從 1 開始），body 是字串陣列',
        run: async function (args, ctx) {
          ctx.api.snapshot();
          ctx.api.setSlide(Number(args.index) - 1, args);
          return { note: '已改寫第 ' + args.index + ' 頁' };
        }
      },
      addSlide: {
        args: '{index, title, body, layout, notes, objects}', desc: '插入一頁，index 省略就加在最後',
        run: async function (args, ctx) {
          ctx.api.snapshot();
          var at = args.index === undefined ? null : Number(args.index) - 1;
          ctx.api.addSlide(at, args);
          return { note: '已新增一頁' };
        }
      },
      deleteSlide: {
        args: '{index}', desc: '刪掉第 index 頁',
        run: async function (args, ctx) {
          ctx.api.snapshot();
          ctx.api.deleteSlide(Number(args.index) - 1);
          return { note: '已刪除第 ' + args.index + ' 頁' };
        }
      },
      moveSlide: {
        args: '{index, to}', desc: '把第 index 頁搬到第 to 頁的位置（都從 1 開始）',
        run: async function (args, ctx) {
          ctx.api.snapshot();
          return { note: ctx.api.moveSlide(Number(args.index) - 1, Number(args.to) - 1) };
        }
      },
      buildDeck: {
        args: '{title, slides}', desc: '一次做出整份簡報，slides 是 [{layout,title,body,notes,objects}]',
        run: async function (args, ctx) {
          ctx.api.snapshot();
          var n = ctx.api.buildDeck(args.title, args.slides || []);
          return { note: '已建立 ' + n + ' 頁' };
        }
      },
      addObject: {
        args: '{index, kind:"text"|"image"|"shape"|"table"|"chart", x, y, w, h, text, src, shape, rows, chart, fill, stroke, colour, size, align, valign, bold, italic, fit}',
        desc: '在第 index 頁放一個物件。x/y/w/h 是投影片寬高的百分比（0-100），size 是點數；' +
              'chart 是圖表規格（畫圖表用 addChart 更方便）',
        run: async function (args, ctx) {
          ctx.api.snapshot();
          return { note: ctx.api.addObject(args.index === undefined ? null : Number(args.index) - 1, args) };
        }
      },
      addTable: {
        args: '{index, rows, cols, data, header, x, y, w, h}',
        desc: '在第 index 頁放一個表格。data 是二維陣列；沒給 data 就依 rows×cols 開空表',
        run: async function (args, ctx) {
          ctx.api.snapshot();
          return { note: ctx.api.addTable(args.index === undefined ? null : Number(args.index) - 1, args) };
        }
      },
      addChart: ADD_CHART,
      insertChart: { args: ADD_CHART.args, desc: '同 addChart（文件與試算表叫 insertChart，兩個名字都收）', run: ADD_CHART.run },
      setObject: {
        args: '{index, object, ...欄位}',
        desc: '改第 index 頁的第 object 個物件（都從 1 開始），欄位同 addObject；' +
              '圖表可以給 type、title、rows、categories、series、legend、labels、numFmt、xTitle、yTitle，或整個 chart',
        run: async function (args, ctx) {
          ctx.api.snapshot();
          return { note: ctx.api.setObject(Number(args.index) - 1, Number(args.object) - 1, args) };
        }
      },
      deleteObject: {
        args: '{index, object}', desc: '刪掉第 index 頁的第 object 個物件',
        run: async function (args, ctx) {
          ctx.api.snapshot();
          return { note: ctx.api.deleteObject(Number(args.index) - 1, Number(args.object) - 1) };
        }
      },
      setTableStyle: {
        args: '{index, object, c0, r0, c1, r1, border, borderStyle, borderWidth, borderColour, fill}',
        desc: '設定第 index 頁第 object 個表格的框線與網底。範圍用 0 起算的 c0/r0/c1/r1，' +
              '省略就是整張表格。border 是 all/box/inside/insideH/insideV/top/bottom/left/right/none；' +
              'borderStyle 是 single/double/dashed/dotted/dashDot；borderWidth 是 pt；' +
              'fill 與 borderColour 給顏色名或 hex',
        run: async function (args, ctx) {
          ctx.api.snapshot();
          return { note: ctx.api.setTableStyle(Number(args.index) - 1, Number(args.object) - 1, args) };
        }
      },
      tableToChart: {
        args: '{index, object, type:"column"|"bar"|"line"|"area"|"pie"|"doughnut"|"scatter"|"stackedColumn"|"stackedBar"|"stackedArea", title}',
        desc: '把第 index 頁的第 object 個表格換成同樣位置的圖表（object 省略就是選到的表格，或那頁最後一個表格）',
        run: async function (args, ctx) {
          ctx.api.snapshot();
          return { note: ctx.api.tableToChart(args.index === undefined ? null : Number(args.index) - 1,
            args.object === undefined ? null : Number(args.object) - 1, args) };
        }
      },
      chartToTable: {
        args: '{index, object}',
        desc: '把第 index 頁的第 object 個圖表換成同樣位置的表格（object 省略就是選到的圖表，或那頁最後一個圖表）',
        run: async function (args, ctx) {
          ctx.api.snapshot();
          return { note: ctx.api.chartToTable(args.index === undefined ? null : Number(args.index) - 1,
            args.object === undefined ? null : Number(args.object) - 1) };
        }
      },
      chartToApp: {
        args: '{index, object, app:"docs"|"sheets"}',
        desc: '把第 index 頁的第 object 個圖表插入到文件或試算表（這份簡報本身不會變）',
        run: async function (args, ctx) {
          return { note: await ctx.api.chartToApp(args.index === undefined ? null : Number(args.index) - 1,
            args.object === undefined ? null : Number(args.object) - 1, args.app) };
        }
      },
      present: {
        args: '{from}', desc: '開始放映',
        run: async function (args, ctx) {
          ctx.api.present(args.from ? Number(args.from) - 1 : 0);
          return { note: '放映中' };
        }
      },
      save: { args: '{}', desc: '儲存', run: async function (_a, ctx) { return { note: await ctx.api.save() }; } },
      saveAs: {
        args: '{path}', desc: '另存新檔（不給 path 就問使用者）。副檔名決定格式：' +
          '.aiosdeck 不失真、.pptx 給 PowerPoint、.pdf、.html、.md',
        run: async function (a, ctx) { return { note: await ctx.api.saveAs(a.path || null) }; }
      },
      setFont: {
        /* Units in the signature, not only in the prose: a plan passed
           `scale: 1.1` meaning "ten percent bigger" and was rejected, because
           「百分比」 next to a bare `scale` reads as a ratio just as easily. */
        args: '{font, scale:100~200}',
        desc: '設定整份簡報的字型與字級比例（scale 是百分比，100 是原大小，110 就是放大一成）',
        run: async function (a, ctx) { return { note: ctx.api.setFont(a) }; }
      },
      exportAs: {
        args: '{format:"pptx"|"pdf"|"html"|"md"}',
        desc: '匯出成 PowerPoint、PDF（一頁一張）、單一 HTML 或 Markdown',
        run: async function (args, ctx) { return { note: await ctx.api.exportAs(args.format) }; }
      }
    },

    mount: function (ctx) {
      ctx.body.classList.add('flush');

      var deck = { title: '未命名簡報', slides: [blank('title')] };
      var cur = 0;
      var selId = null;          // the selected object on the current slide
      var path = null;
      /* The mtime of `path` as this window last saw it, handed back on save so
         the sandbox can refuse to replace a version this window never had.
         Null means no claim: a new deck, or one whose version is unknown. */
      var pathMtime = null;
      var dirty = false;
      var undoStack = [];
      var redoStack = [];
      var UNDO_LIMIT = 40;

      /* Deck-wide typeface. The layout's title and body are not per-character
         typography, so this is one setting for the whole deck; objects carry
         their own point size, which is why the scale below does not touch them. */
      var deckFont = '微軟正黑體';
      var deckScale = 100;   // percent, so a deck can be made readable from the back

      /* ---------------------------------------------------------- chrome */

      var bar = el('div', 'sl-bar');
      var nameTag = el('span', 'sl-name', deck.title);
      var layoutSel = el('select', 'sl-layout');
      layoutSel.setAttribute('aria-label', '版面');
      Object.keys(LAYOUTS).forEach(function (k) {
        var o = el('option', null, LAYOUTS[k]);
        o.value = k;
        layoutSel.appendChild(o);
      });
      var fontSel = el('select', 'sl-font');
      fontSel.setAttribute('aria-label', '字型');
      fontSel.title = '整份簡報的字型，放映與匯出的 HTML 都會用';
      AIOS.fonts.fillSelect(fontSel);
      fontSel.value = deckFont;

      var scaleSel = el('select', 'sl-scale');
      scaleSel.setAttribute('aria-label', '字級比例');
      scaleSel.title = '版面文字的字級比例（物件有自己的點數）';
      [80, 90, 100, 115, 130, 150, 175, 200].forEach(function (n) {
        var o = el('option', null, n + '%');
        o.value = String(n);
        scaleSel.appendChild(o);
      });
      scaleSel.value = String(deckScale);

      function button(label, cls, title) {
        var b = el('button', 'fbtn' + (cls ? ' ' + cls : ''), label);
        b.type = 'button';
        if (title) b.title = title;
        return b;
      }

      var btnAdd = button('\u002b 頁');
      var btnDel = button('\u2212 頁');
      var btnUp = button('\u2191', null, '這頁往前移');
      var btnDown = button('\u2193', null, '這頁往後移');
      var btnUndo = button('\u21b6', null, '復原 (Ctrl+Z)');
      var btnRedo = button('\u21b7', null, '重做 (Ctrl+Y)');
      var btnPlay = button('\u25b6 放映', 'fbtn-primary');
      var btnSave = button('儲存', null, '儲存 (Ctrl+S)');
      var btnSaveAs = button('另存', null,
        '另存新檔 (Ctrl+Shift+S)。副檔名決定格式：.aiosdeck / .pptx / .pdf / .html / .md');
      /* One export button rather than three. Three labels wide enough to say what
         they do pushed the row onto a second line as soon as the deck had a name
         of normal length, and a toolbar with one lonely button on its second row
         is the sort of thing that reads as unfinished. */
      var btnExport = button('匯出…', null, 'Markdown、單一 HTML 或 PDF');
      [nameTag, layoutSel, fontSel, scaleSel, btnAdd, btnDel, btnUp, btnDown,
       btnUndo, btnRedo, btnPlay, btnSave, btnSaveAs, btnExport]
        .forEach(function (n) { bar.appendChild(n); });
      ctx.body.appendChild(bar);

      /* The insert row. Kept out of the row above because that one is already at
         its width, and because these belong together: this is the "insert" tab of
         a ribbon, plus the handful of controls that only make sense once
         something is selected. */
      var bar2 = el('div', 'sl-bar sl-bar2');
      var insTag = el('span', 'sl-group-tag', '插入');
      var btnTable = button('\u25a6 表格', null, '選格數插入表格');
      var btnImage = button('\u25a3 圖片', null, '從沙箱選一張圖，或從電腦匯入');
      var btnShape = button('\u25c6 圖案', null, '從圖庫選一個圖案');
      var btnBox = button('\u25ad 文字方塊', null, '在投影片上放一個可以自由擺放的文字方塊');
      /* 圖表 sits at the end of the insert group because it is the one insert
         that asks a question first: the panel wants the numbers before there is
         anything to place. */
      var btnChart = button('\u25d4 圖表', null, '插入一張圖表：先填資料，再挑類型');
      var objBar = el('span', 'sl-objbar');
      [insTag, btnTable, btnImage, btnShape, btnBox, btnChart, objBar].forEach(function (n) { bar2.appendChild(n); });
      ctx.body.appendChild(bar2);

      var split = el('div', 'sl-split');
      var rail = el('div', 'sl-rail');
      rail.setAttribute('aria-label', '頁面縮圖');
      var stage = el('div', 'sl-stage');
      stage.tabIndex = 0;
      split.appendChild(rail);
      split.appendChild(stage);
      ctx.body.appendChild(split);

      var status = el('div', 'sl-status');
      ctx.body.appendChild(status);

      /* ------------------------------------------------------ slide model */

      function slide() { return deck.slides[cur]; }

      function objects(i) {
        var s = deck.slides[i === undefined ? cur : i];
        if (!s) return [];
        if (!Array.isArray(s.objects)) s.objects = [];
        return s.objects;
      }

      function findObj(id) {
        return objects().filter(function (o) { return o.id === id; })[0] || null;
      }

      function selected() { return selId ? findObj(selId) : null; }

      /* ------------------------------------------------- type and colour */

      function cqh(pt) { return (Number(pt) / PT_PER_CQH).toFixed(3) + 'cqh'; }

      /**
       * The ink for an object's text.
       *
       * An explicit colour wins. Otherwise a filled object gets whichever of the
       * two inks can actually be read on that fill -- the automatic half of the
       * rule that a pale label on a pale button is unreadable, applied here so it
       * cannot be got wrong by accident. An unfilled object inherits the slide's
       * own text colour, where there is nothing to contrast against.
       */
      function inkFor(o, fill) {
        if (o.colour) return '#' + o.colour;
        var auto = AIOS.palette.readableOn(fill === undefined ? o.fill : fill);
        return auto || 'inherit';
      }

      /* ---------------------------------------------------- the renderer */

      var VJUST = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };
      var HJUST = { left: 'flex-start', center: 'center', right: 'flex-end' };
      /* The same two axes for a chart, as preserveAspectRatio: where the drawing
         sits in its box while the two disagree in shape, which is only during a
         resize, before the drawing is made again. */
      var XFIT = { left: 'xMin', center: 'xMid', right: 'xMax' };
      var YFIT = { top: 'YMin', middle: 'YMid', bottom: 'YMax' };

      /**
       * A slide as DOM.
       *
       * mode 'edit' wires the editable regions and the selection affordances;
       * mode 'view' produces the same geometry with nothing interactive, which is
       * what the thumbnails, the projection and both exports use.
       */
      function buildSlide(s, mode) {
        var canvas = el('div', 'sl-canvas layout-' + s.layout);
        canvas.style.fontFamily = AIOS.fonts.cssFor(deckFont);
        // Read by every type size in the stylesheet, so one deck-wide knob scales
        // the layout text in all four contexts including the exports.
        canvas.style.setProperty('--sl-k', String(deckScale / 100));

        /* The layout's text sits in its own inset box, and the slide itself keeps
           no padding. That is not cosmetic: container query units resolve against
           the container's content box, so padding on the slide would shrink the
           box every type size is a percentage of, and a "24pt" heading would come
           out at 19pt. The object layer spans the whole slide, edge to edge. */
        if (s.layout !== 'blank') {
          var flow = el('div', 'sl-flow');
          flow.appendChild(buildTitle(s, mode));
          flow.appendChild(buildBody(s, mode));
          canvas.appendChild(flow);
        }
        canvas.appendChild(buildObjectLayer(s, mode));
        return canvas;
      }

      function buildTitle(s, mode) {
        var title = el('div', 'sl-title');
        title.textContent = s.title;
        if (mode !== 'edit') return title;

        title.contentEditable = 'true';
        title.spellcheck = false;
        title.dataset.placeholder = '標題';
        title.setAttribute('aria-label', '這一頁的標題');
        title.addEventListener('input', function () {
          s.title = title.textContent;
          markDirty();
          renderThumb(cur);
        });
        return title;
      }

      function buildBody(s, mode) {
        var wrap = el('div', 'sl-body');
        var parts = s.layout === 'two' ? 2 : 1;
        for (var p = 0; p < parts; p++) {
          (function (index) {
            var col = el('div', 'sl-col');
            var area = el('div', 'sl-text');

            if (mode === 'edit') {
              area.contentEditable = 'true';
              area.spellcheck = false;
              area.setAttribute('aria-label', '內容' + (parts > 1 ? ' 第 ' + (index + 1) + ' 欄' : ''));
              area.textContent = s.body[index] || '';
              area.addEventListener('input', function () {
                s.body[index] = area.textContent;
                markDirty();
                renderThumb(cur);
              });
            } else {
              /* Read-only, so the lines become real list items or paragraphs.
                 The editor keeps them as one editable block of plain text, which
                 is the only way editing bullet lists stays sane. */
              var lines = String(s.body[index] || '').split('\n')
                .filter(function (l) { return l.trim(); });
              if (s.layout === 'bullets' || s.layout === 'two') {
                var ul = el('ul');
                lines.forEach(function (l) {
                  ul.appendChild(el('li', null, l.replace(/^[-*]\s*/, '')));
                });
                area.appendChild(ul);
              } else {
                lines.forEach(function (l) { area.appendChild(el('p', null, l)); });
              }
            }
            col.appendChild(area);
            wrap.appendChild(col);
          })(p);
        }
        return wrap;
      }

      function buildObjectLayer(s, mode) {
        var layer = el('div', 'sl-objects');
        (s.objects || []).forEach(function (o) {
          layer.appendChild(buildObject(o, mode, s));
        });
        return layer;
      }

      /**
       * One object.
       *
       * Position and appearance are inline style, not classes. That is what lets
       * the exports be a serialisation of this node: the HTML file and the PDF
       * both land somewhere os.css does not reach, and a second stylesheet
       * describing the same objects would be the drift this function exists to
       * prevent.
       */
      function buildObject(o, mode, s) {
        var box = el('div', 'sl-obj sl-obj-' + o.kind);
        box.dataset.id = o.id;
        box.style.position = 'absolute';
        box.style.left = o.x + '%';
        box.style.top = o.y + '%';
        box.style.width = o.w + '%';
        box.style.height = o.h + '%';
        box.style.boxSizing = 'border-box';

        if (o.kind === 'text') box.appendChild(buildTextObject(o, mode, s));
        else if (o.kind === 'shape') box.appendChild(buildShapeObject(o, mode, s));
        else if (o.kind === 'image') box.appendChild(buildImageObject(o, mode));
        else if (o.kind === 'chart') box.appendChild(buildChartObject(o, mode));
        else box.appendChild(buildTableObject(o, mode, s));

        if (mode === 'edit') {
          box.style.cursor = 'move';

          /* A ring of four thin strips straddling the object's edge: this is where
             it is picked up and moved. An object whose body is editable -- a table,
             a text box -- cannot be dragged by its body, because a press there is a
             caret or the start of a cell range. Without somewhere to grab, the only
             handles were the eight that resize, and a table was very hard to move
             at all. Placed like the grips, half in and half out, so it does not
             steal any of the object's own area. */
          ['n', 'e', 's', 'w'].forEach(function (side) {
            box.appendChild(el('span', 'sl-move sl-move-' + side));
          });

          if (o.id === selId) {
            box.classList.add('on');
            // After the strips, so a corner belongs to the grip that resizes it.
            HANDLES.forEach(function (h) {
              var g = el('span', 'sl-grip sl-grip-' + h);
              g.dataset.grip = h;
              box.appendChild(g);
            });
          }
        }
        return box;
      }

      /** Shared text presentation for text boxes and shape labels. */
      function styleText(node, o, fill) {
        node.style.fontSize = cqh(o.size);
        node.style.lineHeight = '1.35';
        node.style.textAlign = o.align;
        node.style.fontWeight = o.bold ? '700' : '400';
        node.style.fontStyle = o.italic ? 'italic' : 'normal';
        node.style.color = inkFor(o, fill);
        node.style.whiteSpace = 'pre-wrap';
        node.style.wordBreak = 'break-word';
      }

      function wireEditable(node, o, read) {
        node.contentEditable = 'true';
        node.spellcheck = false;
        /* The focus ring is suppressed in os.css, not here. As an inline style it
           beat every class rule, so the marked-range outline was set and never
           drawn -- the range worked and was invisible. */
        node.addEventListener('input', function () {
          read(node.textContent);
          markDirty();
          renderThumb(cur);
        });
        // A click that lands in the text is editing, not the start of a drag.
        node.addEventListener('pointerdown', function (e) {
          if (o.id === selId) e.stopPropagation();
        });
      }

      function buildTextObject(o, mode, s) {
        var t = el('div', 'sl-obj-body');
        t.style.width = '100%';
        t.style.height = '100%';
        t.style.boxSizing = 'border-box';
        t.style.padding = '1.5% 2.5%';
        t.style.display = 'flex';
        t.style.flexDirection = 'column';
        t.style.justifyContent = VJUST[o.valign];
        t.style.overflow = 'hidden';
        if (o.fill) t.style.background = '#' + o.fill;
        if (o.stroke) t.style.border = '0.28cqh solid #' + o.stroke;
        if (o.fill || o.stroke) t.style.borderRadius = '0.8cqh';
        styleText(t, o, o.fill);

        var line = el('div', null, o.text);
        line.style.width = '100%';
        t.appendChild(line);

        if (mode === 'edit') {
          if (!o.text) line.dataset.placeholder = '文字';
          line.classList.add('sl-obj-edit');
          wireEditable(line, o, function (v) { o.text = v; });
        }
        return t;
      }

      function buildShapeObject(o, mode, s) {
        var def = SHAPES[o.shape] || SHAPES.rect;
        var outer = el('div', 'sl-obj-shape');
        outer.style.position = 'relative';
        outer.style.width = '100%';
        outer.style.height = '100%';
        outer.style.background = o.stroke ? '#' + o.stroke : 'transparent';
        if (def.clip) outer.style.clipPath = def.clip;
        if (def.radius) outer.style.borderRadius = def.radius;

        var inner = el('div', 'sl-obj-body');
        inner.style.position = 'absolute';
        inner.style.inset = o.stroke ? '0.4cqh' : '0';
        inner.style.background = o.fill ? '#' + o.fill : 'transparent';
        if (def.clip) inner.style.clipPath = def.clip;
        if (def.radius) inner.style.borderRadius = def.radius;
        inner.style.display = 'flex';
        inner.style.alignItems = VJUST[o.valign];
        inner.style.justifyContent = HJUST[o.align];
        inner.style.padding = '5%';
        inner.style.boxSizing = 'border-box';
        inner.style.overflow = 'hidden';
        styleText(inner, o, o.fill);

        var line = el('div', null, o.text);
        line.style.maxWidth = '100%';
        inner.appendChild(line);
        outer.appendChild(inner);

        if (mode === 'edit') {
          if (!o.text) line.dataset.placeholder = '\u00a0';
          line.classList.add('sl-obj-edit');
          wireEditable(line, o, function (v) { o.text = v; });
        }
        return outer;
      }

      function buildImageObject(o, mode) {
        if (!o.src) return imageNote(o, '還沒選圖片');

        var img = el('img', 'sl-obj-img');
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.display = 'block';
        img.style.objectFit = o.fit;
        /* Where the picture sits inside its box. It matters for two of the three
           fits and for opposite reasons: with 完整顯示 the box is larger than the
           picture and this picks which edge it hugs, with 填滿裁切 the picture is
           larger and this picks which part survives. 拉伸 fills exactly, so it has
           nothing to place. */
        img.style.objectPosition = (o.align === 'left' ? 'left' : o.align === 'right' ? 'right' : 'center') +
          ' ' + (o.valign === 'top' ? 'top' : o.valign === 'bottom' ? 'bottom' : 'center');
        if (o.round) img.style.borderRadius = '2cqh';
        if (o.stroke) img.style.border = '0.28cqh solid #' + o.stroke;
        img.style.boxSizing = 'border-box';
        img.alt = o.alt || '';
        img.draggable = false;

        var ready = /^data:/i.test(o.src) ? o.src : AIOS.images.peek(o.src);
        if (ready) {
          img.src = ready;
        } else {
          /* Not cached yet, so the node goes in without bytes and fills itself.
             Every later render of this picture -- thumbnail, projection, export --
             finds it in the cache and is synchronous. */
          img.style.background = 'rgba(127,127,127,.12)';
          AIOS.images.dataUrl(o.src).then(function (r) {
            if (!img.isConnected) return;
            if (!r.ok) {
              var note = imageNote(o, r.error);
              if (img.parentNode) img.parentNode.replaceChild(note, img);
              return;
            }
            img.src = r.url;
            img.style.background = '';
          });
        }
        return img;
      }

      /** A picture that cannot be shown says so, on the slide, at its own size. */
      function imageNote(o, why) {
        var box = el('div', 'sl-obj-body');
        box.style.width = '100%';
        box.style.height = '100%';
        box.style.boxSizing = 'border-box';
        box.style.display = 'flex';
        box.style.flexDirection = 'column';
        box.style.alignItems = 'center';
        box.style.justifyContent = 'center';
        box.style.gap = '0.6cqh';
        box.style.padding = '4%';
        box.style.border = '0.3cqh dashed rgba(127,127,127,.55)';
        box.style.borderRadius = '1cqh';
        box.style.fontSize = '2.2cqh';
        box.style.textAlign = 'center';
        box.style.overflow = 'hidden';
        box.style.color = 'inherit';
        box.style.opacity = '.75';
        box.appendChild(el('div', null, '\u25a3 ' + (o.alt || '圖片')));
        box.appendChild(el('div', null, why));
        if (o.src) {
          var p = el('div', null, String(o.src).split('/').pop());
          p.style.fontSize = '1.7cqh';
          p.style.opacity = '.8';
          box.appendChild(p);
        }
        return box;
      }

      function buildTableObject(o, mode, s) {
        var tbl = el('table', 'sl-obj-table');
        tbl.style.width = '100%';
        tbl.style.height = '100%';
        tbl.style.margin = '0';
        tbl.style.borderCollapse = 'collapse';
        tbl.style.tableLayout = 'fixed';
        tbl.style.fontSize = cqh(o.size);
        tbl.style.lineHeight = '1.3';

        // Which cells span and which are swallowed, answered once per draw.
        var mm = AIOS.grid.map(o.merges);
        var picked = mode === 'edit' && cellSel && cellSel.id === o.id ? cellSel : null;

        var border = '0.16cqh solid #' + (o.stroke || '8FA3B8');
        o.rows.forEach(function (row, r) {
          var tr = document.createElement('tr');
          row.forEach(function (cell, c) {
            // A covered cell produces no node; that is what colSpan means, and it
            // is why the exports and the PDF need to know nothing about merges.
            if (mm.coveredBy[AIOS.grid.key(c, r)]) return;

            var head = o.header && r === 0;
            var td = document.createElement(head ? 'th' : 'td');
            var span = mm.masterAt[AIOS.grid.key(c, r)];
            if (span) {
              if (span.c1 > span.c0) td.colSpan = span.c1 - span.c0 + 1;
              if (span.r1 > span.r0) td.rowSpan = span.r1 - span.r0 + 1;
            }
            if (mode === 'edit') {
              td.dataset.r = String(r);
              td.dataset.c = String(c);
              // The cell range a merge would act on, marked so it is visible.
              if (picked && c >= picked.c0 && c <= picked.c1 &&
                  r >= picked.r0 && r <= picked.r1 &&
                  (picked.c0 !== picked.c1 || picked.r0 !== picked.r1)) {
                td.classList.add('ui-cellsel');
              }
            }
            td.style.border = border;
            /* A cell's own borders, over the object's uniform stroke. In cqh, not
               pixels: everything on a slide is a fraction of its height, and a
               border in pixels would be the one thing that did not shrink with the
               thumbnail. */
            var cst = AIOS.grid.table.styleAt(o, c, r);
            if (cst.border) {
              AIOS.borders.paint(td, cst.border, { unit: 'cqh', ptPerUnit: PT_PER_CQH });
            }
            td.style.padding = '0.7cqh 1cqh';
            td.style.textAlign = head ? 'center' : o.align;
            // A table row is often taller than its text, so where the text sits in
            // the cell is a real choice rather than a detail. It used to be pinned
            // to middle, which meant a table was the one object with no vertical
            // alignment control at all.
            td.style.verticalAlign = o.valign === 'top' ? 'top'
              : o.valign === 'bottom' ? 'bottom' : 'middle';
            td.style.overflow = 'hidden';
            td.style.wordBreak = 'break-word';
            td.style.fontWeight = head || o.bold ? '600' : '400';
            if (head) {
              td.style.background = o.fill ? '#' + o.fill : 'transparent';
              td.style.color = inkFor(o, o.fill);
            } else {
              td.style.color = o.colour ? '#' + o.colour : 'inherit';
              /* Banding mixed from currentColor rather than a fixed grey, so the
                 same table reads on a dark slide and on a printed white page. */
              if (o.banded && (r - (o.header ? 1 : 0)) % 2 === 1) {
                td.style.background = 'color-mix(in srgb, currentColor 9%, transparent)';
              }
            }
            // A cell's own shading beats both the header fill and the banding: it
            // was asked for explicitly and they were not.
            if (cst.bg) {
              td.style.background = '#' + cst.bg;
              td.style.color = AIOS.palette.readableOn(cst.bg);
            }
            td.textContent = cell;
            if (mode === 'edit') {
              td.classList.add('sl-obj-edit');
              td.title = '拖過相鄰的格子可以選一個範圍，選了範圍才能合併或畫框線';
              wireEditable(td, o, function (v) { o.rows[r][c] = v; });
            }
            tr.appendChild(td);
          });
          tbl.appendChild(tr);
        });

        /* Press and drag across cells to select a range; a plain click still puts
           the caret in. Attached to the table rather than to each cell, so it also
           works while the pointer is over a cell the drag never started in. */
        if (mode === 'edit') {
          AIOS.cellPicker(tbl, {
            onSelect: function (rect) { takeCellRect(o, rect); }
          });
        }
        return tbl;
      }

      /**
       * A chart object: the shared renderer's <svg>, in this object's box.
       *
       * The drawing is laid out in a viewBox 640 units wide and as tall as the
       * box's own shape -- o.w percent of a 16:9 slide's width by o.h percent
       * of its height -- and fills the box at 100% both ways. So one drawing
       * serves the stage, the thumbnail, the projection and both exports, and
       * a resize needs no rebuild until the gesture ends. Type is o.size
       * points on a 540pt slide: the box is o.h / 100 * 540 points tall and VH
       * units tall, so one point is VH / (o.h * PT_PER_CQH) units. The ink is
       * the slide's own colour and the series colours the slide's variables,
       * unless the chart has a fill of its own -- then both are chosen against
       * that fill, inline, so the choice travels into the exports with it.
       */
      function buildChartObject(o, mode) {
        var VH = Math.round(640 * (o.h * 9) / (o.w * 16));
        var svg = AIOS.charts.render(o.chart, {
          width: 640,
          height: VH,
          font: AIOS.fonts.cssFor(deckFont),
          fontSize: o.size * VH / (o.h * PT_PER_CQH),
          surface: o.fill ? '#' + o.fill : '',
          preserve: XFIT[o.align] + YFIT[o.valign] + ' meet'
        });
        if (o.fill || o.colour) svg.style.color = inkFor(o, o.fill);
        if (o.fill) {
          var steps = AIOS.charts.luminanceOf(o.fill) > 0.184
            ? AIOS.charts.COLOURS : AIOS.charts.COLOURS_DARK;
          steps.forEach(function (hex, k) {
            svg.style.setProperty('--ch-' + (k + 1), '#' + hex);
          });
        }
        return svg;
      }

      /**
       * Draw a chart object again in place, once its box has changed shape.
       *
       * The viewBox follows the box, so a resize leaves the drawing with its
       * old proportions until it is made again. One node is replaced, never the
       * slide: a full render mid-gesture would hand the pointer a detached
       * element, and this runs when the gesture ends.
       */
      function refreshChart(o, boxEl) {
        var old = boxEl ? boxEl.querySelector(':scope > svg') : null;
        if (old) boxEl.replaceChild(buildChartObject(o, 'edit'), old);
      }

      /* ------------------------------------------------- table cell range ---

         Which cells inside a table object the next table command acts on. Held
         apart from the object selection because it is a second, finer cursor: the
         object toolbar acts on the whole table, the context menu acts on these
         cells. Shift+click sets the far corner, the way it does in a spreadsheet.
      */
      var cellSel = null;

      function tableSize(o) { return AIOS.grid.table.size(o); }

      function setCellSel(o, c, r) {
        cellSel = { id: o.id, c0: c, c1: c, r0: r, r1: r };
        paintCellSel();
      }

      /**
       * Adopt a rectangle the picker measured from its own anchor.
       *
       * The anchor is the picker's, not this range's first corner: once a range
       * has grown over a merged region its corner is no longer where the finger
       * went down, so measuring from it means a drag cannot shrink again.
       */
      function takeCellRect(o, rect) {
        // A range never holds half a merged region, for the same reason a
        // spreadsheet's does not: there is no meaning for two thirds of one cell.
        var grown = AIOS.grid.grow(o.merges, rect);
        cellSel = { id: o.id, c0: grown.c0, c1: grown.c1, r0: grown.r0, r1: grown.r1 };
        /* Through selectObject, not by assigning selId. Assigning it left the
           object selected as far as every command was concerned while the outline
           and the eight grips were never drawn -- selectObject returns early when
           the id already matches, and this ran first. */
        selectObject(o.id);
        paintCellSel();
      }

      /** Repaint the range marks in place; rebuilding would drop the caret. */
      function paintCellSel() {
        var host = stage.querySelector('.sl-obj-table');
        [].forEach.call(stage.querySelectorAll('.ui-cellsel'), function (n) {
          n.classList.remove('ui-cellsel');
        });
        if (!host || !cellSel) return;
        var wide = cellSel.c0 !== cellSel.c1 || cellSel.r0 !== cellSel.r1;
        if (!wide) return;
        [].forEach.call(host.querySelectorAll('td[data-r], th[data-r]'), function (td) {
          var c = Number(td.dataset.c);
          var r = Number(td.dataset.r);
          if (c >= cellSel.c0 && c <= cellSel.c1 && r >= cellSel.r0 && r <= cellSel.r1) {
            td.classList.add('ui-cellsel');
          }
        });
      }

      /** The cell range for a command, defaulting to the one cell clicked. */
      function cellRangeFor(o, at) {
        if (cellSel && cellSel.id === o.id) return cellSel;
        return { c0: at.c, c1: at.c, r0: at.r, r1: at.r };
      }

      /**
       * Every table command, run as one undo step against one table object.
       *
       * The row and column arithmetic is AIOS.grid.table's, shared with the
       * document's table block: the two used to be able to disagree about what
       * deleting a row does to a merge, and now they cannot.
       */
      function tableOp(o, label, fn) {
        try {
          edit(function () { fn(o); });
          if (cellSel && cellSel.id === o.id) {
            // The grid moved under it, so clamp rather than keep a stale corner.
            var n = tableSize(o);
            cellSel.c1 = Math.min(cellSel.c1, n.cols - 1);
            cellSel.r1 = Math.min(cellSel.r1, n.rows - 1);
            cellSel.c0 = Math.min(cellSel.c0, cellSel.c1);
            cellSel.r0 = Math.min(cellSel.r0, cellSel.r1);
            paintCellSel();
          }
          if (label) ctx.toast(label, 't-ok');
        } catch (e) {
          ctx.toast(e.message, 't-warn');
        }
      }

      /* ------------------------------------------------------- rendering */

      function thumbMini(s) {
        var mini = el('div', 'sl-thumb-mini');
        mini.appendChild(buildSlide(s, 'view'));
        return mini;
      }

      /**
       * The thumbnail rail: real miniatures, drawn by the same builder.
       *
       * A div with role=button rather than a <button>, because a button may only
       * contain phrasing content and a miniature slide contains a table. The
       * miniature is hidden from assistive technology and the label carries the
       * slide's title instead, which is the useful thing to hear.
       */
      function renderRail() {
        rail.innerHTML = '';
        deck.slides.forEach(function (s, i) {
          var t = el('div', 'sl-thumb' + (i === cur ? ' on' : ''));
          t.setAttribute('role', 'button');
          t.tabIndex = 0;
          t.setAttribute('aria-label', '第 ' + (i + 1) + ' 頁：' +
            (s.title || LAYOUTS[s.layout] || '無標題'));
          t.appendChild(el('span', 'sl-thumb-n', String(i + 1)));
          var mini = thumbMini(s);
          mini.setAttribute('aria-hidden', 'true');
          t.appendChild(mini);
          t.addEventListener('click', function () { goto(i); });
          t.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goto(i); }
          });
          rail.appendChild(t);
        });
      }

      /** Repaint one thumbnail. Typing must not rebuild sixty of them. */
      function renderThumb(i) {
        var t = rail.children[i];
        if (!t) return;
        var old = t.querySelector('.sl-thumb-mini');
        if (!old) return;
        t.replaceChild(thumbMini(deck.slides[i]), old);
      }

      function renderStage() {
        stage.innerHTML = '';
        var s = slide();
        if (!s) return;

        var canvas = buildSlide(s, 'edit');
        canvas.addEventListener('pointerdown', onCanvasPointerDown);
        stage.appendChild(canvas);

        var notesWrap = el('div', 'sl-notes');
        notesWrap.appendChild(el('label', 'sl-notes-label', '講者備忘（放映時只有你看得到）'));
        var notes = el('textarea', 'sl-notes-input');
        notes.rows = 3;
        notes.value = s.notes || '';
        notes.setAttribute('aria-label', '講者備忘');
        notes.addEventListener('input', function () { s.notes = notes.value; markDirty(); });
        notesWrap.appendChild(notes);
        stage.appendChild(notesWrap);

        layoutSel.value = s.layout;
      }

      function render() {
        if (selId && !findObj(selId)) selId = null;
        renderRail();
        renderStage();
        syncBars();
        publish();
      }

      /* Split from syncBars because a drag calls it on every pointermove: the
         status line is text, while the object toolbar is a dozen elements that
         must not be torn down and rebuilt sixty times a second. */
      function syncStatus() {
        var o = selected();
        status.textContent = (path || '（未儲存的新簡報）') +
          '　·　第 ' + (cur + 1) + ' / ' + deck.slides.length + ' 頁' +
          '　·　物件 ' + objects().length + ' 個' +
          (o ? '　·　已選 ' + KINDS[o.kind] + '　' +
               Math.round(o.x) + '%, ' + Math.round(o.y) + '%　' +
               Math.round(o.w) + '×' + Math.round(o.h) + '%'
             : '');
      }

      function syncBars() {
        nameTag.textContent = deck.title + (dirty ? ' \u25cf' : '');
        btnUndo.disabled = !undoStack.length;
        btnRedo.disabled = !redoStack.length;
        btnDel.disabled = deck.slides.length <= 1;
        btnUp.disabled = cur <= 0;
        btnDown.disabled = cur >= deck.slides.length - 1;
        renderObjBar();
        syncStatus();
      }

      function goto(i) {
        cur = Math.max(0, Math.min(deck.slides.length - 1, i));
        selId = null;
        render();
      }

      function markDirty() {
        dirty = true;
        nameTag.textContent = deck.title + ' \u25cf';
        ctx.save();
      }

      /* ------------------------------------------------------ deck edits */

      function snapshot() {
        undoStack.push(JSON.stringify(deck));
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
        redoStack.length = 0;
      }

      /**
       * Every direct-manipulation edit goes through here: one undo step, one
       * render, one save. A change that throws part-way is rolled back and leaves
       * no step behind, so the deck is never half-edited and Ctrl+Z never lands on
       * a state nobody asked for.
       */
      function edit(fn) {
        var before = JSON.stringify(deck);
        snapshot();
        var out;
        try {
          out = fn();
        } catch (e) {
          adopt(JSON.parse(before));
          undoStack.pop();
          render();
          throw e;
        }
        markDirty();
        render();
        return out;
      }

      function adopt(d) {
        deck = d;
        deck.slides = (deck.slides || []).map(normSlide);
        if (!deck.slides.length) deck.slides = [blank('title')];
        cur = Math.max(0, Math.min(cur, deck.slides.length - 1));
        selId = null;
      }

      function undo() {
        if (!undoStack.length) return;
        redoStack.push(JSON.stringify(deck));
        adopt(JSON.parse(undoStack.pop()));
        markDirty();
        render();
      }

      function redo() {
        if (!redoStack.length) return;
        undoStack.push(JSON.stringify(deck));
        adopt(JSON.parse(redoStack.pop()));
        markDirty();
        render();
      }

      function setSlide(i, spec) {
        var s = deck.slides[i];
        if (!s) throw new Error('沒有第 ' + (i + 1) + ' 頁（共 ' + deck.slides.length + ' 頁）');
        if (spec.layout && LAYOUTS[spec.layout]) s.layout = spec.layout;
        if (spec.title !== undefined) s.title = String(spec.title);
        if (spec.body !== undefined) s.body = normBody(spec.body, s.layout);
        if (spec.notes !== undefined) s.notes = String(spec.notes);
        if (spec.objects !== undefined) s.objects = normObjects(spec.objects);
        cur = i;
        selId = null;
        markDirty();
        render();
      }

      function addSlide(at, spec) {
        spec = spec || {};
        var s = normSlide(spec);
        if (at === null || at === undefined || at > deck.slides.length) {
          deck.slides.push(s);
          cur = deck.slides.length - 1;
        } else {
          deck.slides.splice(Math.max(0, at), 0, s);
          cur = Math.max(0, at);
        }
        selId = null;
        markDirty();
        render();
      }

      function deleteSlide(i) {
        if (deck.slides.length <= 1) throw new Error('至少要留一頁');
        if (i < 0 || i >= deck.slides.length) throw new Error('沒有第 ' + (i + 1) + ' 頁');
        deck.slides.splice(i, 1);
        cur = Math.min(cur, deck.slides.length - 1);
        selId = null;
        markDirty();
        render();
      }

      function moveSlide(from, to) {
        var n = deck.slides.length;
        if (from < 0 || from >= n) throw new Error('沒有第 ' + (from + 1) + ' 頁');
        var dest = Math.max(0, Math.min(n - 1, to));
        if (dest === from) return '位置沒變';
        var s = deck.slides.splice(from, 1)[0];
        deck.slides.splice(dest, 0, s);
        cur = dest;
        markDirty();
        render();
        return '第 ' + (from + 1) + ' 頁搬到第 ' + (dest + 1) + ' 頁';
      }

      function buildDeck(title, slides) {
        if (!Array.isArray(slides) || !slides.length) throw new Error('slides 是空的');
        deck = {
          title: String(title || deck.title),
          slides: slides.slice(0, 60).map(normSlide)
        };
        cur = 0;
        selId = null;
        markDirty();
        render();
        return deck.slides.length;
      }

      /* ---------------------------------------------------- object edits */

      /** Where a new object goes: centred, then stepped so a run of them fans out. */
      function placeFor(kind, spec) {
        var d = DEFAULTS[kind];
        var w = span(spec && spec.w, d.w, 2, 150);
        var h = span(spec && spec.h, d.h, 2, 150);
        var step = (objects().length % 5) * 3;
        return {
          x: spec && spec.x !== undefined ? span(spec.x, 0, -25, 120) : Math.round((100 - w) / 2) + step,
          y: spec && spec.y !== undefined ? span(spec.y, 0, -25, 120) : Math.round((100 - h) / 2) + step,
          w: w, h: h
        };
      }

      function addObject(i, spec) {
        var at = i === null || i === undefined ? cur : i;
        var s = deck.slides[at];
        if (!s) throw new Error('沒有第 ' + (at + 1) + ' 頁');
        cur = at;
        var kind = KINDS[spec && spec.kind] ? spec.kind : 'text';
        if (objects().length >= 40) throw new Error('一頁最多 40 個物件');
        // A chart's fields are checked the way addChart checks them, so the two
        // ways of asking for one refuse the same bad names.
        if (kind === 'chart') spec = Object.assign({}, spec, { chart: chartFromArgs(spec).spec });

        var o = normObject(Object.assign({}, spec, { kind: kind }, placeFor(kind, spec)));
        objects().push(o);
        selId = o.id;
        markDirty();
        render();
        return '第 ' + (at + 1) + ' 頁加了一個' + KINDS[kind] +
               '（第 ' + objects().length + ' 個物件）';
      }

      function addTable(i, spec) {
        var s = spec || {};
        var rows = Array.isArray(s.data) && s.data.length
          ? s.data
          : normRows(null, Math.max(1, Math.min(MAX_TABLE_ROWS, Number(s.rows) || 3)),
                     Math.max(1, Math.min(MAX_TABLE_COLS, Number(s.cols) || 3)));
        return addObject(i, {
          kind: 'table', rows: rows, header: s.header,
          x: s.x, y: s.y, w: s.w, h: s.h
        });
      }

      function objectAt(i, j) {
        var s = deck.slides[i];
        if (!s) throw new Error('沒有第 ' + (i + 1) + ' 頁');
        var list = objects(i);
        var o = list[j];
        if (!o) throw new Error('第 ' + (i + 1) + ' 頁沒有第 ' + (j + 1) + ' 個物件（共 ' + list.length + ' 個）');
        return o;
      }

      /**
       * Change fields on an object in place.
       *
       * Written as a merge through normObject rather than field-by-field
       * assignment: the normaliser is the only thing that knows the valid range
       * of every field, and a second copy of that knowledge here would let the
       * chat path store values the toolbar cannot.
       */
      function patchObject(o, spec) {
        var merged = Object.assign({}, o, spec, { id: o.id, kind: o.kind });
        if (spec.data !== undefined && o.kind === 'table') merged.rows = spec.data;
        /* A chart's fields are merged into its spec rather than onto the object,
           and checked the way addChart checks them -- only when one was given,
           so a plain move never re-reads a chart it was not asked about. */
        if (o.kind === 'chart' && CHART_KEYS.some(function (k) { return spec[k] !== undefined; })) {
          merged.chart = chartFromArgs(spec, o.chart).spec;
        }
        var next = normObject(merged);
        Object.keys(o).forEach(function (k) { delete o[k]; });
        Object.assign(o, next);
        return o;
      }

      function setObject(i, j, spec) {
        var o = objectAt(i, j);
        patchObject(o, spec || {});
        cur = i;
        selId = o.id;
        markDirty();
        render();
        return '改了第 ' + (i + 1) + ' 頁的第 ' + (j + 1) + ' 個物件（' + KINDS[o.kind] + '）';
      }

      /**
       * Borders and shading on a table object, by coordinates.
       *
       * The range arithmetic is the shared one, so a border asked for in a
       * conversation lands on exactly the cells the same command from the menu
       * would have touched.
       */
      function setTableStyle(i, j, spec) {
        var s = spec || {};
        var o = objectAt(i, j);
        if (o.kind !== 'table') throw new Error('第 ' + (j + 1) + ' 個物件不是表格');
        var T = AIOS.grid.table;
        var n = tableSize(o);
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
          said.push((shade ? '網底 #' + shade : '清除網底') +
            '（' + T.applyFill(o, area, shade) + ' 格）');
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
          var pen = kind === 'none' ? null : AIOS.borders.edge({
            style: s.borderStyle || AIOS.borders.pen.style,
            width: s.borderWidth || AIOS.borders.pen.width,
            colour: AIOS.palette.require(s.borderColour, '畫筆色彩') || AIOS.borders.pen.colour
          });
          said.push('框線 ' + kind + '（' + T.applyBorder(o, area, kind, pen) + ' 格）');
        }
        if (!said.length) throw new Error('要給 border 或 fill');

        cur = i;
        selId = o.id;
        markDirty();
        render();
        return '第 ' + (i + 1) + ' 頁第 ' + (j + 1) + ' 個表格 ' +
          AIOS.grid.label(area) + '：' + said.join('、');
      }

      function deleteObject(i, j) {
        var o = objectAt(i, j);
        objects(i).splice(j, 1);
        cur = i;
        if (selId === o.id) selId = null;
        markDirty();
        render();
        return '刪掉第 ' + (i + 1) + ' 頁的第 ' + (j + 1) + ' 個物件';
      }

      /* ---------------------------------------------------- chart edits */

      /* The keys a conversation may use to say what a chart holds. Any one of
         them on a chart object means "change the chart", which is how setObject
         tells a chart edit from a plain move. */
      var CHART_KEYS = ['chart', 'type', 'title', 'rows', 'categories', 'series', 'seriesIn',
        'headerRow', 'headerCol', 'omitTotals', 'legend', 'labels', 'numFmt', 'xTitle', 'yTitle'];

      /**
       * A chart spec out of what a conversation hands over, checked.
       *
       * `chart` is a whole spec, `rows` a table read the way the editor's panel
       * reads one (heading row first), else categories + series -- the same
       * three shapes the document takes, so one vocabulary travels. A type
       * name or a series colour nobody has is refused rather than read as
       * 直條圖 and grey: a model told it succeeded has no way to find out. More
       * series than a chart holds is refused too, unless it is a stack, which
       * folds the rest into 其他 and says so.
       *
       * Returns { spec, said }: `said` is what the caller should pass on.
       */
      function chartFromArgs(s, base) {
        var raw = Object.assign({}, base || {}, s.chart && typeof s.chart === 'object' ? s.chart : {});
        var said = [];
        if (Array.isArray(s.rows)) {
          var got = AIOS.charts.fromRows(s.rows, {
            seriesIn: s.seriesIn, headerRow: s.headerRow, headerCol: s.headerCol, omitTotals: s.omitTotals
          });
          if (!got.series.length) {
            throw new Error('rows 裡沒有可以畫的數字：第一列放數列名稱，第一欄放類別，其餘的格子放數字');
          }
          raw.categories = got.categories;
          raw.series = got.series;
          if (!raw.title && got.titleHint) raw.title = got.titleHint;
          if (!raw.xTitle && got.corner) raw.xTitle = got.corner;
          if (!raw.numFmt && got.numFmtHint) raw.numFmt = got.numFmtHint;
          if (got.omitted.length) said.push('略過 ' + got.omitted.join('、'));
          if (got.skipped.length) said.push('沒有數字：' + got.skipped.join('、'));
        }
        /* After the table rather than instead of it, the way the document reads
           the same arguments: a caller that sends both meant the explicit lists,
           and a series named here is still checked rather than quietly dropped. */
        if (Array.isArray(s.categories)) raw.categories = s.categories;
        if (Array.isArray(s.series)) raw.series = s.series;
        if (s.type !== undefined) raw.type = AIOS.charts.requireType(s.type);
        if (s.legend !== undefined) {
          if (AIOS.charts.LEGENDS.indexOf(s.legend) < 0) throw new Error('legend 要是 bottom、right 或 none');
          raw.legend = s.legend;
        }
        ['title', 'labels', 'numFmt', 'xTitle', 'yTitle'].forEach(function (k) {
          if (s[k] !== undefined) raw[k] = s[k];
        });
        if (Array.isArray(raw.series)) {
          raw.series = raw.series.map(function (ser) {
            if (!ser || typeof ser !== 'object' || !ser.colour) return ser;
            return Object.assign({}, ser, { colour: AIOS.charts.requireColour(ser.colour, '數列顏色') });
          });
        }
        var over = AIOS.charts.overflow(raw);
        if (over.dropped) {
          throw new Error('最多 ' + AIOS.charts.MAX_SERIES + ' 個數列，收到 ' +
            (AIOS.charts.MAX_SERIES + over.extra) + '；改用 seriesIn:"rows"、改成堆疊圖，或減少數列');
        }
        if (over.folded) said.push('後 ' + over.folded + ' 個數列併成「其他」');
        return { spec: AIOS.charts.norm(raw), said: said };
      }

      /**
       * The box a new chart gets: what was asked for; else the shape another
       * program handed over -- 84% of the width, no taller than 70% of the
       * height, centred; else the default box and the usual stagger.
       */
      function chartGeometry(s) {
        var g = { x: s.x, y: s.y, w: s.w, h: s.h };
        var aspect = Number(s.aspect);
        if (aspect > 0 && s.w === undefined && s.h === undefined) {
          // A percentage of width and one of height are different distances on
          // a 16:9 slide, so the ratio is scaled by 16/9 -- as insertImage does.
          var w = 84;
          var h = w * 16 / (9 * aspect);
          if (h > 70) { h = 70; w = h * 9 * aspect / 16; }
          g.w = Math.round(w * 10) / 10;
          g.h = Math.round(h * 10) / 10;
          if (g.x === undefined) g.x = Math.round((100 - g.w) / 2);
          if (g.y === undefined) g.y = Math.round((100 - g.h) / 2);
        }
        return g;
      }

      /**
       * A chart on a slide, the way a conversation asks for one.
       *
       * With newSlide a blank page goes in after the one named, titled with the
       * chart's title, and the chart lands there: what another program's
       * 插入到簡報 asks for, and what "a slide with this chart" means.
       */
      function addChart(i, spec) {
        var s = spec || {};
        var at = i === null || i === undefined ? cur : i;
        if (!deck.slides[at]) throw new Error('沒有第 ' + (at + 1) + ' 頁（共 ' + deck.slides.length + ' 頁）');
        var made = chartFromArgs(s);
        if (!made.spec.series.length) {
          throw new Error('要給 rows（二維陣列，第一列是數列名稱、第一欄是類別）或 categories + series');
        }
        if (s.newSlide === true || s.newSlide === 'true') {
          addSlide(at + 1, { layout: 'blank', title: made.spec.title });
          at += 1;
        }
        var note = addObject(at, Object.assign({ kind: 'chart', chart: made.spec }, chartGeometry(s)));
        return note + '：' + AIOS.charts.describe(made.spec) +
               (made.said.length ? '（' + made.said.join('；') + '）' : '');
      }

      /**
       * The object a chart command means: the one numbered; else the selected
       * one, when it is of that kind; else the last of that kind on the slide.
       */
      function pickObject(i, j, kind) {
        if (!deck.slides[i]) throw new Error('沒有第 ' + (i + 1) + ' 頁');
        if (j !== null && j !== undefined) return objectAt(i, j);
        var sel = i === cur ? selected() : null;
        if (sel && sel.kind === kind) return sel;
        var last = objects(i).filter(function (o) { return o.kind === kind; }).pop();
        if (!last) throw new Error('第 ' + (i + 1) + ' 頁沒有' + KINDS[kind]);
        return last;
      }

      /** One object becomes another kind in the same place, keeping its identity and its box. */
      function swapObject(i, o, spec) {
        var list = objects(i);
        var at = list.indexOf(o);
        if (at < 0) throw new Error('物件不在第 ' + (i + 1) + ' 頁');
        var next = normObject(Object.assign({}, spec, { id: o.id, x: o.x, y: o.y, w: o.w, h: o.h }));
        list.splice(at, 1, next);
        // A cell range marked on a table that is no longer one names nothing.
        if (cellSel && cellSel.id === o.id) cellSel = null;
        cur = i;
        selId = next.id;
        markDirty();
        render();
        return next;
      }

      /**
       * A table object's rows as a chart spec.
       *
       * Read by the shared reader, so what it makes of a heading row, a
       * category column or a 合計 line is what the document and the spreadsheet
       * make of them. A covered cell of a merged region reads as its master's
       * text: a heading merged over three columns names all three, where a
       * blank would make them 數列 2 and 數列 3. A table whose first row is
       * styled as a heading is read as one; otherwise the cells decide.
       */
      function tableToChartSpec(o, extra) {
        var mm = AIOS.grid.map(o.merges);
        var rows = o.rows.map(function (row, r) {
          return row.map(function (cell, c) {
            var under = mm.coveredBy[AIOS.grid.key(c, r)];
            return under ? o.rows[under.r][under.c] : cell;
          });
        });
        var got = AIOS.charts.fromRows(rows, { headerRow: o.header ? true : undefined });
        if (!got.series.length) throw new Error('表格裡沒有可以畫的數字');
        var raw = Object.assign({
          type: 'column', title: got.titleHint, xTitle: got.corner, numFmt: got.numFmtHint
        }, extra || {}, { categories: got.categories, series: got.series });
        var said = [];
        if (got.omitted.length) said.push('略過 ' + got.omitted.join('、'));
        if (got.skipped.length) said.push('沒有數字：' + got.skipped.join('、'));
        var over = AIOS.charts.overflow(raw);
        if (over.dropped) said.push('只畫前 ' + AIOS.charts.MAX_SERIES + ' 個數列');
        if (over.folded) said.push('後 ' + over.folded + ' 個數列併成「其他」');
        return { spec: AIOS.charts.norm(raw), said: said };
      }

      function tableToChart(i, j, spec) {
        var s = spec || {};
        var at = i === null || i === undefined ? cur : i;
        var o = pickObject(at, j, 'table');
        if (o.kind !== 'table') throw new Error('第 ' + (j + 1) + ' 個物件不是表格');
        var extra = {};
        if (s.type !== undefined) extra.type = AIOS.charts.requireType(s.type);
        if (s.title !== undefined) extra.title = String(s.title);
        var made = tableToChartSpec(o, extra);
        var next = swapObject(at, o, { kind: 'chart', chart: made.spec });
        return '第 ' + (at + 1) + ' 頁的第 ' + (objects(at).indexOf(next) + 1) + ' 個物件從表格變成圖表：' +
               AIOS.charts.describe(next.chart) + (made.said.length ? '（' + made.said.join('；') + '）' : '');
      }

      function chartToTable(i, j) {
        var at = i === null || i === undefined ? cur : i;
        var o = pickObject(at, j, 'chart');
        if (o.kind !== 'chart') throw new Error('第 ' + (j + 1) + ' 個物件不是圖表');
        var rows = AIOS.charts.toRows(o.chart);
        var lost = rows.length > MAX_TABLE_ROWS || rows[0].length > MAX_TABLE_COLS;
        var next = swapObject(at, o, { kind: 'table', rows: rows, header: true });
        return '第 ' + (at + 1) + ' 頁的第 ' + (objects(at).indexOf(next) + 1) + ' 個物件從圖表變成表格（' +
               next.rows[0].length + ' 欄 × ' + next.rows.length + ' 列）' +
               (lost ? '；表格最多 ' + MAX_TABLE_COLS + ' 欄 ' + MAX_TABLE_ROWS + ' 列，多出來的沒放進去' : '');
      }

      /** Hand a chart to the document or the spreadsheet, through their own insert action. */
      async function chartToApp(i, j, app) {
        var at = i === null || i === undefined ? cur : i;
        var o = pickObject(at, j, 'chart');
        if (o.kind !== 'chart') throw new Error('第 ' + (j + 1) + ' 個物件不是圖表');
        var id = String(app || '').trim().toLowerCase();
        id = { '文件': 'docs', '試算表': 'sheets' }[id] || id;
        if (id === 'slides' || !AIOS.charts.APP_NAMES[id]) throw new Error('app 要是 docs（文件）或 sheets（試算表）');
        var out = await AIOS.charts.sendTo(id, o.chart, { aspect: (o.w * 16) / (o.h * 9) });
        // Worded as the document's chartToApp words it: where it came from, then
        // whatever the other program said about where it landed.
        return '第 ' + (at + 1) + ' 頁的圖表已插入到' + AIOS.charts.APP_NAMES[id] +
               (out && out.note ? '：' + out.note : '');
      }

      function duplicateSelected() {
        var o = selected();
        if (!o) return;
        edit(function () {
          var copy = normObject(Object.assign(JSON.parse(JSON.stringify(o)), {
            id: uid(),
            x: span(o.x + 3, o.x, -25, 120),
            y: span(o.y + 3, o.y, -25, 120)
          }));
          objects().push(copy);
          selId = copy.id;
        });
      }

      function layerSelected(dir) {
        var o = selected();
        if (!o) return;
        var list = objects();
        var at = list.indexOf(o);
        var to = Math.max(0, Math.min(list.length - 1, at + dir));
        if (to === at) return;
        edit(function () {
          list.splice(at, 1);
          list.splice(to, 0, o);
        });
      }

      /**
       * Show which object is selected, without rebuilding anything.
       *
       * Selection changes only an outline and eight grips, and a click that
       * selects is usually the start of a drag -- replacing the node under the
       * pointer mid-gesture would hand the rest of that drag to a detached
       * element. So the affordances are added and removed in place.
       */
      function paintSelection() {
        var layer = stage.querySelector('.sl-objects');
        if (!layer) return;
        [].forEach.call(layer.children, function (node) {
          var mine = node.dataset.id === selId;
          node.classList.toggle('on', mine);
          var grips = node.querySelectorAll(':scope > .sl-grip');
          if (mine && !grips.length) {
            HANDLES.forEach(function (h) {
              var g = el('span', 'sl-grip sl-grip-' + h);
              g.dataset.grip = h;
              node.appendChild(g);
            });
          } else if (!mine && grips.length) {
            [].forEach.call(grips, function (g) { g.remove(); });
          }
        });
      }

      function selectObject(id) {
        if (selId === id) return;
        selId = id;
        paintSelection();
        syncBars();
      }

      /* -------------------------------------------- direct manipulation */

      /**
       * Pointer down anywhere on the editing canvas.
       *
       * Three outcomes: a grip starts a resize, an object body starts a move or a
       * selection, and bare canvas clears the selection. Clicks that land inside
       * an object's own editable text never reach here -- that node stops the
       * event, because the second click on a selected text box means "type", not
       * "drag".
       */
      function onCanvasPointerDown(e) {
        if (e.button !== 0) return;
        var grip = e.target.closest ? e.target.closest('.sl-grip') : null;
        var boxEl = e.target.closest ? e.target.closest('.sl-obj') : null;

        if (!boxEl) {
          if (selId && !(e.target.closest && e.target.closest('.sl-title, .sl-text'))) {
            selectObject(null);
          }
          return;
        }
        var o = findObj(boxEl.dataset.id);
        if (!o) return;

        if (o.id !== selId) selectObject(o.id);

        /* A press inside a table cell selects the table and stops there. It is
           never the start of a move.
           
           It used to be: the cell's own handler stopped the event, but only once
           the object was already selected -- so the first press on an unselected
           table both selected it and started dragging it, and every press after
           that raced the cell picker. Dragging across cells moved the table
           instead of selecting them, which is why the range selection looked
           broken. The table is moved by the ring around it. */
        if (!grip && e.target.closest && e.target.closest('[data-r][data-c]')) {
          // No preventDefault: the caret is what a plain click in a cell is for.
          return;
        }

        stage.focus({ preventScroll: true });
        e.preventDefault();
        startDrag(o, boxEl, grip ? grip.dataset.grip : null, e);
      }

      /**
       * Move or resize, live.
       *
       * Geometry is written straight to the node's style during the gesture and
       * the model is updated with it; a full render per pointermove would rebuild
       * the thumbnail rail sixty times a second. The undo step is pushed on the
       * first movement rather than on pointerdown, so a click that selects
       * something does not leave an empty step behind.
       */
      function startDrag(o, boxEl, grip, e) {
        var canvas = stage.querySelector('.sl-canvas');
        if (!canvas) return;
        var rect = canvas.getBoundingClientRect();
        var from = { x: o.x, y: o.y, w: o.w, h: o.h };
        var before = JSON.stringify(deck);      // nothing has moved yet
        var sx = e.clientX;
        var sy = e.clientY;
        var pushed = false;
        var MIN = 3;

        function apply(ev) {
          var dx = (ev.clientX - sx) / rect.width * 100;
          var dy = (ev.clientY - sy) / rect.height * 100;

          if (!grip) {
            o.x = span(from.x + dx, from.x, -25, 120);
            o.y = span(from.y + dy, from.y, -25, 120);
          } else {
            var x = from.x, y = from.y, w = from.w, h = from.h;
            if (grip.indexOf('e') >= 0) w = Math.max(MIN, from.w + dx);
            if (grip.indexOf('s') >= 0) h = Math.max(MIN, from.h + dy);
            if (grip.indexOf('w') >= 0) {
              w = Math.max(MIN, from.w - dx);
              x = from.x + (from.w - w);
            }
            if (grip.indexOf('n') >= 0) {
              h = Math.max(MIN, from.h - dy);
              y = from.y + (from.h - h);
            }
            // Shift on a corner keeps the object's proportions.
            if (ev.shiftKey && grip.length === 2 && from.h > 0) {
              var ratio = from.w / from.h;
              if (Math.abs(w - from.w) > Math.abs(h - from.h)) h = w / ratio;
              else w = h * ratio;
              if (grip.indexOf('w') >= 0) x = from.x + (from.w - w);
              if (grip.indexOf('n') >= 0) y = from.y + (from.h - h);
            }
            o.x = span(x, from.x, -25, 120);
            o.y = span(y, from.y, -25, 120);
            o.w = span(w, from.w, MIN, 150);
            o.h = span(h, from.h, MIN, 150);
          }
          boxEl.style.left = o.x + '%';
          boxEl.style.top = o.y + '%';
          boxEl.style.width = o.w + '%';
          boxEl.style.height = o.h + '%';
          syncStatus();
        }

        function move(ev) {
          if (!pushed) {
            undoStack.push(before);
            if (undoStack.length > UNDO_LIMIT) undoStack.shift();
            redoStack.length = 0;
            pushed = true;
          }
          apply(ev);
        }

        function up() {
          canvas.removeEventListener('pointermove', move);
          canvas.removeEventListener('pointerup', up);
          canvas.removeEventListener('pointercancel', up);
          if (pushed) {
            // A chart's drawing follows its box, so a resized one is drawn again.
            if (o.kind === 'chart') refreshChart(o, boxEl);
            markDirty();
            renderThumb(cur);
            syncBars();
          }
        }

        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* mouse without capture */ }
        canvas.addEventListener('pointermove', move);
        canvas.addEventListener('pointerup', up);
        canvas.addEventListener('pointercancel', up);
      }

      /**
       * Keyboard, for the selected object.
       *
       * Bound at the window rather than at the stage so it also fires while a
       * table cell has focus, and gated on whether the caret is in editable text:
       * Delete inside a cell deletes a character, and only outside it deletes the
       * object.
       */
      function onKey(e) {
        if (overlay) return;                       // the projection owns the keyboard
        var live = document.activeElement;
        var typing = !!(live && live.isContentEditable) ||
                     (live && (live.tagName === 'INPUT' || live.tagName === 'TEXTAREA'));

        if (e.key === 'Escape') {
          if (typing && live.blur) live.blur();
          if (selId) { e.preventDefault(); selectObject(null); }
          return;
        }
        /* While the caret is in text, the keyboard belongs to the text -- including
           Ctrl+Z, whose native undo fires an input event and so keeps the model in
           step. Intercepting it here would replace "undo my typing" with "undo the
           whole last action", which is not what the caret being there means. */
        if (typing) return;

        var lower = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && lower === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
        if ((e.ctrlKey || e.metaKey) && (lower === 'y' || (lower === 'z' && e.shiftKey))) {
          e.preventDefault(); redo(); return;
        }
        /* A chart travels between the three programs on the clipboard. Paste
           needs no selection: it lands on the slide. */
        if ((e.ctrlKey || e.metaKey) && lower === 'v') { pasteChart(); return; }
        if (!selId) return;

        var picked = selected();
        if ((e.ctrlKey || e.metaKey) && lower === 'c' && picked && picked.kind === 'chart') {
          e.preventDefault(); copyChart(picked); return;
        }
        if ((e.ctrlKey || e.metaKey) && lower === 'd') { e.preventDefault(); duplicateSelected(); return; }
        if ((e.ctrlKey || e.metaKey) && e.key === ']') { e.preventDefault(); layerSelected(1); return; }
        if ((e.ctrlKey || e.metaKey) && e.key === '[') { e.preventDefault(); layerSelected(-1); return; }
        if (e.ctrlKey || e.metaKey) return;

        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          var list = objects();
          edit(function () { list.splice(list.indexOf(selected()), 1); selId = null; });
          return;
        }

        var STEP = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        var d = STEP[e.key];
        if (!d) return;
        e.preventDefault();
        var k = e.shiftKey ? 5 : 0.5;
        var o = selected();
        edit(function () {
          o.x = span(o.x + d[0] * k, o.x, -25, 120);
          o.y = span(o.y + d[1] * k, o.y, -25, 120);
        });
      }

      /* --------------------------------------------------- insert popovers */

      /* The panel itself is AIOS.popover, shared with the other document
         programs; these two are just the local spelling. */
      function closePop() { AIOS.popover.close(ctx.body); }

      function popover(anchor, build, cls) {
        return AIOS.popover(ctx.body, anchor, build, cls).el;
      }

      function popLabel(pop, text) { AIOS.popover.label(pop, text); }

      /**
       * The table size grid.
       *
       * Hover-to-size, the way every office suite does it, because picking 3x4
       * from a grid is one gesture and typing two numbers into a dialog is four.
       */
      function tablePicker(anchor) {
        popover(anchor, function (p) {
          popLabel(p, '插入表格');
          var read = el('div', 'ui-tgrid-read', '拖過去選格數');
          var grid = el('div', 'ui-tgrid-grid');
          var cells = [];
          for (var r = 1; r <= 8; r++) {
            for (var c = 1; c <= MAX_TABLE_COLS; c++) {
              (function (rr, cc) {
                var cell = el('span', 'ui-tgrid-cell');
                cell.dataset.r = String(rr);
                cell.dataset.c = String(cc);
                cell.addEventListener('mouseenter', function () { mark(rr, cc); });
                cell.addEventListener('click', function () {
                  closePop();
                  edit(function () { addTable(cur, { rows: rr, cols: cc }); });
                });
                cells.push(cell);
                grid.appendChild(cell);
              })(r, c);
            }
          }
          function mark(rr, cc) {
            read.textContent = cc + ' 欄 × ' + rr + ' 列';
            cells.forEach(function (cell) {
              cell.classList.toggle('on',
                Number(cell.dataset.r) <= rr && Number(cell.dataset.c) <= cc);
            });
          }
          p.appendChild(read);
          p.appendChild(grid);
          p.appendChild(el('p', 'ui-pop-note', '插入後可以直接在格子裡打字，工具列會出現增減列欄的按鈕。'));
        }, 'ui-pop-wide');
      }

      function exportPicker(anchor) {
        popover(anchor, function (p) {
          popLabel(p, '匯出');
          [['PowerPoint', 'pptx', '可以在 PowerPoint 裡繼續編輯，備忘稿一起帶過去'],
           ['PDF', 'pdf', '一頁一張投影片，橫向，含頁碼'],
           ['單一 HTML', 'html', '一個檔案就能放映，圖片直接嵌進去'],
           ['Markdown', 'md', '純文字大綱，表格會變成 Markdown 表格']].forEach(function (spec) {
            var b = button(spec[0], null, spec[2]);
            b.style.width = '100%';
            b.style.textAlign = 'left';
            b.style.marginBottom = '4px';
            b.addEventListener('click', function () { closePop(); exportAs(spec[1]); });
            p.appendChild(b);
            var note = el('p', 'ui-pop-note', spec[2]);
            note.style.margin = '0 0 8px';
            p.appendChild(note);
          });
        });
      }

      function shapePicker(anchor) {
        popover(anchor, function (p) {
          popLabel(p, '圖案');
          var grid = el('div', 'sl-shape-grid');
          Object.keys(SHAPES).forEach(function (id) {
            var def = SHAPES[id];
            var b = el('button', 'sl-shape-btn');
            b.type = 'button';
            b.title = def.name;
            b.setAttribute('aria-label', def.name);
            var pv = el('span', 'sl-shape-pv');
            if (def.clip) pv.style.clipPath = def.clip;
            if (def.radius) pv.style.borderRadius = def.radius;
            b.appendChild(pv);
            b.addEventListener('click', function () {
              closePop();
              edit(function () { addObject(cur, { kind: 'shape', shape: id }); });
            });
            grid.appendChild(b);
          });
          p.appendChild(grid);
        });
      }

      async function insertImage() {
        var chosen = await AIOS.openPath({
          host: ctx.win.el,
          label: '插入圖片',
          note: '沙箱裡的圖片。支援 PNG、JPEG、GIF、WebP、BMP、AVIF；' +
                '簡報存的是圖片路徑，所以圖片留在沙箱裡就好，匯出 HTML 時才會把圖嵌進檔案。',
          filter: function (p) { return !!AIOS.images.mimeFor(p); },
          importInto: '/inbox',
          okLabel: '插入'
        });
        if (!chosen) return;

        var probe = await AIOS.images.dataUrl(chosen);
        if (!probe.ok) { ctx.toast('讀不到圖片：' + probe.error, 't-err'); return; }

        // Land at the picture's own proportions rather than a default rectangle,
        // so nothing is stretched the moment it appears.
        var geom = await new Promise(function (resolve) {
          var probeImg = new window.Image();
          probeImg.onload = function () { resolve({ w: probeImg.naturalWidth, h: probeImg.naturalHeight }); };
          probeImg.onerror = function () { resolve(null); };
          probeImg.src = probe.url;
        });

        var w = DEFAULTS.image.w;
        var h = DEFAULTS.image.h;
        if (geom && geom.w && geom.h) {
          // The canvas is 16:9, so a percentage of width and a percentage of
          // height are not the same distance: the ratio has to be scaled by 16/9.
          var ratio = (geom.w / geom.h) / (16 / 9);
          if (ratio >= 1) { w = 52; h = 52 / ratio; }
          else { h = 62; w = 62 * ratio; }
        }
        edit(function () {
          addObject(cur, {
            kind: 'image', src: chosen, fit: 'contain',
            alt: chosen.split('/').pop(),
            // One decimal, not whole percent: rounding a 180x320 picture to
            // integers leaves the box 2% wider than the picture inside it.
            w: Math.round(w * 10) / 10, h: Math.round(h * 10) / 10
          });
        });
      }

      /* ------------------------------------------------- object toolbar */

      function swatchRow(current, onPick, withAuto) {
        var row = el('div', 'ui-swatches');
        AIOS.palette.fills.forEach(function (col) {
          var b = el('button', 'ui-swatch' + (current === col.hex ? ' on' : ''));
          b.type = 'button';
          b.title = col.name;
          b.setAttribute('aria-label', col.name);
          if (col.hex) b.style.background = '#' + col.hex;
          else b.classList.add('ui-swatch-none');
          b.addEventListener('click', function () { onPick(col.hex); });
          row.appendChild(b);
        });
        if (withAuto) {
          var auto = el('button', 'ui-swatch ui-swatch-auto' + (current === '' ? ' on' : ''), 'A');
          auto.type = 'button';
          auto.title = '自動（依底色挑對比夠的字色）';
          auto.addEventListener('click', function () { onPick(''); });
          row.appendChild(auto);
        }
        return row;
      }

      /**
       * Fill, line, ink, type and alignment for the selected object.
       *
       * Anchored to whatever the live 「格式…」 button is rather than to a node
       * passed in: every choice re-renders the object toolbar, which replaces that
       * button, and measuring a detached element puts the panel in the corner.
       */
      function formatPopover() {
        var o = selected();
        if (!o) return;

        popover(fmtBtn || bar2, function (p) {
          popLabel(p, KINDS[o.kind] + '格式');

          function change(fn) {
            edit(fn);
            closePop();
            // Reopened against the new state, so a run of choices does not need a
            // trip back to the toolbar between each one.
            formatPopover();
          }

          if (o.kind !== 'image') {
            p.appendChild(el('div', 'ui-pop-sub',
              o.kind === 'table' ? '標題列底色' : o.kind === 'chart' ? '底色' : '填色'));
            p.appendChild(swatchRow(o.fill, function (hex) { change(function () { o.fill = hex; }); }));
          }

          // A chart has no line of its own to colour.
          if (o.kind !== 'chart') {
            p.appendChild(el('div', 'ui-pop-sub', o.kind === 'table' ? '框線顏色' : '線條顏色'));
            p.appendChild(swatchRow(o.stroke, function (hex) { change(function () { o.stroke = hex; }); }));
          }

          if (o.kind !== 'image') {
            p.appendChild(el('div', 'ui-pop-sub', '文字顏色'));
            p.appendChild(swatchRow(o.colour, function (hex) { change(function () { o.colour = hex; }); }, true));
          }

          /** A labelled <select>, wired straight into one field of the object. */
          function picker(label, list, current, set) {
            var sel = el('select');
            sel.setAttribute('aria-label', label);
            sel.title = label;
            list.forEach(function (item) {
              var opt = el('option', null, item.name);
              opt.value = item.id;
              sel.appendChild(opt);
            });
            sel.value = current;
            sel.addEventListener('change', function () { change(function () { set(sel.value); }); });
            return sel;
          }

          /* Both axes, for every kind of object, under one heading.
             Alignment used to live in the same unlabelled run of controls as the
             type size, and the vertical half was skipped for tables and the whole
             pair for pictures -- so the panel looked like it only did horizontal. */
          /* A chart has no text of its own to align: the same pair decides where
             the drawing sits while its box and its viewBox disagree in shape. */
          p.appendChild(el('div', 'ui-pop-sub',
            o.kind === 'image' ? '圖片在框裡的位置' : o.kind === 'chart' ? '圖表在框裡的位置' : '文字對齊'));
          var aligns = el('div', 'ui-pop-row');
          aligns.appendChild(picker('水平對齊', ALIGNS, o.align, function (v) { o.align = v; }));
          aligns.appendChild(picker('垂直對齊', VALIGNS, o.valign, function (v) { o.valign = v; }));
          p.appendChild(aligns);

          var row = el('div', 'ui-pop-row');

          if (o.kind !== 'image') {
            var sizeSel = el('select');
            sizeSel.setAttribute('aria-label', '字級');
            sizeSel.title = '字級（點，以標準投影片高度換算）';
            TEXT_SIZES.forEach(function (n) {
              var opt = el('option', null, n + ' pt');
              opt.value = String(n);
              sizeSel.appendChild(opt);
            });
            if (TEXT_SIZES.indexOf(o.size) < 0) {
              var own = el('option', null, o.size + ' pt');
              own.value = String(o.size);
              sizeSel.appendChild(own);
            }
            sizeSel.value = String(o.size);
            sizeSel.addEventListener('change', function () {
              change(function () { o.size = span(sizeSel.value, o.size, 6, 200); });
            });
            row.appendChild(sizeSel);
          }

          // A chart's text is the renderer's; it has no bold or italic to offer.
          if (o.kind !== 'image' && o.kind !== 'chart') {
            var bold = button('B', o.bold ? 'on' : null, '粗體');
            bold.style.fontWeight = '700';
            bold.addEventListener('click', function () { change(function () { o.bold = !o.bold; }); });
            row.appendChild(bold);

            var ital = button('I', o.italic ? 'on' : null, '斜體');
            ital.style.fontStyle = 'italic';
            ital.addEventListener('click', function () { change(function () { o.italic = !o.italic; }); });
            row.appendChild(ital);
          }

          if (o.kind === 'shape') {
            row.appendChild(picker('換圖案',
              Object.keys(SHAPES).map(function (id) { return { id: id, name: SHAPES[id].name }; }),
              o.shape, function (v) { o.shape = v; }));
          }

          if (o.kind === 'image') {
            row.appendChild(picker('縮放方式', FITS, o.fit, function (v) { o.fit = v; }));

            var round = button('圓角', o.round ? 'on' : null, '圓角');
            round.addEventListener('click', function () { change(function () { o.round = !o.round; }); });
            row.appendChild(round);

            var alt = button('替代文字…', null, '看不到圖時顯示的說明');
            alt.addEventListener('click', async function () {
              var v = await AIOS.prompt({
                host: ctx.win.el, label: '替代文字', value: o.alt || '', selectStem: false
              });
              if (v === null) return;
              edit(function () { o.alt = v; });
              closePop();
            });
            row.appendChild(alt);
          }

          if (o.kind === 'chart') {
            row.appendChild(picker('圖表類型',
              AIOS.charts.TYPES.map(function (t) { return { id: t.id, name: t.name }; }),
              o.chart.type, function (v) { o.chart.type = v; }));
            row.appendChild(picker('圖例', [
              { id: 'bottom', name: '圖例在下方' }, { id: 'right', name: '圖例在右側' }, { id: 'none', name: '不顯示圖例' }
            ], o.chart.legend, function (v) { o.chart.legend = v; }));
            /* A checkbox rather than a toggle button: it is the control the
               chart editor shows for the same field, under the same name. */
            var labelWrap = el('label', 'ui-pop-check');
            var labelBox = el('input');
            labelBox.type = 'checkbox';
            labelBox.checked = !!o.chart.labels;
            labelBox.addEventListener('change', function () {
              change(function () { o.chart.labels = labelBox.checked; });
            });
            labelWrap.appendChild(labelBox);
            labelWrap.appendChild(el('span', null, '資料標籤'));
            row.appendChild(labelWrap);
          }

          if (o.kind === 'table') {
            var head = button('首列為標題', o.header ? 'on' : null);
            head.addEventListener('click', function () { change(function () { o.header = !o.header; }); });
            row.appendChild(head);

            var band = button('交錯底色', o.banded ? 'on' : null);
            band.addEventListener('click', function () { change(function () { o.banded = !o.banded; }); });
            row.appendChild(band);
          }

          p.appendChild(row);

          var geom = el('div', 'ui-pop-row');
          var fitBtn = button('鋪滿投影片', null, '把物件放到接近整頁的位置');
          fitBtn.addEventListener('click', function () {
            change(function () { o.x = 6; o.y = 10; o.w = 88; o.h = 78; });
          });
          var centreBtn = button('置中', null, '水平垂直都對齊投影片中央');
          centreBtn.addEventListener('click', function () {
            change(function () {
              o.x = Math.round((100 - o.w) / 2);
              o.y = Math.round((100 - o.h) / 2);
            });
          });
          geom.appendChild(fitBtn);
          geom.appendChild(centreBtn);
          p.appendChild(geom);
        });
      }

      /* Add or remove at the far edge, which is what the toolbar's ± buttons mean.
         Positional insert and delete are in the context menu, where there is a
         cell to be positional about. */
      function tableRowCol(o, what, delta) {
        var T = AIOS.grid.table;
        tableOp(o, null, function () {
          var n = tableSize(o);
          if (what === 'row') {
            if (delta > 0) {
              if (n.rows >= MAX_TABLE_ROWS) throw new Error('最多 ' + MAX_TABLE_ROWS + ' 列');
              T.insertRow(o, n.rows);
            } else {
              T.deleteRow(o, n.rows - 1);
            }
          } else if (delta > 0) {
            if (n.cols >= MAX_TABLE_COLS) throw new Error('最多 ' + MAX_TABLE_COLS + ' 欄');
            T.insertCol(o, n.cols);
          } else {
            T.deleteCol(o, n.cols - 1);
          }
        });
      }

      /** 跨欄置中 for a slide table: merge the cell range, or undo one merge. */
      function tableMergeToggle(o) {
        var T = AIOS.grid.table;
        var range = cellSel && cellSel.id === o.id ? cellSel : null;
        if (!range) { ctx.toast('先在表格裡點一格，再按住 Shift 點另一格選出範圍', 't-warn'); return; }
        var hit = AIOS.grid.within(o.merges, range);
        var exactly = hit.length === 1 && hit[0].c0 === range.c0 && hit[0].c1 === range.c1 &&
                      hit[0].r0 === range.r0 && hit[0].r1 === range.r1;
        if (exactly) {
          tableOp(o, '已取消合併', function () { T.unmerge(o, range); });
          return;
        }
        var lost = 0;
        tableOp(o, null, function () { lost = T.merge(o, range); });
        ctx.toast('已合併 ' + AIOS.grid.label(range) +
          (lost ? '，捨棄 ' + lost + ' 格內容（Ctrl+Z 可以復原）' : ''),
          lost ? 't-warn' : 't-ok');
      }

      var fmtBtn = null;

      function renderObjBar() {
        objBar.innerHTML = '';
        fmtBtn = null;
        var o = selected();
        if (!o) return;

        objBar.appendChild(el('span', 'sl-group-tag', KINDS[o.kind]));

        fmtBtn = button('格式…', 'fbtn-primary', '填色、線條、字級、對齊');
        fmtBtn.addEventListener('click', function () { formatPopover(); });
        objBar.appendChild(fmtBtn);

        if (o.kind === 'table') {
          [['\u002b 列', 'row', 1], ['\u2212 列', 'row', -1],
           ['\u002b 欄', 'col', 1], ['\u2212 欄', 'col', -1]].forEach(function (spec) {
            var b = button(spec[0]);
            b.addEventListener('click', function () { tableRowCol(o, spec[1], spec[2]); });
            objBar.appendChild(b);
          });
          /* The same verb the spreadsheet's toolbar has, so somebody who merged
             cells there looks in the same place here. Everything else about the
             table is on the right-click menu, where there is a cell to point at. */
          var mergeBtn = button('跨欄置中', null,
            '在表格裡點一格，按住 Shift 點另一格選出範圍，再按這裡。右鍵選單有完整的表格功能');
          mergeBtn.addEventListener('click', function () { tableMergeToggle(o); });
          objBar.appendChild(mergeBtn);

          /* On the toolbar too, not only in the menu: this is the control Word
             puts on its ribbon, and a control that only exists on a right-click is
             one people do not find. */
          var borderBtn = button('\u229e 框線', null,
            '框線與網底：線條樣式、線寬、畫筆色彩、要哪幾邊');
          borderBtn.addEventListener('click', function () {
            var range = cellSel && cellSel.id === o.id
              ? cellSel : { c0: 0, r0: 0, c1: 0, r1: 0 };
            borderPopover(o, range, borderBtn);
          });
          objBar.appendChild(borderBtn);
        }
        if (o.kind === 'image') {
          var swap = button('換圖…');
          swap.addEventListener('click', function () { insertImage(); });
          objBar.appendChild(swap);
        }
        if (o.kind === 'chart') {
          var chartBtn = button('編輯圖表…', null, '類型、標題、資料、圖例、數字格式、座標軸標題');
          chartBtn.addEventListener('click', function () { chartPopover(chartBtn, o); });
          objBar.appendChild(chartBtn);
          var dataBtn = button('檢視資料', null, '看這張圖表畫的是哪些數字');
          dataBtn.addEventListener('click', function () { chartDataPopover(dataBtn, o); });
          objBar.appendChild(dataBtn);
          var tableBtn = button('轉成表格', null, '換成一張放在同樣位置的表格');
          tableBtn.addEventListener('click', function () { chartToTableUI(o); });
          objBar.appendChild(tableBtn);
        }

        var up = button('\u2b71', null, '上移一層 (Ctrl+])');
        up.addEventListener('click', function () { layerSelected(1); });
        var down = button('\u2b73', null, '下移一層 (Ctrl+[)');
        down.addEventListener('click', function () { layerSelected(-1); });
        var dup = button('複製', null, '複製這個物件 (Ctrl+D)');
        dup.addEventListener('click', duplicateSelected);
        var del = button('刪除', null, '刪掉這個物件 (Delete)');
        del.addEventListener('click', function () {
          var list = objects();
          edit(function () { list.splice(list.indexOf(o), 1); selId = null; });
        });
        [up, down, dup, del].forEach(function (b) { objBar.appendChild(b); });
      }

      /**
       * The shared border toolbox, for a table object.
       *
       * The same panel the spreadsheet and a document's table raise, drawn with
       * the same pen -- so a table copied between two of these programs by hand
       * can be made to match without setting the line up twice.
       */
      function borderPopover(o, range, from) {
        var T = AIOS.grid.table;
        var n = tableSize(o);
        var wide = range.c0 !== range.c1 || range.r0 !== range.r1;
        popover(from || fmtBtn || bar2, function (p) {
          popLabel(p, '框線與網底');
          AIOS.borders.panel(p, {
            scope: '表格 ' + n.cols + ' 欄 × ' + n.rows + ' 列　·　' +
                   (wide ? '已選 ' + AIOS.grid.label(range) : '整張表格'),
            fill: T.styleAt(o, range.c0, range.r0).bg || null,
            whole: true,
            /* No marked range means no range was chosen, and 內框線 over one cell
               has no interior to draw -- so the command would appear to do nothing.
               Somebody who opened this without selecting anything means the table. */
            wholeDefault: !wide,
            onFill: function (hex, whole) {
              closePop();
              var area = whole ? { c0: 0, r0: 0, c1: n.cols - 1, r1: n.rows - 1 } : range;
              tableOp(o, hex ? '已套用網底' : '已清除網底', function () {
                T.applyFill(o, area, hex);
              });
            },
            onApply: function (kind, whole) {
              closePop();
              var area = whole ? { c0: 0, r0: 0, c1: n.cols - 1, r1: n.rows - 1 } : range;
              tableOp(o, null, function () {
                var touched = T.applyBorder(o, area, kind, null);
                ctx.toast('框線：' + kind + '，' + touched + ' 格', touched ? 't-ok' : 't-warn');
              });
            }
          });
        }, 'ui-pop-wide');
      }

      /**
       * The table half of the right-click menu.
       *
       * Empty for anything that is not a table, so the caller can concatenate it
       * unconditionally. Positional here rather than on the toolbar because a menu
       * knows which cell it was opened on, and 「在上面插入一列」 needs to know that
       * to mean anything.
       */
      function tableMenu(o, ev) {
        if (o.kind !== 'table') return [];
        var cellEl = ev.target.closest ? ev.target.closest('td[data-r], th[data-r]') : null;
        var at = cellEl
          ? { c: Number(cellEl.dataset.c), r: Number(cellEl.dataset.r) }
          : { c: 0, r: 0 };
        // Right-clicking a cell outside the marked range moves to it, so the menu
        // and what it acts on agree.
        if (cellEl && (!cellSel || cellSel.id !== o.id ||
            at.c < cellSel.c0 || at.c > cellSel.c1 || at.r < cellSel.r0 || at.r > cellSel.r1)) {
          setCellSel(o, at.c, at.r);
        }

        var T = AIOS.grid.table;
        var n = tableSize(o);
        var range = cellRangeFor(o, at);
        var wide = range.c0 !== range.c1 || range.r0 !== range.r1;
        var hit = AIOS.grid.within(o.merges, range);
        var where = '第 ' + (at.r + 1) + ' 列第 ' + (at.c + 1) + ' 欄';

        return [
          { label: '表格 ' + n.cols + ' 欄 × ' + n.rows + ' 列　·　' +
                   (wide ? '已選 ' + AIOS.grid.label(range) : where), disabled: true },
          { label: '在上面插入一列', run: function () {
            tableOp(o, '已插入一列', function () { T.insertRow(o, range.r0); });
          } },
          { label: '在下面插入一列', run: function () {
            tableOp(o, '已插入一列', function () { T.insertRow(o, range.r1 + 1); });
          } },
          { label: '刪除' + (range.r0 === range.r1 ? '第 ' + (range.r0 + 1) + ' 列'
                                                   : '第 ' + (range.r0 + 1) + '–' + (range.r1 + 1) + ' 列'),
            danger: true, disabled: n.rows <= 1, run: function () {
              tableOp(o, '已刪除', function () {
                for (var i = range.r1; i >= range.r0; i--) T.deleteRow(o, i);
              });
            } },
          { sep: true },
          { label: '在左邊插入一欄', run: function () {
            tableOp(o, '已插入一欄', function () { T.insertCol(o, range.c0); });
          } },
          { label: '在右邊插入一欄', run: function () {
            tableOp(o, '已插入一欄', function () { T.insertCol(o, range.c1 + 1); });
          } },
          { label: '刪除' + (range.c0 === range.c1 ? '第 ' + (range.c0 + 1) + ' 欄'
                                                   : '第 ' + (range.c0 + 1) + '–' + (range.c1 + 1) + ' 欄'),
            danger: true, disabled: n.cols <= 1, run: function () {
              tableOp(o, '已刪除', function () {
                for (var i = range.c1; i >= range.c0; i--) T.deleteCol(o, i);
              });
            } },
          { sep: true },
          { label: '框線與網底…　' + AIOS.borders.describe(T.styleAt(o, range.c0, range.r0).border),
            run: function () { borderPopover(o, range); } },
          { sep: true },
          hit.length
            ? { label: '取消合併', run: function () {
                tableOp(o, '已取消合併', function () { T.unmerge(o, range); });
              } }
            : null,
          { label: wide ? '跨欄置中 ' + AIOS.grid.label(range) : '跨欄置中（先按住 Shift 點另一格）',
            disabled: !wide, run: function () { tableMergeToggle(o); } },
          { label: o.header ? '取消首列為標題' : '首列為標題', run: function () {
            tableOp(o, null, function () { o.header = !o.header; });
          } },
          { label: o.banded ? '取消交錯底色' : '交錯底色', run: function () {
            tableOp(o, null, function () { o.banded = !o.banded; });
          } },
          { sep: true },
          // The same verb the document's table offers, worded the same.
          { label: '轉成圖表', run: function () { tableToChartUI(o); } },
          { sep: true }
        ].filter(Boolean);
      }

      /* ------------------------------------------------------ chart panels */

      /* What the editor opens with when there is no chart yet: a table small
         enough to read as an example and complete enough to draw. */
      var STARTER_CHART = {
        type: 'column', xTitle: '月份',
        categories: ['1月', '2月', '3月'],
        series: [{ name: '收入', values: [120, 95, 140] }, { name: '支出', values: [80, 110, 90] }]
      };

      /**
       * The shared chart editor, in a popover.
       *
       * One panel inserts and edits: with an object it rewrites that object's
       * chart, without one it adds a chart to this slide. Data mode, because a
       * slide's chart keeps its numbers inside the deck -- there is no sheet to
       * point a range at. What the panel noticed about the table (a 合計 it
       * left out, a column with no numbers) is said out loud: a chart that
       * quietly lost a column looks complete.
       */
      function chartPopover(anchor, o) {
        popover(anchor || fmtBtn || bar2, function (p, close) {
          popLabel(p, o ? '編輯圖表' : '插入圖表');
          AIOS.charts.panel(p, {
            spec: o ? o.chart : STARTER_CHART,
            mode: 'data',
            onApply: function (spec, extras) {
              close();
              try {
                edit(function () {
                  if (o) o.chart = spec;
                  else addObject(cur, { kind: 'chart', chart: spec });
                });
              } catch (e) { ctx.toast(e.message, 't-warn'); return; }
              var got = extras && extras.table;
              var said = [];
              if (got && got.omitted.length) said.push('略過 ' + got.omitted.join('、'));
              if (got && got.skipped.length) said.push('沒有數字：' + got.skipped.join('、'));
              ctx.toast((o ? '已更新圖表' : '已插入圖表') + (said.length ? '；' + said.join('；') : ''),
                said.length ? 't-warn' : 't-ok');
            },
            onCancel: close
          });
        }, 'ui-pop-chart');
      }

      /** The numbers behind a chart, shown without changing anything. */
      function chartDataPopover(anchor, o) {
        popover(anchor || fmtBtn || bar2, function (p) {
          popLabel(p, '圖表資料');
          p.appendChild(el('div', 'ui-pop-count', AIOS.charts.describe(o.chart)));
          p.appendChild(AIOS.charts.tableNode(o.chart));
          var row = el('div', 'ui-pop-row');
          var copyBtn = button('複製圖表', null, '複製這張圖表 (Ctrl+C)：可以貼到文件、試算表或另一份簡報');
          copyBtn.addEventListener('click', function () { closePop(); copyChart(o); });
          row.appendChild(copyBtn);
          p.appendChild(row);
        }, 'ui-pop-chart');
      }

      /**
       * The clipboard, for charts.
       *
       * The rich copy lives in the shared module and its text twin -- the
       * numbers, tab-separated -- goes to the system clipboard: a paste into
       * any other program gets a table, a paste into one of ours gets the
       * chart back whole. The two are matched by the text, so a copy made
       * elsewhere in between is never mistaken for the chart.
       */
      function copyChart(o) {
        AIOS.charts.copy(o.chart).then(function () {
          ctx.toast('已複製圖表，可以貼到文件、試算表或另一份簡報', 't-ok');
        }, function (e) {
          ctx.toast('複製失敗：' + (e && e.message ? e.message : e), 't-err');
        });
      }

      function pasteChart() {
        A.clipboard.read().then(function (r) {
          var text = r && r.ok && r.data ? String(r.data.text || '') : '';
          if (!AIOS.charts.pasteMatches(text)) return;
          try {
            edit(function () { addObject(cur, { kind: 'chart', chart: AIOS.charts.clipSpec() }); });
            ctx.toast('已貼上圖表', 't-ok');
          } catch (e) { ctx.toast(e.message, 't-warn'); }
        });
      }

      /* 轉成圖表 and 轉成表格 from the toolbar and the menu: the same conversions
         the chat actions do, as one undo step each, with the outcome said. */
      function tableToChartUI(o) {
        var note;
        try {
          note = edit(function () { return tableToChart(cur, objects().indexOf(o)); });
        } catch (e) { ctx.toast(e.message, 't-warn'); return; }
        ctx.toast(note, 't-ok');
      }

      function chartToTableUI(o) {
        var note;
        try {
          note = edit(function () { return chartToTable(cur, objects().indexOf(o)); });
        } catch (e) { ctx.toast(e.message, 't-warn'); return; }
        ctx.toast(note, 't-ok');
      }

      /**
       * The chart half of the right-click menu.
       *
       * Empty for anything that is not a chart, so the caller concatenates it
       * without asking, the way it does the table's. The panels open at the
       * object that was clicked, which is where the eyes are.
       */
      function chartMenu(o, ev) {
        if (o.kind !== 'chart') return [];
        var at = ev && ev.target && ev.target.closest ? ev.target.closest('.sl-obj') : null;
        return [
          { label: '編輯圖表…', run: function () { chartPopover(at, o); } },
          { label: '檢視資料', run: function () { chartDataPopover(at, o); } },
          { label: '轉成表格', run: function () { chartToTableUI(o); } },
          { label: '複製圖表', hint: 'Ctrl+C', run: function () { copyChart(o); } }
        ].concat(AIOS.charts.sendMenuItems(function () { return o.chart; }, 'slides', ctx.toast,
          function () { return { aspect: (o.w * 16) / (o.h * 9) }; }))
         .concat([{ sep: true }]);
      }

      /* -------------------------------------------------------- presenting */

      var overlay = null;
      function present(from) {
        var idx = Math.max(0, Math.min(deck.slides.length - 1, from || 0));
        overlay = el('div', 'sl-present');
        overlay.tabIndex = 0;

        /* An inner 16:9 canvas, not a frame that fills the screen. Objects are
           positioned in percentages of a 16:9 slide, so a projection surface with
           a different shape would put every one of them in the wrong place. */
        var pstage = el('div', 'sl-present-stage');
        overlay.appendChild(pstage);

        var hud = el('div', 'sl-present-hud');
        var counter = el('span', 'sl-present-count');
        var noteBox = el('div', 'sl-present-notes');
        var exit = el('button', 'fbtn', '結束放映 (Esc)');
        exit.type = 'button';
        hud.appendChild(counter);
        hud.appendChild(noteBox);
        hud.appendChild(exit);
        overlay.appendChild(hud);

        function paint() {
          var s = deck.slides[idx];
          pstage.innerHTML = '';
          pstage.appendChild(buildSlide(s, 'view'));
          counter.textContent = (idx + 1) + ' / ' + deck.slides.length;
          noteBox.textContent = s.notes || '';
        }

        function step(d) {
          idx = Math.max(0, Math.min(deck.slides.length - 1, idx + d));
          paint();
        }
        function close() {
          document.removeEventListener('keydown', keys, true);
          if (overlay) { overlay.remove(); overlay = null; }
          cur = idx;
          selId = null;
          render();
        }
        function keys(e) {
          if (e.key === 'Escape') { e.preventDefault(); close(); }
          else if (['ArrowRight', 'PageDown', ' ', 'Enter'].indexOf(e.key) >= 0) { e.preventDefault(); step(1); }
          else if (['ArrowLeft', 'PageUp'].indexOf(e.key) >= 0) { e.preventDefault(); step(-1); }
          else if (e.key === 'Home') { e.preventDefault(); idx = 0; paint(); }
          else if (e.key === 'End') { e.preventDefault(); idx = deck.slides.length - 1; paint(); }
        }

        exit.addEventListener('click', close);
        // Click anywhere on the slide to advance, the way a remote does. The HUD
        // is the exception: its own controls have to stay clickable.
        overlay.addEventListener('click', function (e) {
          if (e.target.closest && e.target.closest('.sl-present-hud')) return;
          step(1);
        });
        document.addEventListener('keydown', keys, true);
        document.body.appendChild(overlay);
        overlay.focus();
        paint();
      }

      /* ---------------------------------------------------------- formats */

      function esc(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }

      /**
       * Read every picture in the deck into the cache.
       *
       * Called before an export, because serialising DOM is synchronous and a
       * picture that has not been read yet would serialise as its placeholder.
       */
      async function primeImages() {
        var missing = [];
        deck.slides.forEach(function (s) {
          (s.objects || []).forEach(function (o) {
            if (o.kind === 'image' && o.src && !/^data:/i.test(o.src) &&
                !AIOS.images.peek(o.src) && missing.indexOf(o.src) < 0) {
              missing.push(o.src);
            }
          });
        });
        var results = await Promise.all(missing.map(function (p) { return AIOS.images.dataUrl(p); }));
        return results.filter(function (r) { return !r.ok; }).length;
      }

      /**
       * The slide stylesheet for an exported file.
       *
       * A copy of the geometry os.css gives the editor, because an exported file
       * cannot link to it. Only the structural classes are here -- objects carry
       * their own appearance inline -- and both exports share this one function so
       * the copy is made once rather than twice.
       */
      function slideCss(flavour) {
        var print = flavour === 'print';
        var ink = print ? '#24313f' : '#dbe7f7';
        var head = print ? '#0b5fa4' : '#4fd6ff';
        /* A 16:9 page, not A4 landscape. A4 is 1.414:1, so fitting a slide to it
           either leaves white bands or squashes the geometry -- and the geometry is
           the thing this whole file is arranged to keep identical everywhere. The
           size is the standard widescreen slide, 13.333in by 7.5in. Emitted after
           printing.baseCss, whose own @page rule this overrides; the print window
           runs with preferCSSPageSize, so the document decides. */
        var page = print ? '@page { size: 338.67mm 190.5mm; margin: 0; }' : '';
        var box = print
          ? '.sl-canvas { height: 100vh; width: auto; background: #fff; }'
          : '.sl-canvas { display: none; width: min(100vw, 177.7vh); aspect-ratio: 16 / 9;' +
            ' background: linear-gradient(160deg, #131d2c, #0a0f18); }' +
            '\n.sl-canvas.on { display: flex; }';
        return [
          page,
          box,
          '.sl-canvas { position: relative; box-sizing: border-box;',
          '  container-type: size; flex-direction: column;',
          '  overflow: hidden; color: ' + ink + '; }',
          (print ? '.sl-canvas { display: flex; }' : ''),
          /* The eight chart series colours, re-stepped for a dark surface the
             way os.css does under a dark theme. The drawing names them as
             var(--ch-N, light-hex) and the print flavour leaves them unset, so
             the PDF paints the steps that were validated on white. */
          (print ? '' : '.sl-canvas { --ch-1: #3987E5; --ch-2: #D95926; --ch-3: #199E70; --ch-4: #C98500;' +
            ' --ch-5: #D55181; --ch-6: #008300; --ch-7: #9085E9; --ch-8: #E66767; }'),
          '.sl-flow { flex: 1; min-height: 0; padding: 6% 7%;',
          '  display: flex; flex-direction: column; gap: 4%; }',
          '.sl-title { font-size: calc(6.6cqh * var(--sl-k, 1)); font-weight: 600;',
          '  line-height: 1.25; color: ' + head + '; margin: 0; }',
          '.sl-canvas.layout-title .sl-title { font-size: calc(9.6cqh * var(--sl-k, 1)); }',
          '.sl-canvas.layout-section .sl-title { text-align: center; margin: auto 0; }',
          '.sl-body { flex: 1; display: flex; gap: 5%; min-height: 0; }',
          '.sl-col { flex: 1; min-width: 0; }',
          '.sl-text { font-size: calc(3.6cqh * var(--sl-k, 1)); line-height: 1.7; }',
          '.sl-canvas.layout-quote .sl-text { font-size: calc(5.2cqh * var(--sl-k, 1));',
          '  font-style: italic; }',
          '.sl-text ul { padding-left: 1.2em; margin: 0; }',
          '.sl-text li { margin: .45em 0; }',
          '.sl-text p { margin: 0 0 .5em; }',
          '.sl-objects { position: absolute; inset: 0; }',
          '.sl-pnum { position: absolute; right: 4%; bottom: 3%; font-size: 2cqh;',
          '  color: ' + (print ? '#7b8b9c' : '#566b8a') + '; }'
        ].filter(Boolean).join('\n');
      }

      /**
       * The deck as serialised slides.
       *
       * The same nodes the editor draws, which is the whole point: nothing here
       * re-derives what a slide looks like, so nothing here can disagree with the
       * screen. Call primeImages() first.
       */
      function serialiseSlides(opts) {
        var o = opts || {};
        return deck.slides.map(function (s, i) {
          var node = buildSlide(s, 'view');
          if (o.numbers) {
            node.appendChild(el('div', 'sl-pnum', (i + 1) + ' / ' + deck.slides.length));
          }
          // The last slide must not break, or the PDF ends on a blank page.
          if (o.breaks && i < deck.slides.length - 1) node.classList.add('pr-page-break');
          if (o.first && i === 0) node.classList.add('on');
          return node.outerHTML;
        }).join('\n');
      }

      function toMarkdown() {
        var out = ['# ' + deck.title, ''];
        deck.slides.forEach(function (s, i) {
          out.push('## ' + (i + 1) + '. ' + (s.title || '（無標題）'));
          out.push('');
          out.push('<!-- layout: ' + s.layout + ' -->');
          (s.body || []).forEach(function (chunk, ci) {
            if ((s.body || []).length > 1) out.push('**欄 ' + (ci + 1) + '**');
            String(chunk).split('\n').forEach(function (line) {
              if (line.trim()) out.push(s.layout === 'bullets' ? '- ' + line.replace(/^[-*]\s*/, '') : line);
            });
          });

          (s.objects || []).forEach(function (obj) {
            out.push('');
            if (obj.kind === 'table') {
              // A real Markdown table, so the export is readable rather than a
              // description of a table.
              obj.rows.forEach(function (row, r) {
                out.push('| ' + row.map(function (c) {
                  return String(c).replace(/\|/g, '\\|');
                }).join(' | ') + ' |');
                if (r === 0) out.push('| ' + row.map(function () { return '---'; }).join(' | ') + ' |');
              });
            } else if (obj.kind === 'chart') {
              /* The pair office.js writes for a document: a comment naming what
                 the table was drawn as, then the numbers as a table every
                 renderer shows and the reader turns back into a chart. */
              var spec = AIOS.charts.norm(obj.chart);
              var meta = {
                type: spec.type, title: spec.title, legend: spec.legend, labels: spec.labels,
                numFmt: spec.numFmt, xTitle: spec.xTitle, yTitle: spec.yTitle,
                colours: spec.series.map(function (ser) { return ser.colour || ''; }),
                aspect: Math.round((obj.w * 16) / (obj.h * 9) * 100) / 100
              };
              // A comment ends at the first `-->`, so the JSON may hold no double dash.
              out.push('<!-- chart ' + JSON.stringify(meta).replace(/--/g, '-\\u002d') + ' -->');
              AIOS.charts.toRows(spec).forEach(function (row, r) {
                out.push('| ' + row.map(function (c) {
                  return String(c).replace(/\|/g, '\\|');
                }).join(' | ') + ' |');
                if (r === 0) out.push('| ' + row.map(function () { return '---'; }).join(' | ') + ' |');
              });
            } else if (obj.kind === 'image') {
              out.push('![' + (obj.alt || '圖片') + '](' + obj.src + ')');
            } else if (obj.kind === 'shape') {
              out.push('> ' + (SHAPES[obj.shape] || SHAPES.rect).name +
                       (obj.text ? '：' + obj.text : ''));
            } else if (obj.text) {
              out.push(obj.text);
            }
          });

          if (s.notes) { out.push(''); out.push('> 備忘：' + s.notes); }
          out.push('');
        });
        return out.join('\n');
      }

      /** A self-contained deck that opens in any browser, arrow keys and all. */
      function toHtml() {
        return [
          '<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">',
          '<meta name="viewport" content="width=device-width, initial-scale=1">',
          '<title>' + esc(deck.title) + '</title><style>',
          'html, body { margin: 0; height: 100%; background: #070b12; color: #dbe7f7; }',
          'body { display: flex; align-items: center; justify-content: center;',
          '  font-family: "Noto Sans TC", system-ui, sans-serif; }',
          slideCss('html'),
          '#nav { position: fixed; bottom: 14px; right: 18px;',
          '  font: 12px/1 monospace; color: #566b8a; }',
          '</style></head><body>',
          serialiseSlides({ first: true }),
          '<div id="nav"></div><script>',
          'var i=0,s=document.querySelectorAll(".sl-canvas"),n=document.getElementById("nav");',
          'function go(k){i=Math.max(0,Math.min(s.length-1,k));',
          's.forEach(function(x,j){x.classList.toggle("on",j===i)});',
          'n.textContent=(i+1)+" / "+s.length}',
          'document.addEventListener("keydown",function(e){',
          'if(["ArrowRight","PageDown"," ","Enter"].indexOf(e.key)>=0)go(i+1);',
          'else if(["ArrowLeft","PageUp"].indexOf(e.key)>=0)go(i-1);',
          'else if(e.key==="Home")go(0);else if(e.key==="End")go(s.length-1)});',
          'document.addEventListener("click",function(){go(i+1)});go(0);',
          '</scr' + 'ipt></body></html>'
        ].join('\n');
      }

      async function save() {
        if (!path) path = '/notes/' + deck.title + '.aiosdeck';
        return writeTo(path);
      }

      /** Save a copy somewhere else, then follow it. */
      async function saveAs(target) {
        var to = target || await AIOS.saveAsPath({
          host: ctx.win.el,
          current: path,
          defaultName: deck.title + '.aiosdeck',
          formats: '.aiosdeck（不失真）、.pptx（PowerPoint）、.pdf、.html、.md'
        });
        if (!to) return '取消';
        var written = await writeTo(to);
        path = written;
        ctx.setTitle('簡報 — ' + deck.title);
        ctx.save();
        return written;
      }

      /** The one writer both paths go through. */
      async function writeTo(target) {
        if (/\.html?$/i.test(target)) return exportAs('html', target);
        if (/\.(md|markdown)$/i.test(target)) return exportAs('md', target);
        if (/\.pdf$/i.test(target)) return exportAs('pdf', target);
        if (/\.pptx$/i.test(target)) return exportAs('pptx', target);

        /* Anything else, refused rather than written.

           This used to fall straight through to the deck's own JSON, so asking
           for a .pptx produced a file that opened in nothing: PowerPoint would
           not have it, and the trace said 「已儲存」. A format this cannot write
           has to say so while the name is still being chosen -- and the model
           that asked needs to hear it too, so it can pick a name that works
           rather than believe it succeeded. */
        if (!/\.aiosdeck$/i.test(target)) {
          var ext = (String(target).match(/\.[^./]*$/) || ['（沒有副檔名）'])[0];
          var why = '存不成 ' + ext + '：簡報可以存 .aiosdeck（不失真）、' +
            '.pptx（PowerPoint）、.pdf、.html、.md';
          ctx.toast(why, 't-err');
          throw new Error(why);
        }

        /* Version 3 added the object layer, version 5 chart objects. Pictures
           are stored as sandbox paths rather than bytes, so the deck file stays
           small and a picture edited on disk shows through; the HTML export is
           where images get inlined. A chart is its data: nothing to fetch. */
        var payload = {
          kind: 'aiosdeck', version: 5, title: deck.title,
          font: deckFont, scale: deckScale,
          slides: deck.slides
        };
        /* Only claim a version when saving over the file this window opened; a
           save-as names a file this deck holds no version of. */
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
        var base = (path || ('/notes/' + deck.title)).replace(/\.[^.]*$/, '');

        if (f === 'md') {
          var mdTarget = explicitTarget || (base + '.md');
          var mw = await A.fs.write(mdTarget, toMarkdown());
          if (!mw.ok) throw new Error(mw.error);
          await AIOS.afterFsChange();
          ctx.toast('已匯出 ' + mdTarget, 't-ok');
          return mdTarget;
        }

        // Both remaining formats embed the pictures, so the bytes have to be in
        // hand before anything is serialised.
        var failed = await primeImages();
        if (failed) ctx.toast(failed + ' 張圖片讀不到，會以說明方塊呈現', 't-warn');

        if (f === 'pptx') {
          var pptxTarget = explicitTarget || (base + '.pptx');
          /* The writer lives in main and takes pictures as data: URIs only, so
             the sandbox paths are resolved here -- the process that owns the
             sandbox should not be following paths it found inside a document.
             A chart travels as its spec; the writer draws it as a native chart. */
          var payload = {
            title: deck.title, font: deckFont, scale: deckScale,
            slides: deck.slides.map(function (s) {
              return Object.assign({}, s, {
                objects: (s.objects || []).map(function (o) {
                  if (o.kind !== 'image' || !o.src || /^data:/i.test(o.src)) return o;
                  return Object.assign({}, o, { src: AIOS.images.peek(o.src) || o.src });
                })
              });
            })
          };
          var pr = await window.aios.office.writePptx(pptxTarget, payload);
          if (!pr.ok) { ctx.toast('匯出失敗：' + pr.error, 't-err'); throw new Error(pr.error); }
          await AIOS.afterFsChange();
          ctx.toast('已匯出 ' + pr.data.vpath + '（' + deck.slides.length + ' 頁，' +
            AIOS.bytes(pr.data.bytes) + '）', 't-ok');
          (pr.data.warnings || []).forEach(function (w) { ctx.toast(w, 't-warn'); });
          return pr.data.vpath;
        }

        if (f === 'pdf') {
          var pdfTarget = explicitTarget || (base + '.pdf');
          var out = await AIOS.printing.toPdf(pdfTarget, {
            title: deck.title,
            font: deckFont,
            // A slide is landscape. No margin: the slide is the page, and its own
            // padding is the margin.
            landscape: true,
            margin: '0mm',
            bodyHtml: serialiseSlides({ numbers: true, breaks: true }),
            css: slideCss('print')
          });
          await AIOS.afterFsChange();
          ctx.toast('已匯出 ' + out.vpath + '（' + deck.slides.length + ' 頁，' +
            Math.round(out.bytes / 1024) + ' KB）', 't-ok');
          if (out.warning) ctx.toast(out.warning, 't-warn');
          return out.vpath;
        }

        var target = explicitTarget || (base + '.html');
        var body = toHtml();
        var w = await A.fs.write(target, body);
        if (!w.ok) throw new Error(w.error);
        await AIOS.afterFsChange();
        ctx.toast('已匯出 ' + target + '（' + AIOS.bytes(body.length) + '，圖片已嵌入）', 't-ok');
        return target;
      }

      /**
       * A .pptx is imported, never opened.
       *
       * The difference is one line -- `path` stays null -- and it is the whole
       * safety argument for reading the format at all. What this editor cannot
       * model (masters, layouts, themes, animations) is exactly what a company
       * template consists of, so a deck that could be saved back would quietly
       * replace all of it with nothing while still producing a file that opens.
       * With no path, Ctrl+S asks for a name, and the original is untouched --
       * the same rule the PDF rewriter works under.
       */
      async function importPptx(vpath) {
        var r = await window.aios.office.readPptx(vpath);
        if (!r.ok) { ctx.toast('讀不進來：' + r.error, 't-err'); return; }
        var d = r.data;
        var notes = (d.warnings || []).slice();

        deck = {
          title: d.title || '匯入的簡報',
          slides: (d.slides || []).map(normSlide)
        };
        /* Only adopt a font this machine lists. An unknown family still renders
           (the stack falls back to the quoted name) but it would leave the font
           selector blank, which reads as "no font" rather than as a substitution. */
        if (d.font) {
          var known = AIOS.fonts.families.some(function (f) { return f.name === d.font; });
          if (known) { deckFont = d.font; fontSel.value = d.font; }
          else notes.push('原本的字型是「' + d.font + '」，這台機器沒有，用的是「' + deckFont + '」');
        }
        deckScale = 100;
        scaleSel.value = '100';

        path = null;
        pathMtime = 0;
        cur = 0;
        selId = null;
        undoStack = [];
        redoStack = [];
        dirty = true;
        render();
        ctx.setTitle('簡報 — ' + deck.title + '（匯入）');

        ctx.toast('已讀入 ' + deck.slides.length + ' 頁' +
          (notes.length ? '，有 ' + notes.length + ' 件事沒有帶過來' : '') +
          '。這是一份新的簡報，存檔會另外問你檔名，原本的 .pptx 不會被動到。',
        notes.length ? 't-warn' : 't-ok');

        /* The full list goes in the conversation panel rather than into a stack
           of toasts: it can run to a dozen lines on a real template, and a
           toast that scrolls past is the same as no report at all. */
        if (notes.length) {
          var inst = ctx.win && AIOS.apps.instanceFor(ctx.win);
          if (inst && inst.chat) {
            inst.chat.say('從「' + vpath + '」匯入了 ' + deck.slides.length +
              ' 頁。以下是沒有帶過來的東西：', 'chat-warn');
            notes.forEach(function (w) { inst.chat.say('· ' + w, 'chat-warn'); });
          }
        }
      }

      async function open(vpath) {
        if (!vpath) return;
        if (/\.pptx$/i.test(vpath)) return importPptx(vpath);
        var r = await A.fs.read(vpath);
        if (!r.ok) { ctx.toast('開啟失敗：' + r.error, 't-err'); return; }
        try {
          var d = JSON.parse(r.data.content);
          // Version 1 and 2 decks have no objects and maybe no font; normSlide
          // fills both in, so an old file opens without a migration step.
          deck = {
            title: d.title || '未命名簡報',
            slides: (d.slides || []).length ? d.slides.map(normSlide) : [blank('title')]
          };
          if (d.font) { deckFont = d.font; fontSel.value = d.font; }
          if (d.scale) { deckScale = d.scale; scaleSel.value = String(d.scale); }
        } catch (e) { ctx.toast('格式不對：' + e.message, 't-err'); return; }
        path = vpath;
        // The version loaded, which a later save claims to be replacing.
        pathMtime = r.data.mtime;
        cur = 0;
        selId = null;
        dirty = false;
        undoStack = [];
        redoStack = [];
        render();
        ctx.setTitle('簡報 — ' + deck.title);
      }

      /* -------------------------------------------------------- listeners */

      layoutSel.addEventListener('change', function () {
        var s = slide();
        if (!s) return;
        edit(function () {
          s.layout = layoutSel.value;
          s.body = normBody(s.body, s.layout);
        });
      });
      btnAdd.addEventListener('click', function () { edit(function () { addSlide(cur + 1, { layout: 'bullets' }); }); });
      btnDel.addEventListener('click', function () {
        try { edit(function () { deleteSlide(cur); }); } catch (e) { ctx.toast(e.message, 't-warn'); }
      });
      btnUp.addEventListener('click', function () {
        try { edit(function () { moveSlide(cur, cur - 1); }); } catch (e) { ctx.toast(e.message, 't-warn'); }
      });
      btnDown.addEventListener('click', function () {
        try { edit(function () { moveSlide(cur, cur + 1); }); } catch (e) { ctx.toast(e.message, 't-warn'); }
      });
      btnUndo.addEventListener('click', undo);
      btnRedo.addEventListener('click', redo);
      fontSel.addEventListener('change', async function () {
        var chosen = await AIOS.fonts.resolveChoice(fontSel.value, ctx.win.el);
        if (chosen === null) { fontSel.value = deckFont; return; }
        deckFont = chosen || deckFont;
        fontSel.value = deckFont;
        markDirty();
        render();
        ctx.toast('簡報字型改成 ' + deckFont, 't-ok');
      });
      scaleSel.addEventListener('change', function () {
        deckScale = Number(scaleSel.value) || 100;
        markDirty();
        render();
      });

      btnTable.addEventListener('click', function () { tablePicker(btnTable); });
      btnShape.addEventListener('click', function () { shapePicker(btnShape); });
      btnImage.addEventListener('click', function () { insertImage(); });
      btnBox.addEventListener('click', function () {
        edit(function () { addObject(cur, { kind: 'text', text: '' }); });
      });
      btnChart.addEventListener('click', function () { chartPopover(btnChart, null); });

      btnPlay.addEventListener('click', function () { present(cur); });
      btnSave.addEventListener('click', function () { save(); });
      btnSaveAs.addEventListener('click', function () { saveAs(); });
      btnExport.addEventListener('click', function () { exportPicker(btnExport); });

      ctx.win.el.addEventListener('keydown', onKey);

      /* ------------------------------------------------------------ wiring */

      function objectSummary(o, n) {
        var what = KINDS[o.kind];
        var detail = o.kind === 'table'
                     ? o.rows[0].length + '欄×' + o.rows.length + '列' +
                       ((o.merges || []).length
                         ? '，合併 ' + o.merges.map(AIOS.grid.label).join('、') : '') +
                       (Object.keys(o.cellStyles || {}).length
                         ? '，' + Object.keys(o.cellStyles).length + ' 格有框線或網底' : '')
                   : o.kind === 'image' ? (o.src || '（沒有圖）')
                   : o.kind === 'shape' ? (SHAPES[o.shape] || SHAPES.rect).name +
                                          (o.text ? '「' + o.text + '」' : '')
                   : o.kind === 'chart' ? AIOS.charts.describe(o.chart)
                   : '「' + String(o.text || '').slice(0, 40) + '」';
        return '      物件 ' + n + '. ' + what + ' ' + detail +
               '　位置 ' + Math.round(o.x) + '%,' + Math.round(o.y) + '%' +
               '　大小 ' + Math.round(o.w) + '×' + Math.round(o.h) + '%';
      }

      function publish() {
        ctx.publish('簡報「' + deck.title + '」共 ' + deck.slides.length + ' 頁：\n' +
          deck.slides.map(function (s, i) {
            var n = (s.objects || []).length;
            return '  ' + (i + 1) + '. [' + s.layout + '] ' + s.title +
                   (n ? '（' + n + ' 個物件）' : '');
          }).join('\n'), 'app/slides');
      }

      ctx.describe(function () {
        return [
          '檔案：' + (path || '（新簡報）') + (dirty ? '（未儲存）' : ''),
          '簡報標題：' + deck.title,
          '目前在第 ' + (cur + 1) + ' 頁',
          '可用版面：' + Object.keys(LAYOUTS).map(function (k) { return k + '(' + LAYOUTS[k] + ')'; }).join('、'),
          '物件座標是投影片寬高的百分比（左上角是 0,0；右下角是 100,100），' +
            '字級 size 是點數（標準投影片高 540pt）。',
          '可用圖案：' + Object.keys(SHAPES).map(function (k) { return k + '(' + SHAPES[k].name + ')'; }).join('、'),
          '可用顏色名稱：' + AIOS.palette.fills.map(function (c) { return c.name; }).join('、') +
            '（也可以直接給 #RRGGBB）',
          '可用圖表類型：' + AIOS.charts.TYPES.map(function (t) { return t.id + '(' + t.name + ')'; }).join('、') +
            '（addChart 給 rows 或 categories + series；newSlide:true 會另起一頁放）',
          '頁面內容（編號就是 setSlide / addObject 的 index，物件編號就是 object）：',
          deck.slides.map(function (s, i) {
            var lines = ['  ' + (i + 1) + '. [' + s.layout + '] ' + (s.title || '（無標題）'),
              '      ' + (s.body || []).join(' ／ ').replace(/\n/g, ' / ').slice(0, 300)];
            (s.objects || []).forEach(function (o, j) { lines.push(objectSummary(o, j + 1)); });
            if (s.notes) lines.push('      備忘：' + s.notes.slice(0, 150));
            return lines.join('\n');
          }).join('\n')
        ].join('\n');
      });

      ctx.saveKeys(save, saveAs);

      /* Right-click. On a thumbnail the menu acts on that slide and switches to
         it first, so what the menu says and what the stage shows agree; on an
         object it acts on that object. */
      ctx.setMenu(function (ev) {
        var thumb = ev.target.closest ? ev.target.closest('.sl-thumb') : null;
        var objEl = ev.target.closest ? ev.target.closest('.sl-obj') : null;
        var head = [];

        if (objEl) {
          var o = findObj(objEl.dataset.id);
          if (o) {
            if (selId !== o.id) selectObject(o.id);
            var list = objects();
            head = tableMenu(o, ev).concat(chartMenu(o, ev)).concat([
              { label: KINDS[o.kind] + '（第 ' + (list.indexOf(o) + 1) + ' 個物件）', disabled: true },
              { label: '格式…', run: function () { formatPopover(); } },
              { label: '上移一層', hint: 'Ctrl+]', run: function () { layerSelected(1); } },
              { label: '下移一層', hint: 'Ctrl+[', run: function () { layerSelected(-1); } },
              { label: '移到最上層', run: function () { layerSelected(list.length); } },
              { label: '移到最下層', run: function () { layerSelected(-list.length); } },
              { label: '複製物件', hint: 'Ctrl+D', run: duplicateSelected },
              { label: '刪除物件', hint: 'Delete', danger: true, run: function () {
                edit(function () { list.splice(list.indexOf(o), 1); selId = null; });
              } },
              { sep: true }
            ]);
          }
        } else if (thumb) {
          var i = [].indexOf.call(rail.children, thumb);
          if (i >= 0) {
            if (i !== cur) goto(i);
            head = [
              { label: '第 ' + (i + 1) + ' 頁', disabled: true },
              { label: '從這頁開始放映', run: function () { present(i); } },
              { label: '在後面插入一頁', run: function () { edit(function () { addSlide(i + 1, {}); }); } },
              { label: '複製這頁', run: function () {
                edit(function () {
                  addSlide(i + 1, JSON.parse(JSON.stringify(deck.slides[i])));
                  // A duplicated slide's objects need their own identities.
                  objects().forEach(function (o) { o.id = uid(); });
                });
              } },
              { label: '往前移一頁', disabled: i === 0, run: function () {
                edit(function () { moveSlide(i, i - 1); });
              } },
              { label: '往後移一頁', disabled: i >= deck.slides.length - 1, run: function () {
                edit(function () { moveSlide(i, i + 1); });
              } },
              { label: '刪除這頁', danger: true, disabled: deck.slides.length <= 1, run: function () {
                edit(function () { deleteSlide(i); });
              } },
              { sep: true }
            ];
          }
        }

        return head.concat([
          { label: '插入表格…', run: function () { tablePicker(btnTable); } },
          { label: '插入圖片…', run: function () { insertImage(); } },
          { label: '插入圖案…', run: function () { shapePicker(btnShape); } },
          { label: '插入文字方塊', run: function () {
            edit(function () { addObject(cur, { kind: 'text', text: '' }); });
          } },
          { label: '插入圖表…', run: function () { chartPopover(btnChart, null); } },
          { sep: true },
          { label: '放映', run: function () { present(cur); } },
          { label: '字型：' + deckFont + '　' + deckScale + '%', disabled: true },
          { sep: true },
          { label: '儲存', hint: 'Ctrl+S', run: function () { save(); } },
          { label: '另存新檔…', hint: 'Ctrl+Shift+S', run: function () { saveAs(); } },
          { label: '匯出 PowerPoint', run: function () { exportAs('pptx'); } },
          { label: '匯出 Markdown', run: function () { exportAs('md'); } },
          { label: '匯出單一 HTML', run: function () { exportAs('html'); } },
          { label: '匯出 PDF（一頁一張）', run: function () { exportAs('pdf'); } },
          { sep: true },
          { label: '復原', hint: 'Ctrl+Z', disabled: !undoStack.length, run: undo },
          { label: '重做', hint: 'Ctrl+Y', disabled: !redoStack.length, run: redo },
          { label: '開啟檔案…', run: function () { AIOS.apps.launch('files'); } }
        ]);
      });

      ctx.api = {
        setSlide: setSlide, addSlide: addSlide, deleteSlide: deleteSlide, moveSlide: moveSlide,
        buildDeck: buildDeck, present: present, save: save, saveAs: saveAs, exportAs: exportAs,
        addObject: addObject, addTable: addTable, addChart: addChart, setObject: setObject,
        deleteObject: deleteObject, setTableStyle: setTableStyle,
        tableToChart: tableToChart, chartToTable: chartToTable, chartToApp: chartToApp,
        setFont: function (spec) {
          var s = spec || {};
          if (s.font) { deckFont = String(s.font).slice(0, 64); fontSel.value = deckFont; }
          var n = Number(s.scale);
          if (Number.isFinite(n) && n > 0) {
            deckScale = Math.max(50, Math.min(300, Math.round(n)));
            scaleSel.value = String(deckScale);
          }
          if (!s.font && !Number.isFinite(n)) throw new Error('要給 font 或 scale');
          markDirty();
          render();
          return '簡報改成 ' + deckFont + '　' + deckScale + '%';
        },
        fontState: function () { return { font: deckFont, scale: deckScale }; },
        open: open, snapshot: snapshot, undo: undo, redo: redo
      };

      (async function boot() {
        var st = ctx.state;
        if (st && st.deck) {
          // A restored session may hold a deck saved before objects existed.
          adopt(st.deck);
          cur = Math.max(0, Math.min(st.cur || 0, deck.slides.length - 1));
          path = st.path || null;
          // Not read this session, so no claim about the version on disk.
          pathMtime = null;
          dirty = !!st.dirty;
          render();
          if (path) ctx.setTitle('簡報 — ' + deck.title);
        } else if (typeof ctx.arg === 'string') {
          await open(ctx.arg);
        } else {
          render();
        }
      })();

      return {
        getState: function () { return { deck: deck, cur: cur, path: path, dirty: dirty }; },
        reopen: function (p) { if (typeof p === 'string') open(p); },
        /* Read by the window before it closes, so a deck with unsaved changes is
           not thrown away by one click on the X. */
        unsaved: function () { return dirty; },
        docName: function () { return path || deck.title; },
        save: save,
        onClose: function () {
          if (overlay) overlay.remove();
          closePop();
          ctx.publish(null);
        }
      };
    }
  });
})();

