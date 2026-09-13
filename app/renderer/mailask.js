'use strict';

/* ===========================================================================
   AI-OS // reading a sentence about a mailbox
   ---------------------------------------------------------------------------
   郵件待辦 used to be seven form fields. The user's verdict on that was that it
   is too complicated, and that what people want to do is describe the thing:

       這禮拜 abc.com 寄來的信都列出來，內容有提到我的標起來，摘要寫金額跟期限，
       每天早上七點半自己跑一次

   So the sentence became the rule. This file is the part of that which is not
   allowed to need a model: given the sentence, find the conditions a mailbox
   search can actually be given. It runs first, every time, and the model's
   reading is merged on top of it -- never instead of it.

   Two jobs, both pure:

     read(say)            what the sentence plainly says. Addresses, domains,
                          quoted words, a window of days, unread, attachments,
                          a time of day. Regular expressions, no model.
     merge(base, ai, say) the model's reading, grounded against the sentence.

   `merge` is the part worth explaining. A model asked to turn a sentence into
   search conditions will sometimes produce a domain that is not in the
   sentence -- not maliciously, just the most likely domain for a company with
   that name. That domain then becomes what the mailbox is searched for, every
   morning, silently, and the list is empty for a reason nobody can see from
   looking at it. So every string the model proposes for a mechanical field has
   to appear in the sentence the user wrote. What fails that test is dropped and
   listed, and the screen says what it refused to use.

   The fields that are *not* grounded that way are `focus` and `sieve`: what the
   summary should say, and what counts as a match. Those are instructions to the
   writing step, phrased by the model, and there is nothing to ground them
   against -- "只留在催我回覆的" contains no searchable token at all, which is
   the entire reason this change exists. They are bounded and stripped instead.

   Nothing here ever sees a message. The only text this file reads is the
   sentence the user typed and a reply from the model about it, so no part of
   this file is a place where somebody else's writing can reach.
   =========================================================================== */

/* global window, module */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AIOS = root.AIOS || {};
    root.AIOS.mailask = factory();
  }
}(typeof window !== 'undefined' ? window : this, function () {

  var MAX_SAY = 400;
  var MAX_BODIES = 12;

  /** Bounded, single-line, no control characters. The same shape the store keeps. */
  function text(v, max) {
    return String(v == null ? '' : v)
      .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max || 200);
  }

  /* Comparing a model's answer against the sentence has to ignore the things
     that differ without meaning anything: case, the spaces Chinese input methods
     leave behind, and full-width punctuation. A user who typed ＡＢＣ．ＣＯＭ
     meant abc.com. */
  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[！-～]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
      })
      .replace(/\s+/g, '');
  }

  /* ------------------------------------------------------------- the clock -- */

  /* Windows people write, in days. Order is load-bearing and the reason this is
     a list rather than one alternation: 「這兩個禮拜」 contains 「這禮拜」,
     「三個月」 contains 「個月」, and 「半年」 contains 「年」 -- in every one of
     those pairs the longer phrase is what was meant, so it has to be tried
     first. Anything reachable by the bare noun alone is written with its
     determiner required for the same reason.

     A window that says "last month" is 60 days, not 30: the mailbox is searched
     backwards from today, and 30 would stop at the first of this month and miss
     the whole month the sentence was about. */
  var WINDOWS = [
    [/上\s*(個)?\s*月/, 60],
    [/一\s*季|三\s*個?\s*月|近\s*90\s*天/, 90],
    [/半\s*年/, 180],
    [/(這|本|該)\s*(個)?\s*月(份)?|近\s*一?\s*個\s*月|過去\s*一?\s*個\s*月|一\s*個\s*月(內|以內)/, 30],
    [/上\s*(個)?\s*(週|周|星期|禮拜)/, 14],
    [/(這|本|近)\s*(兩|2)\s*(個)?\s*(週|周|星期|禮拜)|(兩|2)\s*(個)?\s*(週|周|星期|禮拜)(內|以內)/, 14],
    [/(這|本|近)\s*(個)?\s*(週|周|星期|禮拜)|一\s*(週|周|星期|禮拜)(內|以內)?/, 7],
    [/這\s*(幾|兩|三)\s*天|最近\s*(幾|兩|三)\s*天/, 3],
    [/昨天|昨日/, 2],
    [/今天|今日|當天/, 1],
    [/(這|今)\s*(一)?\s*年|一\s*年(內|以內)?/, 365]
  ];

  /**
   * How far back the sentence is asking us to look, in days, or 0 for "it did
   * not say".
   *
   * An explicit number wins over a phrase, because somebody who wrote 「近 45
   * 天」 was being specific on purpose.
   */
  function daysIn(say) {
    var s = norm(say);

    /* A number of days beats everything, including a phrase elsewhere in the
       same sentence: 「這個月的信，近 45 天就好」 means 45.

       The honest limit of doing this mechanically: a sentence can contain a
       number of days that is not about the search window at all -- 「把十天內要
       繳的錢挑出來」 is a deadline written inside the messages. This reader has
       no way to tell those apart, which is one of the things the model's reading
       is for; what it produces is shown on screen as a number the user can
       change, never applied silently. */
    var n = s.match(/(?:近|過去|最近|前)?(\d{1,3})\s*(?:天|日)(?:內|以內)?/);
    if (n) {
      var v = Number(n[1]);
      if (v >= 1 && v <= 365) return v;
    }
    var w = s.match(/([0-9]{1,2}|[一二兩三四五六七八九十]{1,3})\s*(?:個)?\s*(?:週|周|星期|禮拜)/);
    if (w) {
      var wk = count(w[1]) * 7;
      if (wk >= 7 && wk <= 365) return wk;
    }
    var m = s.match(/([0-9]{1,2}|[一二兩三四五六七八九十]{1,3})\s*(?:個)\s*月/);
    if (m) {
      var mo = count(m[1]) * 30;
      if (mo >= 30 && mo <= 365) return mo;
    }
    for (var i = 0; i < WINDOWS.length; i++) {
      if (WINDOWS[i][0].test(s)) return WINDOWS[i][1];
    }
    return 0;
  }

  /* 「兩個月」 and 「2 個月」 are the same request. Only the small numbers people
     write windows with -- past twenty the digits come out. */
  var CN_NUM = {
    '一': 1, '二': 2, '兩': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7,
    '八': 8, '九': 9, '十': 10, '十一': 11, '十二': 12, '二十': 20
  };

  function count(raw) {
    var s = String(raw || '');
    if (/^[0-9]+$/.test(s)) return Number(s);
    if (CN_NUM[s] != null) return CN_NUM[s];
    /* 十N, for the teens nobody wrote out in full above. */
    var teen = s.match(/^十([一二三四五六七八九])$/);
    if (teen) return 10 + CN_NUM[teen[1]];
    return 0;
  }

  var HOURS = {
    '零': 0, '一': 1, '二': 2, '兩': 2, '三': 3, '四': 4, '五': 5, '六': 6,
    '七': 7, '八': 8, '九': 9, '十': 10, '十一': 11, '十二': 12
  };

  /**
   * A time of day the sentence asked to be run at, as 'HH:MM', or ''.
   *
   * Only when the sentence says it wants this to happen by itself: 「每天早上八
   * 點」 is a schedule, 「八點那封信」 is not. The word for "every day" is what
   * separates them, and without it this returns nothing.
   */
  function dailyIn(say) {
    var s = String(say == null ? '' : say);
    if (!/每天|每日|天天|每個?早上|每個?晚上/.test(s)) return '';

    var digits = s.match(/(上午|早上|早|凌晨|中午|下午|傍晚|晚上|夜裡)?\s*(\d{1,2})\s*[:：]\s*(\d{2})/);
    var h = null;
    var m = 0;
    if (digits) {
      h = Number(digits[2]);
      m = Number(digits[3]);
      /* 「每天下午 3:30」 is 15:30. This branch used to read the digits and stop,
         so the one phrasing that mixes words and numbers -- the common one --
         scheduled itself for half past three in the morning. */
      if (/下午|傍晚|晚上|夜裡/.test(digits[1] || '') && h < 12) h += 12;
    } else {
      var cn = s.match(/(上午|早上|早|凌晨|中午|下午|傍晚|晚上|夜裡)?\s*(\d{1,2}|十[一二]?|[零一二兩三四五六七八九])\s*點\s*(半|\d{1,2}\s*分)?/);
      if (!cn) return '';
      var raw = cn[2];
      h = /^\d+$/.test(raw) ? Number(raw) : HOURS[raw];
      if (h == null) return '';
      var tail = cn[3] || '';
      if (tail === '半') m = 30;
      else if (tail) m = Number(String(tail).replace(/\D/g, '')) || 0;

      var part = cn[1] || '';
      /* 「下午三點」 is 15:00. 「中午十二點」 stays 12. 「晚上十一點」 is 23. */
      if (/下午|傍晚|晚上|夜裡/.test(part) && h < 12) h += 12;
      if (/中午/.test(part) && h < 12 && h !== 12) h += 12;
    }
    if (!(h >= 0 && h <= 23) || !(m >= 0 && m <= 59)) return '';
    return (h < 10 ? '0' + h : String(h)) + ':' + (m < 10 ? '0' + m : String(m));
  }

  /* ------------------------------------------------------------ the search -- */

  /* Domains are taken from the sentence as written. A bare company name is
     deliberately *not* turned into a domain: guessing abc.com from 「ABC 公司」
     is the single most expensive thing this reader could get wrong, because the
     result is a rule that runs every day and finds nothing. */
  var ADDRESS = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  /* The boundaries are "not more domain", not "a delimiter I thought of".
     Written as a list of punctuation first, and that was wrong in the way that
     matters most here: Chinese runs words together, so 「abc.com的信」 -- which is
     how people actually type it -- had no space after the domain and the sender
     was dropped from the whole rule. The lookbehind keeps the domain half of an
     address from being read a second time on its own. */
  var DOMAIN = /(?<![a-z0-9.@-])((?:[a-z0-9-]+\.)+(?:com|net|org|edu|gov|io|co|tw|cn|jp|hk|sg|us|uk|de|fr|me|info|biz|app|dev|ai)(?:\.[a-z]{2})?)(?![a-z0-9-])/gi;

  function sendersIn(say) {
    var s = String(say == null ? '' : say);
    var out = [];
    var seen = {};
    var m;
    ADDRESS.lastIndex = 0;
    while ((m = ADDRESS.exec(s))) {
      var a = m[0].toLowerCase();
      if (!seen[a]) { seen[a] = 1; out.push(a); }
    }
    DOMAIN.lastIndex = 0;
    while ((m = DOMAIN.exec(s))) {
      var d = m[1].toLowerCase();
      /* Already covered by an address that ends in it. */
      var covered = false;
      for (var i = 0; i < out.length; i++) {
        if (out[i].indexOf('@') >= 0 && out[i].indexOf(d) >= 0) covered = true;
      }
      if (!covered && !seen[d]) { seen[d] = 1; out.push(d); }
    }
    return out;
  }

  /* Words in quotes are the user pointing at a literal string. Case numbers and
     part numbers are the other reliable literal: a run of letters and digits
     with no meaning in Chinese prose. */
  var QUOTED = /[「『"'“‘]([^「」『』"'“”‘’]{1,40})[」』"'”’]/g;
  var CODEY = /(?:^|[\s（()「」【】,，、：:])([A-Z][A-Z0-9]{2,}[-_]?\d{2,}|[A-Z]{1,3}-?\d{3,})(?=$|[\s）()「」【】,，、。：:這那的])/g;

  function keywordsIn(say) {
    var s = String(say == null ? '' : say);
    var out = [];
    var seen = {};
    var m;
    QUOTED.lastIndex = 0;
    while ((m = QUOTED.exec(s))) {
      var q = text(m[1], 40);
      if (q && !seen[q.toLowerCase()]) { seen[q.toLowerCase()] = 1; out.push(q); }
    }
    CODEY.lastIndex = 0;
    while ((m = CODEY.exec(s))) {
      var c = text(m[1], 40);
      if (c && !seen[c.toLowerCase()]) { seen[c.toLowerCase()] = 1; out.push(c); }
    }
    return out;
  }

  /**
   * The plain reading of a sentence.
   *
   * Every field here is something the sentence says in so many words. What it
   * implies -- that 「在催我回覆的」 means reading each message and deciding --
   * is not this function's business; that is what `sieve` is for, and only the
   * model can phrase it.
   */
  function read(say) {
    var s = text(say, MAX_SAY);
    var senders = sendersIn(s);
    var words = keywordsIn(s);
    var days = daysIn(s);

    return {
      say: s,
      from: senders.length ? senders[0] : '',
      text: words.length ? words[0] : '',
      days: days || 7,
      /* 0 means the sentence said nothing about a window, so 7 is this
         machine's choice and the screen should admit that rather than present
         it as something the user asked for. */
      daysSaid: !!days,
      unread: /未讀|還沒讀|沒讀過|沒看過|未閱|沒開過/.test(s),
      hasAttachment: /附件|夾檔|夾了檔|附檔|有檔案|夾了.{0,4}檔/.test(s),
      mentions: /提到我|跟我有關|指名我|點名我|我的名字|找我|叫我/.test(s) ? [] : null,
      /* 「摘要取內文開頭就好」 is in here because sentenceOf writes it: an old
         fieldwise rule with summarising switched off becomes that sentence, and
         if reading it back turned summarising on again the migration would start
         spending money the user had deliberately stopped spending. */
      summarise: !/不要(彙整|摘要|總結)|別(彙整|摘要)|只要主旨|不用摘要|取內文開頭/.test(s),
      dailyAt: dailyIn(s),
      /* The extras this reading could not produce. Named so the merge can tell
         "the model added something" from "the model overrode something". */
      moreFrom: senders.slice(1),
      moreText: words.slice(1)
    };
  }

  /* -------------------------------------------------------------- grounding -- */

  /**
   * Does this string actually occur in what the user wrote?
   *
   * Punctuation and spacing are ignored, so a model that answers `abc.com` for a
   * sentence containing 「ABC.COM 的信」 is believed. A model that answers
   * `abc.com` for 「ABC 公司的信」 is not: the sentence never said that domain,
   * and a rule is not the place to find out whether the guess was right.
   */
  function grounded(value, say) {
    var v = norm(value);
    if (!v) return false;
    return norm(say).indexOf(v) >= 0;
  }

  function bounded(n, lo, hi, fallback) {
    var v = Number(n);
    if (!isFinite(v)) return fallback;
    return Math.max(lo, Math.min(hi, Math.round(v)));
  }

  /**
   * The model's reading, merged onto the plain one.
   *
   * Mechanical fields -- the ones that become a mailbox query -- are taken only
   * when they are in the sentence. Everything the model proposed and could not
   * back up is returned in `dropped`, for the screen to show: a reader that
   * silently discarded half of what it was told would be as hard to trust as one
   * that silently invented things.
   */
  function merge(base, ai, say) {
    var s = text(say != null ? say : (base && base.say), MAX_SAY);
    var out = {
      say: s,
      from: base && base.from ? base.from : '',
      text: base && base.text ? base.text : '',
      days: base && base.days ? base.days : 7,
      unread: !!(base && base.unread),
      hasAttachment: !!(base && base.hasAttachment),
      mentions: base && Array.isArray(base.mentions) ? base.mentions.slice() : [],
      limit: bounded(base && base.limit, 1, 50, 12),
      bodies: MAX_BODIES,
      summarise: !base || base.summarise !== false,
      /* Carried from the base, not blanked. When the model is unreachable the
         base IS the rule being edited, and starting these at '' meant that
         pressing save on a machine with no core silently deleted the criterion
         and the summary instruction while the screen said only that judging
         would not take effect. */
      focus: (base && base.focus) || '',
      sieve: (base && base.sieve) || '',
      sift: !!(base && base.sift),
      dailyAt: (base && base.dailyAt) || '',
      name: '',
      dropped: []
    };
    var a = ai || {};
    var drop = function (label, value) {
      out.dropped.push(label + '「' + text(value, 40) + '」');
    };
    /* For the conditions that have no value to quote back -- a switch is on or
       off, and what got refused is the switch itself. */
    var refuse = function (what, why) {
      out.dropped.push(what + '（' + why + '）');
    };

    if (a.from) {
      if (grounded(a.from, s)) out.from = text(a.from, 120);
      else drop('寄件人', a.from);
    }
    if (a.text) {
      if (grounded(a.text, s)) out.text = text(a.text, 120);
      else drop('關鍵字', a.text);
    }
    if (Array.isArray(a.mentions)) {
      for (var i = 0; i < a.mentions.length && out.mentions.length < 6; i++) {
        var w = text(a.mentions[i], 40);
        if (!w) continue;
        if (grounded(w, s)) out.mentions.push(w);
        else drop('提到我的字', w);
      }
    }

    /* Numbers are not quoted from the sentence, they are chosen within a range,
       so they are clamped rather than grounded. A model that answers 400 days
       for a sentence about this week is wrong, but it is wrong in a way a range
       contains. */
    if (a.days != null) out.days = bounded(a.days, 1, 365, out.days);
    if (a.limit != null) out.limit = bounded(a.limit, 1, 50, 12);
    out.bodies = Math.min(MAX_BODIES, out.limit);

    /* These two are search conditions as much as `from` is -- mailstore drops
       every read message for `unread`, every message without a file for
       `hasAttachment` -- so they are grounded too. A boolean has no substring to
       look for, so what they are checked against is the plain reading: the
       sentence either has a cue for this or it does not, and the model does not
       get to add one. A model that turns 「我還沒處理完的信」 into `unread: true`
       would otherwise silently drop every message the user had opened, and the
       only trace on screen would read like something they had asked for. */
    if (a.unread != null && !!a.unread !== out.unread) {
      refuse(a.unread ? '只看未讀' : '不限未讀',
        a.unread ? '那句話沒提到未讀' : '那句話說了未讀');
    }
    if (a.hasAttachment != null && !!a.hasAttachment !== out.hasAttachment) {
      refuse(a.hasAttachment ? '只看有附件' : '不限附件',
        a.hasAttachment ? '那句話沒提到附件' : '那句話說了附件');
    }
    if (a.summarise != null) out.summarise = a.summarise !== false;

    /* Instructions, not search keys: nothing to ground them against, so they are
       bounded and kept. See the file header. */
    if (a.focus != null) out.focus = text(a.focus, 200) || out.focus;
    if (a.sieve != null) out.sieve = text(a.sieve, 200) || out.sieve;
    out.sift = !!out.sieve && a.sift !== false;

    /* A sentence that names nothing the mailbox can search for is not a broken
       sentence -- 「語氣已經在催的那種留下來，不管是誰寄的」 is the whole reason
       this feature exists. But with no condition and no criterion there would be
       nothing to store and nothing to run, so the plain reading falls back to
       the only criterion it is certain of: what the user actually wrote.
       Imprecise, and honest about being imprecise -- the screen shows it as the
       criterion, and a model reading the same sentence later replaces it with a
       tighter one. Without this the six examples on the first screen were, for a
       machine with no core, five refusals. */
    if (!out.sieve && !out.from && !out.text && !out.unread && !out.hasAttachment && s) {
      out.sieve = s;
      out.sift = true;
    }

    if (a.dailyAt && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(a.dailyAt))) {
      out.dailyAt = String(a.dailyAt);
    }

    /* The name is a label on a button, not a condition, so it is allowed to be
       the model's own words -- but it is the one free string that gets shown
       without a summary around it, so it is kept short. */
    out.name = text(a.name, 60) || nameFor(out, s);

    return out;
  }

  /** A short label for a rule, when nothing better was given. */
  function nameFor(plan, say) {
    if (plan && plan.from) return plan.from;
    if (plan && plan.text) return plan.text;
    var s = text(say, MAX_SAY);
    if (!s) return '未命名規則';
    var cut = s.split(/[，,。；;！!？?\n]/)[0] || s;
    return text(cut, 24);
  }

  /* A rule with a sentence but no conditions the mailbox understands looks at
     whatever is newest in the window. That is a legitimate thing to want, and
     the one thing it must not be is a surprise. */
  function isWide(plan) {
    return !!plan && !plan.from && !plan.text && !plan.unread && !plan.hasAttachment;
  }

  /**
   * A short, stable fingerprint of a sentence.
   *
   * Its only job is to answer "were the conditions below read from the sentence
   * above, or from an older one". Not a hash for security -- there is nothing to
   * attack here -- so it is small, deterministic, and not a dependency.
   */
  function fingerprint(say) {
    var s = norm(text(say, MAX_SAY));
    var h1 = 0x811c9dc5;
    var h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = (h1 ^ c) >>> 0;
      h1 = (h1 * 0x01000193) >>> 0;
      h2 = (h2 + c * (i + 1)) >>> 0;
    }
    var hex = function (n) {
      var x = (n >>> 0).toString(16);
      return '00000000'.slice(x.length) + x;
    };
    return hex(h1) + hex(h2);
  }

  /** Has this rule's sentence changed since its conditions were read? */
  function isStale(rule) {
    if (!rule || !rule.say) return false;
    return fingerprint(rule.say) !== String(rule.sayFor || '');
  }

  /**
   * A sentence for a rule that predates sentences.
   *
   * Old rules were seven fields, and the form that replaced them asks for prose.
   * Rather than show those people an empty box, their fields are written back
   * out as the sentence that would have produced them -- which is also the
   * clearest possible statement of what their rule has been doing all along.
   */
  function sentenceOf(rule) {
    if (!rule) return '';
    if (rule.say) return text(rule.say, MAX_SAY);
    var bits = [];
    if (rule.days) bits.push('近 ' + rule.days + ' 天');
    if (rule.from) bits.push(rule.from + ' 寄來的信');
    else bits.push('信箱裡的信');
    if (rule.text) bits.push('而且內容或主旨有「' + rule.text + '」');
    if (rule.unread) bits.push('只要還沒讀的');
    if (rule.hasAttachment) bits.push('只要有附件的');
    var out = bits.join('，');
    if (rule.mentions && rule.mentions.length) {
      out += '，內容提到' + rule.mentions.join('或') + '的特別標起來';
    } else {
      out += '，內容提到我的特別標起來';
    }
    out += rule.summarise === false ? '，摘要取內文開頭就好' : '，每封寫一行摘要';
    return text(out, MAX_SAY);
  }

  return {
    read: read,
    merge: merge,
    grounded: grounded,
    fingerprint: fingerprint,
    isStale: isStale,
    isWide: isWide,
    sentenceOf: sentenceOf,
    nameFor: nameFor,
    daysIn: daysIn,
    dailyIn: dailyIn,
    sendersIn: sendersIn,
    keywordsIn: keywordsIn,
    norm: norm,
    MAX_SAY: MAX_SAY,
    MAX_BODIES: MAX_BODIES
  };
}));
