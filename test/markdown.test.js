'use strict';

/* ===========================================================================
   Markdown parser tests
   ---------------------------------------------------------------------------
   The parser is loaded in a bare VM with a stub AIOS, the same way the
   generated-app validator is tested: no DOM, no Electron, just the block and
   inline grammar.

   The rendering half is not tested here, but the property that matters about it
   is asserted structurally in wiring.test.js: it must never assign innerHTML,
   because the text being rendered came out of an untrusted file.
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'app', 'renderer', 'apps', 'markdown.js');

function load() {
  /* `slots` because the viewer declares its contribution points at load, the
     way it registers itself; a stub without it would make this test fail on
     a line that has nothing to do with Markdown. */
  const AIOS = { apps: { register() {} }, slots: { declare() {} } };
  vm.runInNewContext(fs.readFileSync(SRC, 'utf8'), {
    window: { aios: {}, AIOS },
    AIOS,
    document: { createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, contains() {} }, appendChild() {} }) },
    console
  }, { filename: 'markdown.js' });
  return AIOS.markdown;
}

const md = load();
const types = (blocks) => blocks.map((b) => b.type).join(' ');

/* ----------------------------------------------------------------- blocks */

test('headings, paragraphs and rules', () => {
  const b = md.parse('# One\n\ntext here\n\n## Two\n\n---\n\n### Three ###');
  assert.equal(types(b), 'heading para heading rule heading');
  assert.equal(b[0].level, 1);
  assert.equal(b[0].text, 'One');
  assert.equal(b[2].level, 2);
  assert.equal(b[4].text, 'Three', 'closing hashes are decoration, not content');
});

test('setext headings', () => {
  const b = md.parse('Title\n=====\n\nSub\n---\n');
  assert.equal(types(b), 'heading heading');
  assert.equal(b[0].level, 1);
  assert.equal(b[0].text, 'Title');
  assert.equal(b[1].level, 2);
});

test('a fenced block is literal, including things that look like markup', () => {
  const b = md.parse('```js\nif (a < b) { /* # not a heading */ }\n- not a list\n```\n');
  assert.equal(b.length, 1);
  assert.equal(b[0].type, 'code');
  assert.equal(b[0].lang, 'js');
  assert.match(b[0].text, /# not a heading/);
  assert.match(b[0].text, /- not a list/);
});

test('a fence can be closed by a longer run and tildes work too', () => {
  const back = md.parse('```\nx\n````\n');
  assert.equal(back[0].text, 'x');
  const tilde = md.parse('~~~python\ny = 1\n~~~\n');
  assert.equal(tilde[0].lang, 'python');
  assert.equal(tilde[0].text, 'y = 1');
});

test('an unterminated fence still yields its content', () => {
  const b = md.parse('```\nstill here\n');
  assert.equal(b[0].type, 'code');
  assert.equal(b[0].text, 'still here');
});

test('nested lists keep their depth, and task boxes are read', () => {
  const b = md.parse([
    '- one',
    '- two',
    '  - nested',
    '    - deeper',
    '- [ ] todo',
    '- [x] done'
  ].join('\n'));
  assert.equal(b.length, 1);
  assert.equal(b[0].type, 'list');
  const items = b[0].items;
  assert.equal(items.length, 6);
  assert.equal(items[0].indent, 0);
  assert.equal(items[2].indent, 2);
  assert.equal(items[3].indent, 4);
  assert.equal(items[4].task, false);
  assert.equal(items[5].task, true);
  assert.equal(items[4].lines[0], 'todo', 'the checkbox is not part of the text');
});

test('ordered lists are distinguished from bullets', () => {
  const b = md.parse('1. first\n2. second\n');
  assert.equal(b[0].items[0].ordered, true);
  const u = md.parse('* first\n');
  assert.equal(u[0].items[0].ordered, false);
});

test('blockquotes are parsed recursively', () => {
  const b = md.parse('> ## quoted heading\n> \n> - a list\n');
  assert.equal(b[0].type, 'quote');
  assert.equal(types(b[0].blocks), 'heading list');
});

test('tables need a separator row, and alignment is read from it', () => {
  const b = md.parse('| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n');
  assert.equal(b[0].type, 'table');
  // Joined rather than deep-compared: these arrays come from another VM realm,
  // so deepStrictEqual fails on the prototype alone.
  assert.equal(b[0].rows[0].join('|'), 'a|b|c');
  assert.equal(b[0].rows[1].join('|'), '1|2|3');
  assert.equal(b[0].align.join('|'), 'left|center|right');

  // A pipe in a paragraph is not a table.
  const notTable = md.parse('a | b\nc | d\n');
  assert.equal(types(notTable), 'para');
});

test('indented code is code, but not inside a paragraph', () => {
  const b = md.parse('    indented code\n');
  assert.equal(b[0].type, 'code');
  assert.equal(b[0].text, 'indented code');

  // A wrapped paragraph line that happens to be indented is still the paragraph.
  const p = md.parse('a paragraph\n    continued here\n');
  assert.equal(types(p), 'para');
});

/* ----------------------------------------------------------------- inline */

const kinds = (spans) => spans.map((s) => s.t).join(' ');
const flat = (spans) => spans.map((s) => s.v !== undefined ? s.v : flat(s.kids || [])).join('');

test('emphasis, strong and strikethrough', () => {
  assert.equal(kinds(md.inline('**bold** and *it* and ~~gone~~')),
    'strong text em text del');
  assert.equal(flat(md.inline('**bold**')), 'bold');
  assert.equal(kinds(md.inline('__also bold__ _also em_')), 'strong text em');
});

test('a code span is literal and wins over emphasis', () => {
  const s = md.inline('use `a * b * c` here');
  assert.equal(kinds(s), 'text code text');
  assert.equal(s[1].v, 'a * b * c');
});

test('code spans can contain backticks via a longer fence', () => {
  const s = md.inline('``has ` inside``');
  assert.equal(s[0].t, 'code');
  assert.equal(s[0].v, 'has ` inside');
});

test('links and images are told apart', () => {
  const l = md.inline('see [the docs](https://example.com "Title")');
  assert.equal(l[1].t, 'link');
  assert.equal(l[1].href, 'https://example.com');
  assert.equal(l[1].title, 'Title');
  assert.equal(flat(l[1].kids), 'the docs');

  const i = md.inline('![a picture](pic.png)');
  assert.equal(i[0].t, 'image');
  assert.equal(i[0].alt, 'a picture');
  assert.equal(i[0].href, 'pic.png');
});

test('nested brackets in a link label survive', () => {
  const s = md.inline('[a [b] c](x.md)');
  assert.equal(s[0].t, 'link');
  assert.equal(flat(s[0].kids), 'a [b] c');
  assert.equal(s[0].href, 'x.md');
});

test('autolinks are recognised, other angle content is text', () => {
  assert.equal(md.inline('<https://example.com>')[0].t, 'link');
  assert.equal(md.inline('<mailto:a@b.c>')[0].t, 'link');
  const raw = md.inline('<script>alert(1)</script>');
  assert.equal(kinds(raw), 'text', 'raw HTML must stay text, never become a node');
  assert.match(flat(raw), /<script>/);
});

test('escapes are honoured', () => {
  const s = md.inline('\\*not emphasis\\* and \\`not code\\`');
  assert.equal(kinds(s), 'text');
  assert.equal(flat(s), '*not emphasis* and `not code`');
});

test('an unmatched marker stays text', () => {
  assert.equal(kinds(md.inline('a * b')), 'text');
  assert.equal(kinds(md.inline('[not a link')), 'text');
  assert.equal(kinds(md.inline('[label](unclosed')), 'text');
});

test('two trailing spaces are a hard break', () => {
  const s = md.inline('line one  \nline two');
  assert.equal(kinds(s), 'text break text');
});

test('CJK text is left intact', () => {
  const s = md.inline('這是**粗體**與`程式碼`');
  assert.equal(kinds(s), 'text strong text code');
  assert.equal(flat(s[1].kids), '粗體');
  assert.equal(s[3].v, '程式碼');
});

test('a whole document parses into the expected shape', () => {
  const doc = [
    '# Title',
    '',
    'Intro paragraph with a [link](./other.md).',
    '',
    '## Steps',
    '',
    '1. first',
    '2. second',
    '',
    '```sh',
    'npm start',
    '```',
    '',
    '> a note',
    '',
    '| k | v |',
    '| --- | --- |',
    '| a | 1 |'
  ].join('\n');
  assert.equal(types(md.parse(doc)), 'heading para heading list code quote table');
});

test('a bullet list and a numbered list stay separate blocks', () => {
  // A blank line between them used to be read as a loose-list continuation, so
  // the numbered items were absorbed into the bullet list and rendered with the
  // wrong marker.
  const b = md.parse('- one\n- two\n\n1. first\n2. second\n');
  assert.equal(types(b), 'list list');
  assert.equal(b[0].items.length, 2);
  assert.equal(b[0].items[0].ordered, false);
  assert.equal(b[1].items.length, 2);
  assert.equal(b[1].items[0].ordered, true);
});

test('switching marker kind without a blank line also starts a new list', () => {
  const b = md.parse('1. first\n2. second\n- bullet\n');
  assert.equal(types(b), 'list list');
  assert.equal(b[0].items[0].ordered, true);
  assert.equal(b[1].items[0].ordered, false);
});

test('a loose list of one kind stays one list', () => {
  const b = md.parse('- one\n\n- two\n\n- three\n');
  assert.equal(types(b), 'list');
  assert.equal(b[0].items.length, 3);
});

test('a nested list of the other kind is still nested, not split', () => {
  const b = md.parse('- outer\n  1. inner\n  2. inner two\n- outer two\n');
  assert.equal(types(b), 'list', 'indented items belong to the same list block');
  assert.equal(b[0].items.length, 4);
  assert.equal(b[0].items[1].indent, 2);
  assert.equal(b[0].items[1].ordered, true);
});
