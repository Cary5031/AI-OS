'use strict';

/* ===========================================================================
   AI-OS // 一封信還寄給了誰
   ---------------------------------------------------------------------------
   A To or Cc header is a list of people, and the mail application used to
   treat it as one opaque string: the reading pane printed it whole, the list
   printed nothing at all, and search never looked at it. So 「這封還寄給了
   誰」 and 「發給採購的那封」 -- two of the plainest questions anybody asks a
   mail client -- had no answer here, even though the mirror had been holding
   To and Cc on every row all along.

   This file is the part of fixing that which is not about layout: given a
   header, who is in it; given what somebody typed in the search box, what the
   mirror should be asked. Both are pure, and both are deliberately not inside
   apps/mail.js -- a comma inside a quoted display name is the kind of rule
   that is worth a test, and a function inside a window's mount() cannot have
   one.

   The two views then spend the same data differently, which is why this
   returns pieces rather than a finished string:

     the list      names only, clamped to two lines by the stylesheet. A row
                   that grew to fit twenty recipients would push the next
                   message off the screen, and a list exists to be scanned.
     the reader    every address, one per line, counted. Nothing is truncated
                   there; that is the view which is allowed to be long.

   Nothing here ever sees a message body. The only text it reads is a header
   written by whoever sent the message, which is why `oneLine` exists and why
   every other function in the file goes through it.
   =========================================================================== */

/* global window, module */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AIOS = root.AIOS || {};
    root.AIOS.mailparty = factory();
  }
}(typeof window !== 'undefined' ? window : this, function () {

  /* What one recipient, and one whole header, are allowed to cost. A header has
     no length limit; a list row, a tooltip, and the window description the core
     reads all have one. */
  var MAX_ONE = 200;
  var MAX_HEADER = 2000;

  /**
   * A header made safe to lay out one per line, and bounded.
   *
   * A display name is chosen by whoever sent the message, so a newline inside
   * one forges a line anywhere this text is printed a line at a time -- and the
   * window description the core reads is exactly that. The DOM does not need
   * this, because textContent is not markup; the transcript does, and having one
   * rule for both is how it stays true of both.
   */
  function oneLine(v, max) {
    return String(v == null ? '' : v)
      .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max || 400);
  }

  /**
   * One address header split into its people.
   *
   * The comma inside a quoted display name is the reason this is not
   * `split(',')`: 「"Chen, Cary" <c@x.com>, b@y.com」 is two recipients, and
   * splitting on every comma makes it three, one of which is the word Cary.
   * A semicolon separates as well -- Outlook writes them, and a header pasted
   * out of Outlook is a header this has to be able to read.
   */
  function split(header) {
    var out = [];
    var buf = '';
    var quoted = false;
    var s = oneLine(header, MAX_HEADER);
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '"') { quoted = !quoted; buf += c; continue; }
      if ((c === ',' || c === ';') && !quoted) {
        if (buf.trim()) out.push(buf.trim());
        buf = '';
        continue;
      }
      buf += c;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  /** What to call one recipient where there is no room for a whole address. */
  function name(one) {
    var s = oneLine(one, MAX_ONE);
    var m = s.match(/^(.*?)<([^>]*)>$/);
    /* A name with no address is what the web source's list rows carry, and one
       with a comma in it arrives quoted so `split` keeps it whole. The quotes
       did their job there; nobody wants to read them. */
    if (!m) return s.replace(/^"(.*)"$/, '$1').trim() || s;
    var display = m[1].trim().replace(/^"(.*)"$/, '$1').trim();
    return display || m[2].trim();
  }

  /** Every recipient of one header, as written, each one safe to print. */
  function each(header) {
    return split(header).map(function (one) { return oneLine(one, MAX_ONE); });
  }

  /** 「收件：王小明、李大華　副本：張三」, or '' when both headers were empty. */
  function line(msg) {
    var to = split(msg && msg.to).map(name);
    var cc = split(msg && msg.cc).map(name);
    var bits = [];
    if (to.length) bits.push('收件：' + to.join('、'));
    if (cc.length) bits.push('副本：' + cc.join('、'));
    return bits.join('　');
  }

  /** The same two headers as they were written: for a tooltip, or a transcript. */
  function full(msg) {
    var bits = [];
    if (msg && msg.to) bits.push('收件：' + oneLine(msg.to, MAX_HEADER));
    if (msg && msg.cc) bits.push('副本：' + oneLine(msg.cc, MAX_HEADER));
    return bits.join('\n');
  }

  /* 「收件:」 or 「to:」 in the search box narrows to the recipients, for the
     names common enough that free text alone pulls in half the mailbox. The
     prefixes are a way to be exact, never the only way to look: plain text
     reads To and Cc as well as the subject, the sender and the body, so
     somebody who never learns that the prefixes exist still finds the message.

     Both spellings of the colon, because a Chinese input method gives 「：」
     and nobody switches back to ASCII in the middle of typing a name. */
  var RCPT = /(?:^|\s)(?:to|cc|收件者|收件|副本)[:：]\s*("[^"]*"|\S+)/i;
  var FROM = /(?:^|\s)(?:from|寄件人|寄件)[:：]\s*("[^"]*"|\S+)/i;

  function unquote(v) {
    return String(v == null ? '' : v).replace(/^"(.*)"$/, '$1').trim();
  }

  /**
   * What the search box says, as conditions the mirror understands.
   *
   * A prefix it recognises is taken out of the free text rather than left in
   * it: searching the subject for the word 「收件」 as well as the recipients
   * for the name would put hits in the list for a reason the user did not ask
   * for, and 「收件:」 is not a word anybody writes in a subject line.
   */
  function query(raw) {
    var rest = oneLine(raw, 400);
    var out = { text: '', from: '', to: '' };
    rest = rest.replace(RCPT, function (all, v) { out.to = unquote(v); return ' '; });
    rest = rest.replace(FROM, function (all, v) { out.from = unquote(v); return ' '; });
    out.text = rest.trim();
    return out;
  }

  return {
    oneLine: oneLine,
    split: split,
    name: name,
    each: each,
    line: line,
    full: full,
    query: query
  };
}));
