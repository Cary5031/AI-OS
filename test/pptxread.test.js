'use strict';

/* ===========================================================================
   Reading a .pptx somebody else wrote
   ---------------------------------------------------------------------------
   The writer's tests ask whether PowerPoint can open what this makes. These ask
   the harder question in the other direction, and the difference between them
   is the whole reason reading was left undone for so long: a deck this
   application wrote is self-describing -- every shape carries its own
   coordinates and its own run properties -- while a deck PowerPoint wrote is
   mostly a set of references to a layout, a master and a theme.

   So the fixtures here are built by hand rather than by `writePptx`. Round-
   tripping our own output proves the plumbing and almost nothing about the
   format; a placeholder with no geometry and no `rPr` at all is what a real
   file looks like, and it is the only fixture that can fail in the ways that
   matter.

   The failure this is written against is quiet. Skip the lstStyle layers and
   the file still opens, with the title at the master's generic default instead
   of the layout's declared one -- a different size, in a different colour, with
   nothing reported anywhere.
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');

const zip = require('../app/main/zip');
const office = require('../app/main/office');

/* ----------------------------------------------------------------- fixture */

const D = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';

const rel = (id, type, target) => `<Relationship Id="${id}" Type="${REL}${type}" Target="${target}"/>`;
const rels = (...xs) => D +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  xs.join('') + '</Relationships>';
const tree = (body) => '<p:cSld><p:spTree>' +
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
  body + '</p:spTree></p:cSld>';

const THEME = D + '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T">' +
  '<a:themeElements><a:clrScheme name="S">' +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
  '</a:clrScheme><a:fontScheme name="F">' +
  '<a:majorFont><a:latin typeface="Cambria"/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme>' +
  '<a:fmtScheme name="M"/></a:themeElements></a:theme>';

/* The colour map is deliberately not the identity: `tx1` points at `dk2`, so a
   run asking for tx1 must come back 44546A and not black. A reader that skips
   the map gets a plausible-looking wrong answer on every themed colour. */
const MASTER = D + `<p:sldMaster ${NS}>` + tree(
  '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/>' +
    '<p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/></a:xfrm></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>' +
  '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/>' +
    '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="838200" y="1825625"/><a:ext cx="10515600" cy="4351338"/></a:xfrm></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>') +
  '<p:clrMap bg1="lt1" tx1="dk2" bg2="lt2" tx2="dk1" accent1="accent1" accent2="accent2" ' +
    'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" ' +
    'hlink="hlink" folHlink="folHlink"/>' +
  '<p:txStyles>' +
    '<p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle>' +
    '<p:bodyStyle><a:lvl1pPr><a:defRPr sz="2800"/></a:lvl1pPr>' +
      '<a:lvl3pPr><a:defRPr sz="1800" i="1"/></a:lvl3pPr></p:bodyStyle>' +
    '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>' +
  '</p:txStyles></p:sldMaster>';

/* The layout moves the title and restyles it: 88pt bold in accent1 darkened by
   lumMod, which is the shape a corporate template's title actually takes. The
   subtitle placeholder is left with an empty spPr on purpose, so its geometry
   has to come from the master a step further up. */
const LAYOUT = D + `<p:sldLayout ${NS} type="title">` + tree(
  '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/>' +
    '<p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="1524000" y="1122363"/><a:ext cx="9144000" cy="2387600"/></a:xfrm></p:spPr>' +
    '<p:txBody><a:bodyPr anchor="b"/><a:lstStyle><a:lvl1pPr algn="l"><a:defRPr sz="8800" b="1">' +
      '<a:solidFill><a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr></a:solidFill>' +
    '</a:defRPr></a:lvl1pPr></a:lstStyle><a:p/></p:txBody></p:sp>' +
  '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Subtitle 2"/><p:cNvSpPr/>' +
    '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>' +
    '<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>') +
  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

/** A package around one slide body. `sldSz` varies so the 4:3 case is testable. */
function pack(slideBody, { cx = 12192000, cy = 6858000, extra = {} } = {}) {
  const slide = D + `<p:sld ${NS}>` + tree(slideBody) + '</p:sld>';
  const pres = D + `<p:presentation ${NS}>` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
    `<p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  return zip.write(Object.assign({
    'ppt/presentation.xml': pres,
    'ppt/_rels/presentation.xml.rels': rels(
      rel('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'),
      rel('rId2', 'slide', 'slides/slide1.xml')),
    'ppt/slides/slide1.xml': slide,
    'ppt/slides/_rels/slide1.xml.rels': rels(
      rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')),
    'ppt/slideLayouts/slideLayout1.xml': LAYOUT,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels(
      rel('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml')),
    'ppt/slideMasters/slideMaster1.xml': MASTER,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels(
      rel('rId1', 'theme', '../theme/theme1.xml')),
    'ppt/theme/theme1.xml': THEME
  }, extra));
}

/** A placeholder shape that states nothing but its text. */
const ph = (id, name, phXml, paras) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/>` +
  `<p:nvPr>${phXml}</p:nvPr></p:nvSpPr><p:spPr/>` +
  `<p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>`;

const run = (t, rPr) => `<a:p><a:r><a:rPr lang="zh-TW"${rPr ? '>' + rPr + '</a:rPr>' : '/>'}` +
  `<a:t>${t}</a:t></a:r></a:p>`;

const TITLED = ph(2, 'Title 1', '<p:ph type="ctrTitle"/>', run('繼承來的標題'));

const read = (body, opts) => office.readPptx(pack(body, opts));
const objectsOf = (body, opts) => read(body, opts).slides[0].objects;

/* --------------------------------------------------------------- geometry */

test('a placeholder with no geometry of its own inherits it from the layout', () => {
  const o = objectsOf(TITLED)[0];
  // 1524000 / 12192000 and 1122363 / 6858000, as percentages of this file's slide.
  assert.equal(o.x, 12.5);
  assert.equal(o.y, 16.37);
  assert.equal(o.w, 75);
  assert.equal(o.h, 34.81);
});

test('and from the master when the layout is silent too', () => {
  /* The subtitle's layout placeholder has an empty `<p:spPr/>`, so the box has
     to come from the master, matched by type rather than by idx -- a slide
     inherits from its layout on idx, a layout inherits from its master on type,
     and using one rule for both leaves this shape with no position at all. */
  const o = objectsOf(TITLED + ph(3, 'Subtitle 2', '<p:ph type="body" idx="1"/>', run('副標')))[1];
  assert.equal(o.x, 6.88);      // 838200 / 12192000
  assert.equal(o.y, 26.62);     // 1825625 / 6858000
});

test('a shape that has no box anywhere is reported, not placed at the origin', () => {
  const orphan = '<p:sp><p:nvSpPr><p:cNvPr id="9" name="Loose"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>' + run('沒有位置') + '</p:txBody></p:sp>';
  const out = read(TITLED + orphan);
  assert.equal(out.slides[0].objects.length, 1, 'the orphan is not emitted');
  assert.ok(out.warnings.some((w) => /沒有位置也繼承不到/.test(w)), out.warnings.join(' | '));
});

/* ------------------------------------------------------------------- text */

test('the layout text style beats the master one', () => {
  /* 88 from the layout's lstStyle, not 44 from the master's titleStyle. This is
     the one that fails silently: both numbers are plausible and the file opens
     either way. */
  const o = objectsOf(TITLED)[0];
  assert.equal(o.size, 88);
  assert.equal(o.bold, true);
  assert.equal(o.align, 'left', 'the layout says l, the master says ctr');
  assert.equal(o.valign, 'bottom', 'from the layout bodyPr anchor');
});

test('the master text style applies where no layout style exists', () => {
  const o = objectsOf(TITLED + ph(3, 'Subtitle 2', '<p:ph type="body" idx="1"/>', run('第一層')))[1];
  assert.equal(o.size, 28, 'from <p:bodyStyle>, which is presentationml, not drawingml');
});

test('an outline level is matched exactly, never falling back to level one', () => {
  /* A master whose bodyStyle defines lvl1pPr and lvl3pPr must give a level-three
     paragraph the level-three size. Falling back to lvl1 would hand every deep
     bullet in the deck the size of the first, which looks like a design choice
     rather than a bug. The model keeps one size per box, so what the assertion
     can see is that the two levels disagreed and that it was said out loud. */
  const body = ph(3, 'Body', '<p:ph type="body" idx="1"/>',
    run('第一層') + '<a:p><a:pPr lvl="2"/><a:r><a:rPr lang="zh-TW"/><a:t>第三層</a:t></a:r></a:p>');
  const out = read(TITLED + body);
  assert.equal(out.slides[0].objects[1].size, 28, 'the box takes the first paragraph');
  assert.ok(out.warnings.some((w) => /多層次的項目/.test(w)), out.warnings.join(' | '));
});

test('runs disagreeing inside one paragraph is a different sentence from levels', () => {
  /* Two losses, two messages. Bolding three words in a sentence has no place in
     this model; an outline having two sizes is every bulleted slide there is,
     and one warning covering both would sit on almost every slide. */
  const mixed = ph(3, 'Body', '<p:ph type="body" idx="1"/>',
    '<a:p><a:r><a:rPr lang="zh-TW" b="1"/><a:t>粗的</a:t></a:r>' +
    '<a:r><a:rPr lang="zh-TW" b="0"/><a:t>不粗的</a:t></a:r></a:p>');
  const out = read(TITLED + mixed);
  assert.ok(out.warnings.some((w) => /個別幾個字的格式/.test(w)), out.warnings.join(' | '));
  assert.ok(!out.warnings.some((w) => /多層次的項目/.test(w)), 'and not the other one');
  assert.equal(out.slides[0].objects[1].text, '粗的不粗的', 'the text is still whole');
});

test('a line break inside a paragraph stays a line break', () => {
  const body = ph(3, 'Body', '<p:ph type="body" idx="1"/>',
    '<a:p><a:r><a:rPr lang="zh-TW"/><a:t>上</a:t></a:r><a:br/>' +
    '<a:r><a:rPr lang="zh-TW"/><a:t>下</a:t></a:r></a:p>');
  assert.equal(objectsOf(TITLED + body)[1].text, '上\n下');
});

/* ----------------------------------------------------------------- colour */

test('a theme colour goes through the master colour map', () => {
  /* The map here is not the identity: bg2 points at lt2, so the answer is
     E7E6E6. A reader that looks the slot name straight up in the theme finds no
     bg2 at all and comes back with nothing, on every themed run in the deck. */
  const body = ph(3, 'Body', '<p:ph type="body" idx="1"/>',
    run('用 bg2 上色', '<a:solidFill><a:schemeClr val="bg2"/></a:solidFill>'));
  assert.equal(objectsOf(TITLED + body)[1].colour, 'E7E6E6');

  /* And the map is what makes a shaded tx1 land on a shade of slate rather than
     a shade of black: tx1 -> dk2 -> 44546A, lightened. */
  const slate = ph(3, 'Body', '<p:ph type="body" idx="1"/>',
    run('調過的 tx1', '<a:solidFill><a:schemeClr val="tx1">' +
      '<a:lumMod val="75000"/></a:schemeClr></a:solidFill>'));
  const c = objectsOf(TITLED + slate)[1].colour;
  assert.ok(/^3[0-9A-F]{5}$/.test(c) || c.slice(0, 2) !== '00',
    '走過 clrMap 的話是 44546A 調亮度，不是黑色：' + c);
});

test('lumMod on an accent gives the shade the colour picker shows', () => {
  /* accent1 4472C4 at lumMod 50% is what Office calls "Blue, Accent 1, Darker
     50%" and writes as 203864. Themes almost never reference an accent bare, so
     dropping the modifiers collapses a whole row of swatches onto one colour. */
  assert.equal(objectsOf(TITLED)[0].colour, '203864');
});

/* ---------------------------------------------------------------- objects */

test('a filled preset shape is a shape, an empty rectangle is a text box', () => {
  const shape = (id, prst, fill, x) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="S${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="100000"/><a:ext cx="1000000" cy="1000000"/></a:xfrm>` +
    `<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>${fill}</p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/>${run('字')}</p:txBody></p:sp>`;
  /* Every box this application writes carries txBox="1", shapes included, so
     asking that flag first would turn a hexagon of our own making back into a
     text box. Geometry decides, and the bare rectangle is the tie-break. */
  const out = objectsOf(
    shape(5, 'hexagon', '<a:solidFill><a:srgbClr val="C0504D"/></a:solidFill>', 100000) +
    shape(6, 'rect', '', 3000000));
  assert.equal(out[0].kind, 'shape');
  assert.equal(out[0].shape, 'hexagon');
  assert.equal(out[0].fill, 'C0504D');
  assert.equal(out[1].kind, 'text');
});

test('a preset this gallery does not have becomes a rectangle and says so', () => {
  const odd = '<p:sp><p:nvSpPr><p:cNvPr id="5" name="S"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="1000000"/></a:xfrm>' +
    '<a:prstGeom prst="cloud"><a:avLst/></a:prstGeom>' +
    '<a:solidFill><a:srgbClr val="70AD47"/></a:solidFill></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/>' + run('雲') + '</p:txBody></p:sp>';
  const out = read(odd);
  assert.equal(out.slides[0].objects[0].shape, 'rect');
  assert.ok(out.warnings.some((w) => /cloud/.test(w)), out.warnings.join(' | '));
});

test('a group places its children where the group is, not where they were drawn', () => {
  /* A group states its place in the parent and, separately, the coordinate
     space its children were authored in. Resizing a group changes the first and
     leaves the second, so ignoring the pair puts every grouped shape at its
     pre-resize position -- off the slide entirely for a group scaled down. */
  const inner = '<p:sp><p:nvSpPr><p:cNvPr id="7" name="In"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="2000000" cy="2000000"/></a:xfrm>' +
    '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>' +
    '<a:solidFill><a:srgbClr val="ED7D31"/></a:solidFill></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/>' + run('圓') + '</p:txBody></p:sp>';
  const group = '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="6" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="6096000" y="0"/><a:ext cx="2000000" cy="2000000"/>' +
    '<a:chOff x="1000000" y="1000000"/><a:chExt cx="4000000" cy="4000000"/></a:xfrm></p:grpSpPr>' +
    inner + '</p:grpSp>';
  const out = read(group);
  const o = out.slides[0].objects[0];
  assert.equal(out.slides[0].objects.length, 1, 'the group itself is not an object');
  // Child at the group's own child origin lands at the group's origin, at half scale.
  assert.equal(o.x, 50);                       // 6096000 / 12192000
  assert.equal(o.y, 0);
  assert.equal(o.w, 8.2);                      // 2000000 * (2000000/4000000) / 12192000
  assert.ok(out.warnings.some((w) => /群組已攤平/.test(w)), out.warnings.join(' | '));
});

test('a group is not also read as loose shapes', () => {
  /* Collecting elements by name alone finds the children twice: once through
     the group and once as top-level shapes, so every grouped object is drawn on
     top of itself. Depth has to be counted over every element, not the wanted
     ones. */
  const inner = '<p:sp><p:nvSpPr><p:cNvPr id="7" name="In"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="1000000"/></a:xfrm>' +
    '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>' +
    '<a:solidFill><a:srgbClr val="ED7D31"/></a:solidFill></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/>' + run('圓') + '</p:txBody></p:sp>';
  const group = '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="6" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="1000000"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="1000000" cy="1000000"/></a:xfrm></p:grpSpPr>' +
    inner + '</p:grpSp>';
  assert.equal(read(group).slides[0].objects.length, 1);
});

test('an AlternateContent is read through its fallback drawing', () => {
  /* SmartArt and anything a newer PowerPoint wrapped arrives this way, with a
     plain drawing of the same thing in the Fallback for readers that do not
     know the extension. Taking it is the difference between the shapes and a
     blank space. */
  const fallbackShape = '<p:sp><p:nvSpPr><p:cNvPr id="8" name="F"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1219200" cy="685800"/></a:xfrm>' +
    '<a:prstGeom prst="diamond"><a:avLst/></a:prstGeom>' +
    '<a:solidFill><a:srgbClr val="4472C4"/></a:solidFill></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/>' + run('替代') + '</p:txBody></p:sp>';
  const alt = '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
    '<mc:Choice Requires="x"><p:sp/></mc:Choice>' +
    '<mc:Fallback>' + fallbackShape + '</mc:Fallback></mc:AlternateContent>';
  const out = read(alt);
  assert.equal(out.slides[0].objects.length, 1);
  assert.equal(out.slides[0].objects[0].shape, 'diamond');
  assert.ok(out.warnings.some((w) => /圖形版本/.test(w)), out.warnings.join(' | '));
});

/* ----------------------------------------------------------------- tables */

test('a table comes back with its merges as rectangles', () => {
  /* Unlike a Word table, every covered cell is present and flagged, so the
     column index is the position -- but the region still has to be rebuilt as
     the rectangle the editor and the merge algebra work in. */
  const tc = (t, attrs) => `<a:tc${attrs || ''}><a:txBody><a:bodyPr/><a:lstStyle/>` +
    `<a:p><a:r><a:rPr lang="zh-TW" sz="1400"/><a:t>${t}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`;
  const frame = '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="T"/>' +
    '<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
    '<p:xfrm><a:off x="609600" y="685800"/><a:ext cx="6096000" cy="1371600"/></p:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
    '<a:tbl><a:tblPr firstRow="1" bandRow="1"/>' +
    '<a:tblGrid><a:gridCol w="2032000"/><a:gridCol w="2032000"/><a:gridCol w="2032000"/></a:tblGrid>' +
    '<a:tr h="685800">' + tc('項目', ' gridSpan="2"') + tc('', ' hMerge="1"') + tc('金額') + '</a:tr>' +
    '<a:tr h="685800">' + tc('滑鼠') + tc('3') + tc('2250') + '</a:tr>' +
    '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
  const o = objectsOf(frame)[0];
  assert.equal(o.kind, 'table');
  assert.deepEqual(o.rows, [['項目', '', '金額'], ['滑鼠', '3', '2250']]);
  assert.deepEqual(o.merges, [{ c0: 0, r0: 0, c1: 1, r1: 0 }]);
  assert.equal(o.header, true);
  assert.equal(o.banded, true);
  assert.equal(o.size, 14, 'taken from a body cell, not from the heading row');
});

/* --------------------------------------------------------------- the file */

test('the file states its own slide size, and a 4:3 deck is told about', () => {
  /* Percentages of this file's slide, not of an assumed 16:9 one. A 4:3 deck
     keeps its relative layout; what it cannot keep is its shape, because the
     canvas here is always 16:9. */
  const box = '<p:sp><p:nvSpPr><p:cNvPr id="5" name="S"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="4572000" y="3429000"/><a:ext cx="4572000" cy="3429000"/></a:xfrm>' +
    '</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>' + run('半') + '</p:txBody></p:sp>';
  const out = read(box, { cx: 9144000, cy: 6858000 });
  assert.equal(out.slides[0].objects[0].x, 50, 'half of a 4:3 slide is still half');
  assert.equal(out.slides[0].objects[0].w, 50);
  assert.ok(out.warnings.some((w) => /不是 16:9/.test(w)), out.warnings.join(' | '));
});

test('every slide arrives on the blank layout, with a name for the strip', () => {
  /* The seven named layouts here are this editor's, not theirs. Mapping a
     template's onto them would move text the file placed deliberately, so
     everything is an object -- but a slide still needs something to be called
     in the thumbnail list and in what the model is told. */
  const out = read(TITLED);
  assert.equal(out.slides[0].layout, 'blank');
  assert.equal(out.slides[0].title, '繼承來的標題');
  assert.deepEqual(out.slides[0].body, ['']);
});

test('the deck takes its font from the theme and its name from the file', () => {
  const core = D + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>季度檢討</dc:title></cp:coreProperties>';
  const out = office.readPptx(pack(TITLED, { extra: { 'docProps/core.xml': core } }));
  assert.equal(out.title, '季度檢討');
  assert.equal(out.font, 'Calibri', 'the minor font of the theme is the body font');
});

test('a file that is not a presentation says which part is missing', () => {
  assert.throws(() => office.readPptx(zip.write({ 'word/document.xml': '<w:document/>' })),
    /ppt\/presentation\.xml/);
});

/* ------------------------------------------------------- our own files back */

test('a deck written here reads back with every object intact', () => {
  /* This proves the plumbing rather than the format -- everything written here
     is self-describing -- but it is the round trip a user actually performs:
     export to PowerPoint, and open the result again later. */
  const deck = {
    title: '往返', font: 'Noto Sans TC', scale: 100,
    slides: [{
      layout: 'blank', title: '', body: [''], notes: '講稿在這裡',
      objects: [
        { kind: 'text', x: 5, y: 8, w: 50, h: 14, size: 28, bold: true, colour: '1F4E79', align: 'left', valign: 'top', text: '文字方塊' },
        { kind: 'shape', shape: 'hexagon', x: 60, y: 8, w: 26, h: 20, size: 18, fill: 'C0504D', colour: 'FFFFFF', align: 'center', valign: 'middle', text: '六角形' },
        {
          kind: 'table', x: 5, y: 30, w: 60, h: 28, size: 14, header: true, banded: true, fill: '1F4E79',
          rows: [['項目', '數量', '金額'], ['滑鼠', '3', '2250']], merges: [{ c0: 0, r0: 0, c1: 1, r1: 0 }]
        }
      ]
    }]
  };
  /* The import reading, on purpose: a file this writer made now carries its
     own model and readPptx hands that back by default, which would make this
     test pass without reading a single shape. `restore: false` asks for what
     the slides actually say. */
  const back = office.readPptx(office.writePptx(deck).buffer, { restore: false });
  /* One warning is expected and correct: this writer puts a white background on
     the master, reading does not restore it, and a deck whose text was picked
     against white does land differently on this editor's canvas. Everything
     that would mean an object was damaged has to be absent. */
  assert.equal(back.warnings.length, 1, back.warnings.join(' | '));
  assert.match(back.warnings[0], /背景/);
  const [t, s, tbl] = back.slides[0].objects;
  assert.deepEqual(
    { kind: t.kind, x: t.x, y: t.y, w: t.w, h: t.h, size: t.size, bold: t.bold, colour: t.colour, text: t.text },
    { kind: 'text', x: 5, y: 8, w: 50, h: 14, size: 28, bold: true, colour: '1F4E79', text: '文字方塊' });
  assert.equal(s.kind, 'shape');
  assert.equal(s.shape, 'hexagon');
  assert.equal(s.fill, 'C0504D');
  assert.deepEqual(tbl.merges, [{ c0: 0, r0: 0, c1: 1, r1: 0 }]);
  assert.equal(back.slides[0].notes, '講稿在這裡');
});

test('a merged cell survives the trip out to PowerPoint and back', () => {
  /* The writer read `{c, r, w, h}` while the deck stores `{c0, r0, c1, r1}`, so
     every field came back undefined, `span.w > 1` was false, and a merged
     heading exported as separate cells. The table still opened, which is why it
     went unseen until a reader had to agree with the writer. */
  const one = (merges) => ({
    title: 'm', slides: [{
      layout: 'blank', title: '', body: [''], notes: '', objects: [{
        kind: 'table', x: 5, y: 10, w: 60, h: 30, size: 14, header: true, banded: true, fill: '1F4E79',
        rows: [['甲', '乙', '丙'], ['1', '2', '3'], ['4', '5', '6']], merges
      }]
    }]
  });
  const back = office.readPptx(office.writePptx(one([
    { c0: 0, r0: 0, c1: 1, r1: 0 }, { c0: 2, r0: 1, c1: 2, r1: 2 }
  ])).buffer, { restore: false });
  assert.deepEqual(back.slides[0].objects[0].merges, [
    { c0: 0, r0: 0, c1: 1, r1: 0 }, { c0: 2, r0: 1, c1: 2, r1: 2 }
  ]);
  // And a table with nothing merged says nothing about merges.
  const plain = office.readPptx(office.writePptx(one([])).buffer, { restore: false });
  assert.equal(plain.slides[0].objects[0].merges, undefined);
});

test('a shape takes its colour from the style reference when spPr is silent', () => {
  /* A shape dropped in from the gallery usually carries no fill in its spPr at
     all -- PowerPoint puts the colour in <p:style><a:fillRef>, a reference into
     the theme. Reading only spPr leaves every one of them an empty outline,
     which is the most visible thing an importer can get wrong. a:fontRef beside
     it is the same story for the text sitting on the fill. */
  const styled = '<p:sp><p:nvSpPr><p:cNvPr id="5" name="S"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1219200" cy="685800"/></a:xfrm>' +
    '<a:prstGeom prst="hexagon"><a:avLst/></a:prstGeom></p:spPr>' +
    '<p:style><a:fillRef idx="1"><a:schemeClr val="accent2"/></a:fillRef>' +
    '<a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/>' + run('六角形') + '</p:txBody></p:sp>';
  const o = objectsOf(styled)[0];
  assert.equal(o.kind, 'shape');
  assert.equal(o.fill, 'ED7D31', 'accent2 out of the theme');
  assert.equal(o.colour, 'FFFFFF', 'lt1, because the runs said nothing');
});

test('an explicit noFill still means no fill, style reference or not', () => {
  const hollow = '<p:sp><p:nvSpPr><p:cNvPr id="5" name="S"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1219200" cy="685800"/></a:xfrm>' +
    '<a:prstGeom prst="hexagon"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
    '<p:style><a:fillRef idx="1"><a:schemeClr val="accent2"/></a:fillRef></p:style>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/>' + run('空心') + '</p:txBody></p:sp>';
  assert.equal(objectsOf(hollow)[0].fill, '');
});

test('the theme body colour is left to the host, a shaded one is kept', () => {
  /* tx1 means "the body text colour of this theme", not black. The background
     it was picked against is the slide background, and slide backgrounds do not
     come across -- so pinning it to a literal puts black text on this editor's
     dark canvas: readable in PowerPoint, invisible here. A shaded reference was
     somebody making a choice, and that is kept. */
  const plain = ph(3, 'Body', '<p:ph type="body" idx="1"/>',
    run('預設黑', '<a:solidFill><a:schemeClr val="tx1"/></a:solidFill>'));
  assert.equal(objectsOf(TITLED + plain)[1].colour, undefined);

  const shaded = ph(3, 'Body', '<p:ph type="body" idx="1"/>',
    run('刻意的灰', '<a:solidFill><a:schemeClr val="tx1">' +
      '<a:lumMod val="65000"/><a:lumOff val="35000"/></a:schemeClr></a:solidFill>'));
  const c = objectsOf(TITLED + shaded)[1].colour;
  assert.ok(c && c !== '000000', '調過亮度的就是選過的，要留下來：' + c);

  // And an explicit hex is never anybody else's business.
  const literal = ph(3, 'Body', '<p:ph type="body" idx="1"/>',
    run('指定的黑', '<a:solidFill><a:srgbClr val="000000"/></a:solidFill>'));
  assert.equal(objectsOf(TITLED + literal)[1].colour, '000000');
});
