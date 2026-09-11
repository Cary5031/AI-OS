'use strict';

/* ===========================================================================
   A document small enough to read, for tests that build SVG and HTML.
   ---------------------------------------------------------------------------
   The chart module lays out with arithmetic on a viewBox and never measures,
   so the whole of what it needs from a document is: create an element, set an
   attribute, append a child, hold a text node, serialise. This is that, and
   nothing more -- no layout, no events beyond a listener list, no CSS.

   Elements keep attributes in insertion order and serialise the way Chromium's
   HTML serialiser does for the subset used here (attribute values escaped, text
   escaped, void elements closed with '>' only for the HTML voids).
   =========================================================================== */

const VOID = new Set(['br', 'hr', 'img', 'input', 'col', 'meta', 'link']);

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

class Node {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get children() { return this.childNodes.filter((n) => n instanceof Element); }
  get isConnected() { return true; }
  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at < 0) this.childNodes.push(n); else this.childNodes.splice(at, 0, n);
    return n;
  }
  removeChild(n) {
    const at = this.childNodes.indexOf(n);
    if (at >= 0) { this.childNodes.splice(at, 1); n.parentNode = null; }
    return n;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }
  set textContent(v) {
    this.childNodes = [];
    if (v !== '' && v !== null && v !== undefined) this.appendChild(new Text(this.ownerDocument, v));
  }
}

class Text extends Node {
  constructor(doc, data) { super(doc); this.data = String(data); this.nodeType = 3; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  get outerHTML() { return escText(this.data); }
}

class ClassList {
  constructor(el) { this.el = el; }
  _list() { return (this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  _set(list) { this.el.setAttribute('class', list.join(' ')); }
  add(...names) { const l = this._list(); names.forEach((n) => { if (!l.includes(n)) l.push(n); }); this._set(l); }
  remove(...names) { this._set(this._list().filter((n) => !names.includes(n))); }
  contains(n) { return this._list().includes(n); }
  toggle(n, force) {
    const has = this.contains(n);
    const want = force === undefined ? !has : !!force;
    if (want && !has) this.add(n);
    if (!want && has) this.remove(n);
    return want;
  }
}

class Element extends Node {
  constructor(doc, tag, ns) {
    super(doc);
    this.nodeType = 1;
    this.tagName = ns === 'http://www.w3.org/2000/svg' ? tag : tag.toUpperCase();
    this.localName = tag;
    this.namespaceURI = ns || 'http://www.w3.org/1999/xhtml';
    this.attributes = new Map();
    this.style = new Proxy({}, {
      set: (target, key, value) => { target[key] = String(value); return true; },
      get: (target, key) => (key in target ? target[key] : '')
    });
    this.dataset = {};
    this.classList = new ClassList(this);
    this.listeners = {};
    this.hidden = false;
    this.value = '';
  }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(k) { return this.attributes.has(k); }
  removeAttribute(k) { this.attributes.delete(k); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener() {}
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get title() { return this.getAttribute('title') || ''; }
  set title(v) { this.setAttribute('title', v); }
  get type() { return this.getAttribute('type') || ''; }
  set type(v) { this.setAttribute('type', v); }
  focus() {}
  querySelectorAll(sel) {
    // Only the forms the tests use: 'tag', '.class', 'tag.class', '[attr]'.
    const out = [];
    const walk = (n) => {
      n.childNodes.forEach((c) => {
        if (c instanceof Element) { if (matches(c, sel)) out.push(c); walk(c); }
      });
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  _styleAttr() {
    const keys = Object.keys(this.style);
    if (!keys.length) return '';
    return keys.map((k) => k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()) + ': ' + this.style[k]).join('; ') + ';';
  }
  get outerHTML() {
    const tag = this.namespaceURI === 'http://www.w3.org/2000/svg' ? this.localName : this.localName.toLowerCase();
    let attrs = '';
    for (const [k, v] of this.attributes) attrs += ' ' + k + '="' + escAttr(v) + '"';
    const st = this._styleAttr();
    if (st) attrs += ' style="' + escAttr(st) + '"';
    for (const k of Object.keys(this.dataset)) {
      attrs += ' data-' + k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()) + '="' + escAttr(this.dataset[k]) + '"';
    }
    if (VOID.has(tag) && this.namespaceURI !== 'http://www.w3.org/2000/svg') return '<' + tag + attrs + '>';
    return '<' + tag + attrs + '>' + this.innerHTML + '</' + tag + '>';
  }
  get innerHTML() { return this.childNodes.map((n) => n.outerHTML).join(''); }
  set innerHTML(v) { if (v !== '') throw new Error('fakedom: innerHTML may only be cleared'); this.childNodes = []; }
}

function matches(el, sel) {
  const s = sel.trim();
  let m;
  if ((m = /^\[([\w-]+)\]$/.exec(s))) return el.hasAttribute(m[1]);
  if ((m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+)+)?$/.exec(s))) {
    if (m[1] && el.localName.toLowerCase() !== m[1].toLowerCase()) return false;
    if (m[2]) for (const c of m[2].split('.').filter(Boolean)) if (!el.classList.contains(c)) return false;
    return true;
  }
  throw new Error('fakedom: unsupported selector ' + sel);
}

class Document {
  constructor() { this.body = new Element(this, 'body'); }
  createElement(tag) { return new Element(this, tag); }
  createElementNS(ns, tag) { return new Element(this, tag, ns); }
  createTextNode(data) { return new Text(this, data); }
  getElementById() { return null; }
}

module.exports = { Document, Element, Text, matches };
