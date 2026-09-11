'use strict';

/* ===========================================================================
   AI-OS // DrawingML charts
   ---------------------------------------------------------------------------
   The chart part shared by the three Office writers. A chart in a .docx, an
   .xlsx and a .pptx is the same `c:chartSpace` part; only the frame around it
   differs (an inline drawing, a worksheet anchor, a slide graphicFrame), and
   those frames stay in office.js next to the writers that own them.

   Written from the editors' own chart shape (see app/renderer/charts.js):

     { type, title, categories, series: [{ name, values, colour }],
       legend, labels, numFmt, xTitle, yTitle }

   THE DATA IS CACHED, NOT LINKED

   Excel keeps a chart's numbers in the cells it points at; Word and PowerPoint
   keep them in an embedded workbook. Neither is available from here for a .docx
   or .pptx, so every series carries its values in the part's own cache
   (`c:numCache`, `c:strCache`) behind a reference that names where they would
   be. Office draws from the cache, so the chart opens and looks right; what it
   cannot do is 「編輯資料」, which needs the workbook -- the README says so.
   For .xlsx the references are real cell ranges supplied by the spreadsheet,
   so there the chart is live in Excel as well.

   Element order inside a chart part is fixed by the schema and Office is
   strict about it: a `c:legend` before `c:plotArea` is a file that "needs
   repair". Every builder below writes children in schema order.
   =========================================================================== */

const charts = require('../renderer/charts.js');

const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const CHART_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const CHART_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart';
const CHART_GRAPHIC_URI = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
/* An embedded part that is a package of its own -- the little workbook a chart
   in a document or a deck keeps its numbers in. */
const PACKAGE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/package';
const SHEET_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

function esc(s) {
  // A control character in a pasted label would make the whole part malformed.
  return String(s == null ? '' : s)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function unesc(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/** A number the way a chart cache spells it: plain, no exponent noise. */
function numText(v) {
  if (v === null || v === undefined || !isFinite(v)) return '';
  const s = String(v);
  return /e/i.test(s) ? v.toFixed(10).replace(/\.?0+$/, '') : s;
}

/* ------------------------------------------------------------ pieces */

function solid(hex) {
  return `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;
}

/** Text properties for a whole element: a body with one default run. */
function txPr(opts = {}) {
  const sz = opts.size ? ` sz="${Math.round(opts.size * 100)}"` : '';
  const b = opts.bold ? ' b="1"' : '';
  const font = opts.font
    ? `<a:latin typeface="${esc(opts.font)}"/><a:ea typeface="${esc(opts.font)}"/><a:cs typeface="${esc(opts.font)}"/>`
    : '';
  const fill = opts.colour ? solid(opts.colour) : '';
  return '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr>' +
    `<a:defRPr${sz}${b}>${fill}${font}</a:defRPr></a:pPr>` +
    '<a:endParaRPr lang="zh-TW"/></a:p></c:txPr>';
}

/** A title (chart or axis) as rich text. */
function titleXml(text, opts = {}) {
  const sz = opts.size ? ` sz="${Math.round(opts.size * 100)}"` : '';
  const b = opts.bold === false ? ' b="0"' : ' b="1"';
  const font = opts.font
    ? `<a:latin typeface="${esc(opts.font)}"/><a:ea typeface="${esc(opts.font)}"/><a:cs typeface="${esc(opts.font)}"/>`
    : '';
  const fill = opts.colour ? solid(opts.colour) : '';
  // A title along a vertical axis reads bottom to top, the way Excel writes it.
  const body = opts.vertical ? '<a:bodyPr rot="-5400000" vert="horz"/>' : '<a:bodyPr/>';
  return '<c:title><c:tx><c:rich>' + body + '<a:lstStyle/><a:p>' +
    `<a:pPr><a:defRPr${sz}${b}>${fill}${font}</a:defRPr></a:pPr>` +
    `<a:r><a:rPr lang="zh-TW"${sz}${b}>${fill}${font}</a:rPr><a:t>${esc(text)}</a:t></a:r>` +
    '</a:p></c:rich></c:tx><c:overlay val="0"/></c:title>';
}

/** A string reference with its cache. `ref` may be null: then a literal. */
function strRef(ref, values) {
  const pts = values.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join('');
  if (!ref) return `<c:strLit><c:ptCount val="${values.length}"/>${pts}</c:strLit>`;
  return `<c:strRef><c:f>${esc(ref)}</c:f><c:strCache><c:ptCount val="${values.length}"/>${pts}</c:strCache></c:strRef>`;
}

/** A number reference with its cache; a null value has no point (a gap). */
function numRef(ref, values, formatCode) {
  const pts = values.map((v, i) => v === null || v === undefined || !isFinite(v)
    ? '' : `<c:pt idx="${i}"><c:v>${numText(v)}</c:v></c:pt>`).join('');
  const fmt = `<c:formatCode>${esc(charts.excelFormatCode(formatCode) || 'General')}</c:formatCode>`;
  if (!ref) return `<c:numLit>${fmt}<c:ptCount val="${values.length}"/>${pts}</c:numLit>`;
  return `<c:numRef><c:f>${esc(ref)}</c:f><c:numCache>${fmt}<c:ptCount val="${values.length}"/>${pts}</c:numCache></c:numRef>`;
}

/** Data labels: the five booleans are all required once any is stated. */
function dLbls(opts) {
  const o = opts || {};
  if (!o.on) return '';
  const fmt = o.numFmt ? `<c:numFmt formatCode="${esc(charts.excelFormatCode(o.numFmt))}" sourceLinked="0"/>` : '';
  const pos = o.pos ? `<c:dLblPos val="${o.pos}"/>` : '';
  return `<c:dLbls>${fmt}${o.txPr || ''}${pos}<c:showLegendKey val="0"/>` +
    `<c:showVal val="${o.percent ? 0 : 1}"/><c:showCatName val="0"/><c:showSerName val="0"/>` +
    `<c:showPercent val="${o.percent ? 1 : 0}"/><c:showBubbleSize val="0"/>` +
    (o.percent ? '<c:showLeaderLines val="0"/>' : '') + '</c:dLbls>';
}

function catAx(id, crossId, opts) {
  const o = opts || {};
  return `<c:catAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/>` +
    `<c:axPos val="${o.pos || 'b'}"/>` +
    (o.title ? titleXml(o.title, { size: o.size, bold: false, font: o.font, colour: o.colour, vertical: o.pos === 'l' }) : '') +
    '<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/>' +
    '<c:tickLblPos val="low"/>' + (o.txPr || '') +
    `<c:crossAx val="${crossId}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/>` +
    '<c:noMultiLvlLbl val="0"/></c:catAx>';
}

function valAx(id, crossId, opts) {
  const o = opts || {};
  const fmt = o.numFmt ? `<c:numFmt formatCode="${esc(charts.excelFormatCode(o.numFmt))}" sourceLinked="0"/>`
    : '<c:numFmt formatCode="General" sourceLinked="1"/>';
  return `<c:valAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/>` +
    `<c:axPos val="${o.pos || 'l'}"/>` +
    (o.grid === false ? '' : '<c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>') +
    (o.title ? titleXml(o.title, { size: o.size, bold: false, font: o.font, colour: o.colour, vertical: o.pos !== 'b' }) : '') +
    fmt + '<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>' + (o.txPr || '') +
    `<c:crossAx val="${crossId}"/><c:crosses val="autoZero"/><c:crossBetween val="${o.between || 'between'}"/></c:valAx>`;
}

/* ------------------------------------------------------------ writer */

/**
 * A whole chart part.
 *
 * opts:
 *   font      typeface for every text in the chart
 *   size      base type size in points (default 10)
 *   colour    text colour, bare hex (default 404040)
 *   refs      { cat, tx: [], val: [] } cell references from the spreadsheet;
 *             absent for documents and decks, where synthetic ones are written
 *   sheet     the name used in synthetic references (default 工作表1)
 */
function chartSpaceXml(rawSpec, opts = {}) {
  const spec = charts.norm(rawSpec);
  const t = charts.typeOf(spec.type);
  const font = opts.font || null;
  const size = Number(opts.size) || 10;
  const colour = opts.colour || '404040';
  const refs = opts.refs || null;
  const n = spec.categories.length;

  /* A reference, or nothing -- and nothing means the numbers are written into
     the part itself as literals.

     Only the spreadsheet knows cells, so only it supplies references, and there
     the chart is live: Excel resolves the range and redraws when a figure
     changes. A document and a deck have no workbook behind them, so a
     reference would name a sheet that does not exist. Inventing one looks
     harmless -- Word and PowerPoint fall back to the cached numbers and draw
     the chart correctly -- but Excel prefers the reference over the cache, so a
     chart written that way into a workbook came up empty in the one program
     that could resolve it. Literals say what is true: these are the numbers,
     there is nowhere else to look. */
  function catRef() { return refs && refs.cat !== undefined ? refs.cat : null; }
  function txRef(k) { return refs && refs.tx ? (refs.tx[k] === undefined ? null : refs.tx[k]) : null; }
  function valRef(k) { return refs && refs.val ? (refs.val[k] === undefined ? null : refs.val[k]) : null; }

  const textPr = txPr({ size: size, font: font, colour: colour });
  const smallPr = txPr({ size: size * 0.9, font: font, colour: colour });
  const isPie = t.family === 'pie';
  const isScatter = t.family === 'scatter';
  const series = isPie ? spec.series.slice(0, 1) : isScatter ? spec.series.slice(0, charts.SCATTER_SERIES) : spec.series;

  function serTx(k) {
    const ref = txRef(k);
    const name = series[k].name;
    if (!ref) return `<c:tx><c:v>${esc(name)}</c:v></c:tx>`;
    return `<c:tx><c:strRef><c:f>${esc(ref)}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${esc(name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>`;
  }
  function serColour(k) { return (series[k].colour || charts.COLOURS[k % charts.COLOURS.length]); }

  let plot = '';
  const AX_CAT = 10, AX_VAL = 20;
  if (t.family === 'bar') {
    plot = `<c:barChart><c:barDir val="${t.horizontal ? 'bar' : 'col'}"/>` +
      `<c:grouping val="${t.stacked ? 'stacked' : 'clustered'}"/><c:varyColors val="0"/>` +
      series.map((s, k) =>
        `<c:ser><c:idx val="${k}"/><c:order val="${k}"/>${serTx(k)}` +
        `<c:spPr>${solid(serColour(k))}<a:ln><a:noFill/></a:ln></c:spPr><c:invertIfNegative val="0"/>` +
        dLbls({ on: spec.labels, numFmt: spec.numFmt, txPr: smallPr, pos: t.stacked ? 'ctr' : 'outEnd' }) +
        `<c:cat>${strRef(catRef(), spec.categories)}</c:cat>` +
        `<c:val>${numRef(valRef(k), s.values, spec.numFmt)}</c:val></c:ser>`).join('') +
      `<c:gapWidth val="150"/>${t.stacked ? '<c:overlap val="100"/>' : ''}` +
      `<c:axId val="${AX_CAT}"/><c:axId val="${AX_VAL}"/></c:barChart>`;
  } else if (t.family === 'line') {
    plot = '<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>' +
      series.map((s, k) =>
        `<c:ser><c:idx val="${k}"/><c:order val="${k}"/>${serTx(k)}` +
        `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${serColour(k)}"/></a:solidFill><a:round/></a:ln></c:spPr>` +
        `<c:marker><c:symbol val="circle"/><c:size val="6"/><c:spPr>${solid(serColour(k))}<a:ln><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:marker>` +
        dLbls({ on: spec.labels, numFmt: spec.numFmt, txPr: smallPr, pos: 't' }) +
        `<c:cat>${strRef(catRef(), spec.categories)}</c:cat>` +
        `<c:val>${numRef(valRef(k), s.values, spec.numFmt)}</c:val><c:smooth val="0"/></c:ser>`).join('') +
      `<c:marker val="1"/><c:axId val="${AX_CAT}"/><c:axId val="${AX_VAL}"/></c:lineChart>`;
  } else if (t.family === 'area') {
    plot = `<c:areaChart><c:grouping val="${t.stacked ? 'stacked' : 'standard'}"/><c:varyColors val="0"/>` +
      series.map((s, k) =>
        `<c:ser><c:idx val="${k}"/><c:order val="${k}"/>${serTx(k)}` +
        `<c:spPr><a:solidFill><a:srgbClr val="${serColour(k)}"><a:alpha val="${t.stacked ? 60000 : 35000}"/></a:srgbClr></a:solidFill>` +
        `<a:ln w="19050"><a:solidFill><a:srgbClr val="${serColour(k)}"/></a:solidFill></a:ln></c:spPr>` +
        dLbls({ on: spec.labels, numFmt: spec.numFmt, txPr: smallPr }) +
        `<c:cat>${strRef(catRef(), spec.categories)}</c:cat>` +
        `<c:val>${numRef(valRef(k), s.values, spec.numFmt)}</c:val></c:ser>`).join('') +
      `<c:axId val="${AX_CAT}"/><c:axId val="${AX_VAL}"/></c:areaChart>`;
  } else if (isPie) {
    const s = series[0] || { name: '數列 1', values: [] };
    // Slice colours follow the renderer: the eighth and later slices are the
    // de-emphasis grey that the drawing folds into 其他.
    const pts = spec.categories.map((c, i) =>
      `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr>${solid(charts.sliceColour(i, spec.categories.length))}<a:ln><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>`).join('');
    const tag = t.hole ? 'doughnutChart' : 'pieChart';
    plot = `<c:${tag}><c:varyColors val="1"/>` +
      `<c:ser><c:idx val="0"/><c:order val="0"/>${serTx(0)}${pts}` +
      dLbls({ on: spec.labels, percent: true, txPr: smallPr, pos: t.hole ? null : 'bestFit' }) +
      `<c:cat>${strRef(catRef(), spec.categories)}</c:cat>` +
      `<c:val>${numRef(valRef(0), s.values, spec.numFmt)}</c:val></c:ser>` +
      '<c:firstSliceAng val="0"/>' + (t.hole ? '<c:holeSize val="50"/>' : '') + `</c:${tag}>`;
  } else if (isScatter) {
    const xs = spec.categories.map((c) => charts.toNumber(c));
    // A point missing on either axis is missing on both: the caches stay
    // index-aligned, which is what makes a gap a gap and not a shifted point.
    const pair = (values) => ({
      x: xs.map((x, i) => (x === null || values[i] === null || values[i] === undefined ? null : x)),
      y: values.map((v, i) => (xs[i] === null ? null : v))
    });
    plot = '<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>' +
      series.map((s, k) =>
        `<c:ser><c:idx val="${k}"/><c:order val="${k}"/>${serTx(k)}` +
        '<c:spPr><a:ln w="19050"><a:noFill/></a:ln></c:spPr>' +
        `<c:marker><c:symbol val="circle"/><c:size val="7"/><c:spPr>${solid(serColour(k))}<a:ln><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:marker>` +
        dLbls({ on: spec.labels, numFmt: spec.numFmt, txPr: smallPr, pos: 't' }) +
        `<c:xVal>${numRef(catRef(), pair(s.values).x, 'General')}</c:xVal>` +
        `<c:yVal>${numRef(valRef(k), pair(s.values).y, spec.numFmt)}</c:yVal><c:smooth val="0"/></c:ser>`).join('') +
      `<c:axId val="${AX_CAT}"/><c:axId val="${AX_VAL}"/></c:scatterChart>`;
  }

  let axes = '';
  if (!isPie) {
    const axOpts = { size: size, font: font, colour: colour, txPr: smallPr };
    if (isScatter) {
      axes = valAx(AX_CAT, AX_VAL, Object.assign({}, axOpts, { pos: 'b', title: spec.xTitle, between: 'midCat', grid: true })) +
             valAx(AX_VAL, AX_CAT, Object.assign({}, axOpts, { pos: 'l', title: spec.yTitle, numFmt: spec.numFmt, between: 'midCat' }));
    } else if (t.horizontal) {
      axes = catAx(AX_CAT, AX_VAL, Object.assign({}, axOpts, { pos: 'l', title: spec.xTitle })) +
             valAx(AX_VAL, AX_CAT, Object.assign({}, axOpts, { pos: 'b', title: spec.yTitle, numFmt: spec.numFmt }));
    } else {
      axes = catAx(AX_CAT, AX_VAL, Object.assign({}, axOpts, { pos: 'b', title: spec.xTitle })) +
             valAx(AX_VAL, AX_CAT, Object.assign({}, axOpts, { pos: 'l', title: spec.yTitle, numFmt: spec.numFmt, between: t.family === 'area' ? 'midCat' : 'between' }));
    }
  }

  const legend = spec.legend === 'none' || (!isPie && series.length < 2)
    ? ''
    : `<c:legend><c:legendPos val="${spec.legend === 'right' ? 'r' : 'b'}"/><c:overlay val="0"/>${smallPr}</c:legend>`;

  return XML_DECL +
    `<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">` +
    '<c:date1904 val="0"/><c:lang val="zh-TW"/><c:roundedCorners val="0"/>' +
    '<c:chart>' +
    (spec.title ? titleXml(spec.title, { size: size * 1.4, font: font, colour: colour }) + '<c:autoTitleDeleted val="0"/>'
                : '<c:autoTitleDeleted val="1"/>') +
    `<c:plotArea><c:layout/>${plot}${axes}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>` +
    legend +
    '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/>' +
    '</c:chart>' +
    `<c:spPr>${opts.fill && /^[0-9A-Fa-f]{6}$/.test(opts.fill) ? solid(opts.fill.toUpperCase()) : '<a:noFill/>'}<a:ln><a:noFill/></a:ln></c:spPr>` +
    textPr +
    /* The workbook this chart was drawn from, when the file carries one.
       Office greys out 「編輯資料」 without it; with it, the button opens the
       embedded sheet and the chart follows what is changed there. Last child
       of the chart space, which is where the schema puts it. */
    (opts.externalData
      ? `<c:externalData r:id="${opts.externalData}"><c:autoUpdate val="0"/></c:externalData>`
      : '') +
    '</c:chartSpace>';
}

/* ------------------------------------------------------------ reader */

function inner(xml, tag) {
  const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>').exec(xml);
  return m ? m[1] : null;
}
function attr(xml, tag, name) {
  const m = new RegExp('<' + tag + '\\b[^>]*?\\s' + name + '="([^"]*)"').exec(xml);
  return m ? unesc(m[1]) : null;
}
function val(xml, tag) { return attr(xml, tag, 'val'); }

/** Every `<c:pt idx="i"><c:v>…</c:v></c:pt>` inside a cache, by index. */
function points(cacheXml) {
  const out = {};
  let max = -1;
  const re = /<c:pt\b[^>]*\bidx="(\d+)"[^>]*>[\s\S]*?<c:v>([\s\S]*?)<\/c:v>[\s\S]*?<\/c:pt>/g;
  let m;
  while ((m = re.exec(cacheXml || ''))) {
    const i = Number(m[1]);
    out[i] = unesc(m[2]);
    if (i > max) max = i;
  }
  const count = Number(val(cacheXml || '', 'c:ptCount'));
  return { byIndex: out, count: isFinite(count) && count > max + 1 ? count : max + 1 };
}

/** The text of a rich title: every a:t joined. */
function richText(xml) {
  const out = [];
  const re = /<a:t>([\s\S]*?)<\/a:t>/g;
  let m;
  while ((m = re.exec(xml || ''))) out.push(unesc(m[1]));
  return out.join('');
}

/** Split the c:ser elements out of a plot element. */
function seriesOf(plotXml) {
  const out = [];
  const re = /<c:ser>([\s\S]*?)<\/c:ser>/g;
  let m;
  while ((m = re.exec(plotXml))) out.push(m[1]);
  return out;
}

/**
 * A chart spec back out of a chart part, plus the references it drew from.
 * Returns null when the XML holds no chart this module understands.
 */
function readChartSpace(xml) {
  const src = String(xml || '');
  const chart = inner(src, 'c:chart');
  if (!chart) return null;
  const plotArea = inner(chart, 'c:plotArea') || '';

  const kinds = [
    ['c:barChart', 'bar'], ['c:bar3DChart', 'bar'], ['c:lineChart', 'line'], ['c:line3DChart', 'line'],
    ['c:areaChart', 'area'], ['c:area3DChart', 'area'], ['c:pieChart', 'pie'], ['c:pie3DChart', 'pie'],
    ['c:doughnutChart', 'doughnut'], ['c:scatterChart', 'scatter'], ['c:ofPieChart', 'pie'], ['c:radarChart', 'line']
  ];
  let plot = null, family = null;
  for (const [tag, fam] of kinds) {
    const body = inner(plotArea, tag);
    if (body !== null) { plot = body; family = fam; break; }
  }
  if (plot === null) return null;

  const grouping = val(plot, 'c:grouping');
  const stacked = grouping === 'stacked' || grouping === 'percentStacked';
  let type = 'column';
  if (family === 'bar') {
    const horizontal = val(plot, 'c:barDir') === 'bar';
    type = horizontal ? (stacked ? 'stackedBar' : 'bar') : (stacked ? 'stackedColumn' : 'column');
  } else if (family === 'line') type = 'line';
  else if (family === 'area') type = stacked ? 'stackedArea' : 'area';
  else if (family === 'pie') type = 'pie';
  else if (family === 'doughnut') type = 'doughnut';
  else if (family === 'scatter') type = 'scatter';

  const refs = { cat: null, tx: [], val: [] };
  let categories = null;
  const series = [];
  let numFmt = '';

  seriesOf(plot).forEach((ser, k) => {
    const tx = inner(ser, 'c:tx');
    let name = '';
    let txRef = null;
    if (tx) {
      const f = inner(tx, 'c:f');
      txRef = f ? unesc(f) : null;
      const cache = inner(tx, 'c:strCache');
      if (cache) name = points(cache).byIndex[0] || '';
      else {
        const v = inner(tx, 'c:v');
        name = v ? unesc(v) : '';
      }
    }
    const catXml = inner(ser, family === 'scatter' ? 'c:xVal' : 'c:cat');
    if (catXml) {
      const f = inner(catXml, 'c:f');
      if (f && refs.cat === null) refs.cat = unesc(f);
      // A multi-level category axis keeps its innermost level only.
      const multi = inner(catXml, 'c:multiLvlStrRef');
      const cache = inner(catXml, 'c:strCache') || inner(catXml, 'c:numCache') ||
                    inner(catXml, 'c:strLit') || inner(catXml, 'c:numLit') ||
                    (multi ? inner(multi, 'c:lvl') : null);
      if (cache && categories === null) {
        const p = points(cache);
        categories = [];
        for (let i = 0; i < p.count; i++) categories.push(p.byIndex[i] === undefined ? String(i + 1) : p.byIndex[i]);
      }
    }
    const valXml = inner(ser, family === 'scatter' ? 'c:yVal' : 'c:val');
    const values = [];
    let valRef = null;
    if (valXml) {
      const f = inner(valXml, 'c:f');
      valRef = f ? unesc(f) : null;
      const cache = inner(valXml, 'c:numCache') || inner(valXml, 'c:numLit');
      if (cache) {
        const p = points(cache);
        for (let i = 0; i < p.count; i++) {
          const v = p.byIndex[i];
          values.push(v === undefined || v === '' ? null : charts.toNumber(v));
        }
        const fc = inner(cache, 'c:formatCode');
        if (fc && !numFmt && unesc(fc) !== 'General') numFmt = unesc(fc);
      }
    }
    refs.tx.push(txRef);
    refs.val.push(valRef);
    const out = { name: name || '數列 ' + (k + 1), values: values };
    const sp = inner(ser, 'c:spPr');
    const colour = sp ? attr(sp, 'a:srgbClr', 'val') : null;
    if (colour && /^[0-9A-Fa-f]{6}$/.test(colour)) out.colour = colour.toUpperCase();
    series.push(out);
  });

  const longest = series.reduce((m, s) => Math.max(m, s.values.length), 0);
  if (!categories) {
    categories = [];
    for (let i = 0; i < longest; i++) categories.push(String(i + 1));
  }

  const titleXmlIn = inner(chart, 'c:title');
  let title = '';
  if (titleXmlIn && chart.indexOf('<c:title>') < chart.indexOf('<c:plotArea')) {
    title = richText(titleXmlIn);
    // A title linked to a cell carries its text in the cache, not in a run.
    if (!title) {
      const cache = inner(titleXmlIn, 'c:strCache');
      if (cache) title = points(cache).byIndex[0] || '';
    }
  }

  const legendXml = inner(chart, 'c:legend');
  let legend = 'none';
  if (legendXml) {
    const pos = val(legendXml, 'c:legendPos');
    legend = pos === 'r' || pos === 'l' ? 'right' : 'bottom';
  }
  // A boolean written without val is true, per the schema's default.
  const labels = /<c:show(?:Val|Percent)(?:\s+val="(?:1|true)")?\s*\/>/.test(plot);

  let xTitle = '', yTitle = '';
  const catAxis = inner(plotArea, 'c:catAx') || inner(plotArea, 'c:dateAx');
  const valAxes = [];
  const vre = /<c:valAx>([\s\S]*?)<\/c:valAx>/g;
  let vm;
  while ((vm = vre.exec(plotArea))) valAxes.push(vm[1]);
  if (family === 'scatter') {
    xTitle = valAxes[0] ? richText(inner(valAxes[0], 'c:title') || '') : '';
    yTitle = valAxes[1] ? richText(inner(valAxes[1], 'c:title') || '') : '';
  } else {
    xTitle = catAxis ? richText(inner(catAxis, 'c:title') || '') : '';
    yTitle = valAxes[0] ? richText(inner(valAxes[0], 'c:title') || '') : '';
    const axFmt = valAxes[0] ? attr(valAxes[0], 'c:numFmt', 'formatCode') : null;
    const linked = valAxes[0] ? attr(valAxes[0], 'c:numFmt', 'sourceLinked') : null;
    if (axFmt && axFmt !== 'General' && linked === '0') numFmt = axFmt;
  }

  const spec = charts.norm({ type, title, categories, series, legend, labels, numFmt, xTitle, yTitle });
  return { spec, refs };
}

/* ---------------------------------------------------------- frames */

/** The body of `<c:chart>` element that points a frame at its part. */
function chartRefXml(rid) {
  return `<c:chart xmlns:c="${NS_C}" xmlns:r="${NS_R}" r:id="${rid}"/>`;
}

module.exports = {
  chartSpaceXml, readChartSpace, chartRefXml,
  CHART_CONTENT_TYPE, CHART_REL_TYPE, CHART_GRAPHIC_URI, PACKAGE_REL_TYPE, SHEET_CONTENT_TYPE,
  NS_C, NS_A, NS_R,
  esc, unesc
};
