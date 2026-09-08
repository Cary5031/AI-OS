'use strict';

/* ===========================================================================
   AI-OS // custom themes
   ---------------------------------------------------------------------------
   The fourteen built-in palettes live in os.css and were tuned by hand. This is
   the machinery for the ones a person makes: pick one colour, get a whole
   palette that clears the same contrast rules the built-ins are held to, then
   adjust any item that does not sit right, watch it in a preview, and keep as
   many of them as you like.

   Three layers, each usable without the one above it, all hung off the
   registry shell.js already owns (AIOS.palette is taken: that is the document
   colour palette the office applications share, and it must stay theirs):

     AIOS.themes.color    sRGB <-> OKLCH, WCAG contrast, mixing. Pure arithmetic.
     AIOS.themes.palette  one primary colour + dark/light -> the eleven
                          editable colours, then the nine derived ones (glass,
                          hairlines, glow ...) a theme block needs. Also the
                          contrast check.
     AIOS.themes.*        the saved list: install as a <style>, apply, preview,
                          save, remove.
     AIOS.themer          the editor window.

   A custom theme is stored as {id, name, mode, primary, overrides}: the choice,
   not the result. Every colour that is not overridden is derived again from the
   primary at load, so a person who picked one colour and liked what came out
   never ends up with a stale copy -- and a person who changed three of them by
   hand keeps exactly those three. The palette reaches the page the same way the
   built-ins do: a `[data-theme="u-…"]` block, generated into a <style> element,
   so the menu's swatches, the generated programs' frames and every rule in
   os.css see nothing different from a theme that shipped.
   =========================================================================== */

/* global window, document */

(function () {
  var AIOS = (window.AIOS = window.AIOS || {});
  var A = window.aios;
  var themes = AIOS.themes;
  if (!themes) return;   // loaded out of order; shell.js owns the list

  function T(key, zh, vars) { return AIOS.i18n ? AIOS.i18n.t(key, zh, vars) : zh; }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ####################################################### colour maths #### */

  var color = (function () {
    function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

    function parse(hex) {
      var s = String(hex == null ? '' : hex).trim();
      var m = /^#?([0-9a-f]{6})$/i.exec(s);
      if (!m) {
        var short = /^#?([0-9a-f]{3})$/i.exec(s);
        if (!short) return null;
        m = [null, short[1].split('').map(function (c) { return c + c; }).join('')];
      }
      var n = parseInt(m[1], 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }

    function hex(rgb) {
      function h(v) {
        v = Math.max(0, Math.min(255, Math.round(v)));
        return (v < 16 ? '0' : '') + v.toString(16);
      }
      return '#' + h(rgb.r) + h(rgb.g) + h(rgb.b);
    }

    function toLinear(c) {
      c /= 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    function fromLinear(v) {
      v = clamp01(v);
      return (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255;
    }

    /** WCAG relative luminance -- the same formula wiring.test.js holds the built-ins to. */
    function luminance(c) {
      var rgb = typeof c === 'string' ? parse(c) : c;
      if (!rgb) return 0;
      return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
    }
    function contrast(a, b) {
      var la = luminance(a), lb = luminance(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    }

    /* OKLab (Björn Ottosson, 2020). Chosen over HSL because equal steps in L
       look like equal steps, which is what lets "make it 0.01 lighter until it
       is legible" produce a colour that still looks like the one asked for. */
    function rgbToOklab(c) {
      var r = toLinear(c.r), g = toLinear(c.g), b = toLinear(c.b);
      var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
      var m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
      var s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
      return {
        L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
      };
    }
    function oklabToLinear(o) {
      var l_ = o.L + 0.3963377774 * o.a + 0.2158037573 * o.b;
      var m_ = o.L - 0.1055613458 * o.a - 0.0638541728 * o.b;
      var s_ = o.L - 0.0894841775 * o.a - 1.2914855480 * o.b;
      var l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
      return {
        r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
      };
    }
    function inGamut(lin) {
      var e = 0.0005;
      return lin.r >= -e && lin.r <= 1 + e && lin.g >= -e && lin.g <= 1 + e && lin.b >= -e && lin.b <= 1 + e;
    }
    function linToHex(lin) {
      return hex({ r: fromLinear(lin.r), g: fromLinear(lin.g), b: fromLinear(lin.b) });
    }
    function lchToLab(L, C, h) {
      var r = h * Math.PI / 180;
      return { L: L, a: C * Math.cos(r), b: C * Math.sin(r) };
    }

    function toOklch(c) {
      var rgb = typeof c === 'string' ? parse(c) : c;
      if (!rgb) return null;
      var o = rgbToOklab(rgb);
      var C = Math.sqrt(o.a * o.a + o.b * o.b);
      var h = Math.atan2(o.b, o.a) * 180 / Math.PI;
      if (h < 0) h += 360;
      return { L: o.L, C: C, h: h };
    }

    /**
     * OKLCH -> hex. A colour that does not exist in sRGB keeps its lightness and
     * hue and loses chroma until it does: a vivid cyan asked for at L 0.95 comes
     * back as the palest cyan that is that light, not as white with a clamp.
     */
    function fromOklch(L, C, h) {
      L = clamp01(L);
      C = Math.max(0, C);
      var lin = oklabToLinear(lchToLab(L, C, h));
      if (!inGamut(lin)) {
        var lo = 0, hi = C;
        for (var i = 0; i < 18; i++) {
          var mid = (lo + hi) / 2;
          if (inGamut(oklabToLinear(lchToLab(L, mid, h)))) lo = mid; else hi = mid;
        }
        lin = oklabToLinear(lchToLab(L, lo, h));
      }
      return linToHex(lin);
    }

    /** a + t * (b - a), in OKLab, so the midpoint of two colours is the one a person would draw. */
    function mix(a, b, t) {
      var A = rgbToOklab(parse(a)), B = rgbToOklab(parse(b));
      return linToHex(oklabToLinear({
        L: A.L + (B.L - A.L) * t, a: A.a + (B.a - A.a) * t, b: A.b + (B.b - A.b) * t
      }));
    }

    function alpha(c, a) {
      var rgb = parse(c);
      return 'rgba(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ', ' + a + ')';
    }

    /** Six lowercase hex digits with a #, or null for anything that is not a colour. */
    function normalize(c) {
      var rgb = parse(c);
      return rgb ? hex(rgb) : null;
    }

    return {
      parse: parse, hex: hex, luminance: luminance, contrast: contrast,
      toOklch: toOklch, fromOklch: fromOklch, mix: mix, alpha: alpha, normalize: normalize
    };
  })();
  themes.color = color;

  /* ############################################################ palette #### */

  /* The eleven a person can touch, in the order the editor lists them. The
     names are what the editor shows; the hints say where each one is drawn,
     because 「fg-dim」 tells nobody what will change when they move it. */
  var KEYS = [
    { key: 'bg-0',     zh: '底色',       hint: '最底層的背景：桌面與視窗後面那一片' },
    { key: 'bg-1',     zh: '面板底',     hint: '桌面漸層、面板與視窗的底色' },
    { key: 'fg',       zh: '文字',       hint: '主要文字' },
    { key: 'fg-dim',   zh: '次要文字',   hint: '選單、視窗標題、次要內容' },
    { key: 'fg-faint', zh: '說明文字',   hint: '附註、狀態列、佔位字' },
    { key: 'accent',   zh: '主色',       hint: '按鈕、連結、焦點、選取' },
    { key: 'accent-2', zh: '第二主色',   hint: '成功訊息、連線燈、另一組強調' },
    { key: 'warn',     zh: '警告',       hint: '預算超出、需要注意的訊息' },
    { key: 'danger',   zh: '危險',       hint: '錯誤、刪除、關機' },
    { key: 'taint',    zh: '汙染標記',   hint: '讀過不可信內容時的標記' },
    { key: 'on-fill',  zh: '填色上的文字', hint: '主色、警告、危險當底色時，上面那行字' }
  ];
  var KEY_IDS = KEYS.map(function (k) { return k.key; });

  /* What is read as text on the page, and what is used as a solid fill with
     --on-fill written on top. Same two lists wiring.test.js checks the built-ins
     with; a custom theme is held to the same floor. */
  var TEXT_KEYS = ['fg', 'fg-dim', 'fg-faint', 'accent', 'accent-2', 'warn', 'danger', 'taint'];
  var FILL_KEYS = ['accent', 'accent-2', 'warn', 'danger'];
  var FLOOR = 4.5;

  /* The signal colours keep their meaning across every theme: warning is amber,
     danger is red, taint is purple. A blue theme and a green theme still agree
     on what red means. Hues in OKLCH degrees. */
  var HUE = { warn: 85, danger: 22, taint: 312 };

  function angDist(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  /**
   * The second accent's hue: rotated away from the primary, landing as far as
   * possible from the three signal hues so it cannot be mistaken for one of
   * them. Nearer rotations are tried first, so the pair stays related.
   */
  function secondHue(h, neutral) {
    if (neutral) return 160;
    var best = null;
    [-60, 60, -80, 80, -100, 100].forEach(function (rot) {
      var cand = (h + rot + 360) % 360;
      var d = Math.min(angDist(cand, HUE.warn), angDist(cand, HUE.danger), angDist(cand, HUE.taint));
      if (!best || d > best.d + 1e-9) best = { h: cand, d: d };
    });
    return best.h;
  }

  /**
   * Nudge colours until every text/ground and fill/label pair clears the floor.
   * Lightness moves away from the page -- up on a dark one, down on a light one
   * -- one step at a time, hue and chroma kept, so the result is the colour
   * that was asked for at the nearest legible lightness.
   */
  function legible(c, light) {
    var out = {};
    Object.keys(c).forEach(function (k) { out[k] = c[k]; });
    var dir = light ? -1 : 1;
    function passes(key, against) {
      return against.every(function (g) { return color.contrast(out[key], g) >= FLOOR; });
    }
    function walk(key, against, step) {
      var o = color.toOklch(out[key]);
      for (var n = 0; n < 100; n++) {
        if (passes(key, against)) return true;
        o.L += step;
        if (o.L < 0 || o.L > 1) return false;
        out[key] = color.fromOklch(o.L, o.C, o.h);
      }
      return passes(key, against);
    }
    /* Away from the page first; the other way if that ran out of room (a
       ground someone overrode to mid-grey may only be beaten from the other
       side); and the colour it started as if neither works -- a pair that
       lightness alone cannot fix must not come back as black or white with
       the pair still failing. */
    function push(key, against) {
      var start = out[key];
      if (walk(key, against, dir * 0.01)) return;
      out[key] = start;
      if (walk(key, against, -dir * 0.01)) return;
      out[key] = start;
    }
    var grounds = [out['bg-0'], out['bg-1']];
    TEXT_KEYS.forEach(function (k) { push(k, grounds); });
    /* A fill has to read against the page and carry its label: both at once,
       or the label push would undo the ground push. */
    FILL_KEYS.forEach(function (k) { push(k, grounds.concat([out['on-fill']])); });
    return out;
  }

  /**
   * One colour in, eleven out.
   *
   * The primary sets the hue of everything neutral -- backgrounds and text are
   * tinted toward it, faintly, which is what makes a palette read as one thing
   * rather than a colour dropped onto grey. Its lightness is only a suggestion:
   * a navy picked as the primary of a dark theme comes out as the lightest navy
   * that reads on the page, because an accent nobody can read is not an accent.
   */
  function derive(primary, mode) {
    var p = color.toOklch(primary) || { L: 0.78, C: 0.14, h: 220 };
    var light = mode === 'light';
    /* Greys, and nothing paler than a grey: a pastel is still a hue. */
    var neutral = p.C < 0.012;
    var h = p.h;
    /* The tint the neutrals carry: a fraction of the primary's chroma, capped
       so a screaming primary still gives a quiet page. */
    var tint = neutral ? 0 : Math.min(p.C, 0.12) * 0.2;
    /* The accent keeps the primary's hue; its chroma has a floor so a pale
       pick still yields an accent that is tellable from the secondary text,
       and its lightness is held clear of the text it sits beside -- a navy
       chosen for a light theme must not come out as the body text colour. */
    var accC = neutral ? 0 : Math.max(0.08, Math.min(p.C, light ? 0.17 : 0.19));
    /* Dark mode caps it at 0.90: above that there is no room in sRGB for any
       chroma, and a pastel pick would come out as an off-white accent. */
    var accL = light ? Math.max(0.40, Math.min(p.L, 0.52)) : Math.min(0.90, Math.max(p.L, neutral ? 0.86 : 0.80));
    var h2 = secondHue(h, neutral);
    var c = {};
    if (!light) {
      c['bg-0'] = color.fromOklch(0.135, tint * 0.75, h);
      c['bg-1'] = color.fromOklch(0.175, tint, h);
      c['fg'] = color.fromOklch(0.93, tint * 0.5, h);
      c['fg-dim'] = color.fromOklch(0.745, tint * 0.9, h);
      c['fg-faint'] = color.fromOklch(0.64, tint * 0.9, h);
      c['accent'] = color.fromOklch(accL, accC, h);
      c['accent-2'] = color.fromOklch(0.86, neutral ? 0.11 : 0.13, h2);
      c['warn'] = color.fromOklch(0.86, 0.15, HUE.warn);
      c['danger'] = color.fromOklch(0.75, 0.16, HUE.danger);
      c['taint'] = color.fromOklch(0.79, 0.14, HUE.taint);
      c['on-fill'] = color.fromOklch(0.17, tint, h);
    } else {
      c['bg-0'] = color.fromOklch(0.945, tint * 0.6, h);
      c['bg-1'] = color.fromOklch(0.978, tint * 0.3, h);
      c['fg'] = color.fromOklch(0.25, tint, h);
      c['fg-dim'] = color.fromOklch(0.43, tint, h);
      c['fg-faint'] = color.fromOklch(0.53, tint, h);
      c['accent'] = color.fromOklch(accL, accC, h);
      c['accent-2'] = color.fromOklch(0.48, neutral ? 0.09 : 0.12, h2);
      c['warn'] = color.fromOklch(0.50, 0.11, 75);
      c['danger'] = color.fromOklch(0.53, 0.19, HUE.danger);
      c['taint'] = color.fromOklch(0.47, 0.17, 305);
      c['on-fill'] = '#ffffff';
    }
    /* A primary that shares a signal colour's hue -- a red one, say -- would
       make the primary button and the delete button the same colour. The
       accent moves a step further from the page than the signal, and loses a
       little chroma, so the two stay tellable apart at a glance. */
    if (!neutral) {
      ['warn', 'danger', 'taint'].forEach(function (k) {
        if (angDist(h, HUE[k]) > 22) return;
        var s = color.toOklch(c[k]);
        var a = color.toOklch(c.accent);
        if (Math.abs(a.L - s.L) >= 0.10) return;
        var L = light ? Math.min(s.L, a.L) - 0.10 : Math.max(s.L, a.L) + 0.10;
        c.accent = color.fromOklch(Math.max(0.2, Math.min(0.95, L)), Math.min(a.C, 0.12), h);
      });
    }
    return legible(c, light);
  }

  /** The eleven colours of a saved theme: derived from its primary, then its overrides on top. */
  function resolve(rec) {
    var out = derive(rec.primary, rec.mode);
    var ov = rec.overrides || {};
    KEY_IDS.forEach(function (k) {
      var v = color.normalize(ov[k]);
      if (v) out[k] = v;
    });
    return out;
  }

  /** The pairs below the floor, empty when the palette is legible everywhere. */
  function check(c) {
    var bad = [];
    TEXT_KEYS.forEach(function (k) {
      ['bg-0', 'bg-1'].forEach(function (g) {
        var r = color.contrast(c[k], c[g]);
        if (r < FLOOR) bad.push({ key: k, against: g, ratio: r });
      });
    });
    FILL_KEYS.forEach(function (k) {
      var r = color.contrast(c[k], c['on-fill']);
      if (r < FLOOR) bad.push({ key: k, against: 'on-fill', ratio: r });
    });
    return bad;
  }

  function isLight(c) { return color.luminance(c['bg-0']) >= 0.5; }

  /**
   * Every custom property a theme block carries. The eleven, then the nine that
   * os.css derives from them by hand in each built-in block: translucent panel
   * fills, hairlines, the opaque colours the native <select> popup needs, the
   * grid, the glow and the shadow.
   */
  function vars(c) {
    var light = isLight(c);
    var acc = color.toOklch(c.accent) || { L: 0.7, C: 0, h: 0 };
    var v = {};
    KEY_IDS.forEach(function (k) { v[k] = c[k]; });
    if (!light) {
      var hairBase = color.fromOklch(0.82, Math.min(acc.C, 0.10), acc.h);
      v.glass = color.alpha(color.mix(c['bg-1'], c.fg, 0.10), 0.64);
      v['glass-2'] = color.alpha(color.mix(c['bg-1'], c.fg, 0.16), 0.80);
      v.hair = color.alpha(hairBase, 0.13);
      v['hair-2'] = color.alpha(hairBase, 0.26);
      v['pop-bg'] = color.mix(c['bg-1'], c.fg, 0.04);
      v['pop-sel'] = color.mix(c['bg-1'], c.fg, 0.16);
      v.grid = color.alpha(hairBase, 0.05);
      v.glow = color.alpha(c.accent, 0.26);
      v.shadow = '0 26px 70px rgba(0, 0, 0, .62)';
    } else {
      var inkBase = color.fromOklch(0.40, Math.min(acc.C, 0.08), acc.h);
      v.glass = 'rgba(255, 255, 255, .74)';
      v['glass-2'] = 'rgba(255, 255, 255, .9)';
      v.hair = color.alpha(inkBase, 0.14);
      v['hair-2'] = color.alpha(inkBase, 0.28);
      v['pop-bg'] = '#ffffff';
      v['pop-sel'] = color.mix(c['bg-0'], c.accent, 0.18);
      v.grid = color.alpha(inkBase, 0.05);
      v.glow = color.alpha(c.accent, 0.2);
      v.shadow = '0 20px 50px ' + color.alpha(inkBase, 0.18);
    }
    return v;
  }

  /* What may stand in a selector. One character shorter than the store's own
     rule so the editor's draft ('u-draft') passes; the store never issues one
     that short, so nothing saved can collide with it. */
  var ID_RE = /^u-[a-z0-9]{5,16}$/;

  /**
   * The CSS block for one theme, in the shape os.css uses: both the root
   * selector and the bare attribute one, so a swatch carrying data-theme paints
   * itself with the real colours exactly as it does for a built-in.
   */
  function cssFor(id, c) {
    if (!ID_RE.test(String(id))) throw new Error('bad theme id: ' + id);
    var v = vars(c);
    var lines = Object.keys(v).map(function (k) { return '  --' + k + ': ' + v[k] + ';'; });
    return ':root[data-theme="' + id + '"],\n[data-theme="' + id + '"] {\n' + lines.join('\n') + '\n}\n';
  }

  /**
   * A built-in theme's colours, read from the stylesheet rather than copied:
   * an element carrying data-theme picks up that block, and computed style
   * hands the values back. Used to seed a new custom theme from what is on
   * screen -- and only for its primary and its light/dark, not as a copy.
   */
  function builtinColors(id) {
    var probe = el('span');
    probe.setAttribute('data-theme', id);
    probe.style.display = 'none';
    document.body.appendChild(probe);
    var cs = window.getComputedStyle(probe);
    var out = {};
    KEY_IDS.forEach(function (k) {
      var raw = cs.getPropertyValue('--' + k).trim();
      out[k] = color.normalize(raw) || raw;
    });
    probe.remove();
    return out;
  }

  var palette = {
    KEYS: KEYS, KEY_IDS: KEY_IDS, TEXT_KEYS: TEXT_KEYS, FILL_KEYS: FILL_KEYS, FLOOR: FLOOR,
    ID_RE: ID_RE,
    derive: derive, resolve: resolve, legible: legible, check: check,
    isLight: isLight, vars: vars, cssFor: cssFor, builtinColors: builtinColors
  };
  themes.palette = palette;

  /* ########################################################### registry #### */

  var STYLE_ID = 'custom-themes';
  var DRAFT_ID = 'u-draft';
  var DRAFT_STYLE_ID = 'theme-draft';
  var previewBefore = null;

  function styleNode(id) {
    var st = document.getElementById(id);
    if (!st) {
      st = el('style');
      st.id = id;
      document.head.appendChild(st);
    }
    return st;
  }

  /** Replace the saved list and regenerate the stylesheet from it. */
  themes.setCustom = function (list) {
    themes.custom = (list || []).filter(function (t) {
      return t && ID_RE.test(String(t.id)) && typeof t.name === 'string';
    }).map(function (t) {
      return { id: t.id, name: t.name, mode: t.mode === 'light' ? 'light' : 'dark',
        primary: color.normalize(t.primary) || '#4fd6ff', overrides: t.overrides || {} };
    });
    themes.install();
  };

  /** Write every custom theme's block into the page. Idempotent. */
  themes.install = function () {
    var css = themes.custom.map(function (t) {
      try { return cssFor(t.id, resolve(t)); } catch (e) { return ''; }
    }).join('\n');
    styleNode(STYLE_ID).textContent = css;
    /* The page may be wearing one of them, and its light/dark flag depends on
       the block that was just rewritten. */
    if (themes.current() !== DRAFT_ID) themes.syncLight();
  };

  /** The eleven colours the page would use for `id`, custom or built-in. */
  themes.colorsOf = function (id) {
    var rec = themes.find(id);
    if (rec) return resolve(rec);
    return builtinColors(id);
  };

  /**
   * Put a theme on the page. The one place that sets data-theme, so the flag
   * the light-page rules hang off (data-light) cannot be forgotten: it is read
   * from the resulting --bg-0, which makes it right for a built-in, a custom
   * theme, and a custom theme that was just edited from dark to light.
   */
  themes.apply = function (id) {
    document.documentElement.setAttribute('data-theme', id);
    themes.syncLight();
  };

  themes.syncLight = function () {
    var cs = window.getComputedStyle(document.documentElement);
    var bg = cs.getPropertyValue('--bg-0').trim();
    var rgb = color.parse(bg);
    var light = !!rgb && color.luminance(rgb) >= 0.5;
    if (light) document.documentElement.setAttribute('data-light', '');
    else document.documentElement.removeAttribute('data-light');
    themes.report(cs, light);
  };

  /* The twenty variables a theme block sets: the eleven editable ones and the
     nine vars() derives. main/askbox.js keeps the same list. */
  var REPORT_KEYS = KEY_IDS.concat(['glass', 'glass-2', 'hair', 'hair-2', 'pop-bg', 'pop-sel', 'grid', 'glow', 'shadow']);

  /**
   * Tell the main process what the page is wearing, so the confirmation layer
   * it draws over this window (askbox.html) comes out in the same colours.
   * Read from computed style rather than from the record: that is what the
   * page is actually painting with, built-in, custom or draft alike.
   */
  themes.report = function (cs, light) {
    if (!A || !A.themes || typeof A.themes.report !== 'function') return;
    var vars = {};
    REPORT_KEYS.forEach(function (k) { vars[k] = cs.getPropertyValue('--' + k).trim(); });
    var r = A.themes.report({ id: themes.current(), light: !!light, vars: vars });
    if (r && typeof r.catch === 'function') r.catch(function () { /* cosmetic */ });
  };

  /**
   * Try a draft on the whole desktop. `rec` null takes it off again and puts
   * back whatever was on before. The draft never reaches the session file: see
   * persistable().
   */
  themes.preview = function (rec) {
    if (!rec) {
      if (previewBefore !== null) {
        var back = previewBefore;
        previewBefore = null;
        styleNode(DRAFT_STYLE_ID).textContent = '';
        themes.apply(themes.has(back) ? back : 'void');
      }
      return;
    }
    if (previewBefore === null) previewBefore = themes.current();
    styleNode(DRAFT_STYLE_ID).textContent = cssFor(DRAFT_ID, resolve(rec));
    themes.apply(DRAFT_ID);
  };
  themes.previewing = function () { return previewBefore !== null; };

  /** The theme the session should remember: never the draft. */
  themes.persistable = function () {
    var now = themes.current();
    return now === DRAFT_ID ? (previewBefore || 'void') : now;
  };

  /** Save through the main process, which validates and keeps the file. */
  themes.save = async function (rec) {
    var r = await A.themes.save({
      id: rec.id || null, name: rec.name, mode: rec.mode, primary: rec.primary, overrides: rec.overrides || {}
    });
    if (!r || !r.ok) return r || { ok: false, error: '?' };
    themes.setCustom(r.data.themes);
    afterChange();
    return r;
  };

  /** The menu, if it is open, and the model's view of the machine both learn the new list. */
  function afterChange() {
    if (AIOS.paintThemeMenu) {
      var drop = document.getElementById('drop-theme');
      if (drop && !drop.hidden) AIOS.paintThemeMenu();
    }
    if (AIOS.refreshMachineState) AIOS.refreshMachineState();
  }

  themes.remove = async function (id) {
    var r = await A.themes.remove(id);
    if (!r || !r.ok) return r || { ok: false, error: '?' };
    var wearing = themes.current() === id || (previewBefore === id);
    themes.setCustom(r.data.themes);
    if (wearing) {
      /* The page was wearing the theme that just went. Back to the default
         rather than left on a block that no longer exists. */
      if (previewBefore === id) previewBefore = 'void';
      if (themes.current() === id) themes.apply('void');
      if (AIOS.apps && AIOS.apps.requestSave) AIOS.apps.requestSave();
    }
    afterChange();
    return r;
  };

  /* ############################################################# editor #### */

  var WIN_ID = 'sys:themer';

  /** A fresh draft seeded from what is on screen: its primary and its light/dark, nothing else. */
  function draftFromCurrent() {
    var now = themes.persistable();
    var rec = themes.find(now);
    if (rec) {
      return { id: null, name: '', mode: rec.mode, primary: rec.primary, overrides: {} };
    }
    var c = builtinColors(themes.has(now) ? now : 'void');
    return { id: null, name: '', mode: isLight(c) ? 'light' : 'dark', primary: c.accent, overrides: {} };
  }

  function copyOf(rec) {
    var ov = {};
    Object.keys(rec.overrides || {}).forEach(function (k) { ov[k] = rec.overrides[k]; });
    return { id: rec.id, name: rec.name, mode: rec.mode, primary: rec.primary, overrides: ov };
  }

  function ratioText(r) { return r.toFixed(1) + ':1'; }

  function keyLabel(k) {
    var def = KEYS.filter(function (d) { return d.key === k; })[0];
    return def ? T('thm.key.' + k, def.zh) : k;
  }

  /**
   * The editor. One window; opening it again for another theme repaints it.
   *
   * Left: the choices -- name, dark or light, the primary, then the eleven
   * items with what the system chose for each and a way to override or to hand
   * one back. Right: a preview built out of the same custom properties the
   * desktop uses, so what it shows is what the desktop will do, not a picture
   * of it. Below: save, save and wear, duplicate, delete.
   */
  async function open(themeId) {
    /* Reopening repaints the one window. A draft with unsaved changes is not
       replaced under the person's hands: asking for the theme already on the
       bench (or 「自訂主題…」 while a new one is being made) just brings the
       window forward; asking for another gets the question closing would ask. */
    if (state && state.dirty) {
      var same = (themeId || null) === (state.draft.id || null);
      if (same) {
        var open_ = AIOS.wm.list().filter(function (w) { return w.id === WIN_ID; })[0];
        if (open_) {
          if (open_.minimized) AIOS.wm.restore(open_); else AIOS.wm.focus(open_);
          return;
        }
      } else {
        var ok = await closeGuard();
        if (!ok) return;
      }
    }
    AIOS.wm.open({
      id: WIN_ID, kind: 'THEME', title: T('thm.title', '自訂主題'), w: 960, h: 680,
      confirmClose: function () { return closeGuard(); },
      onClose: function () { themes.preview(null); state = null; },
      render: function (body) { render(body, themeId); }
    });
  }

  var state = null;   // { draft, dirty, dom }

  async function closeGuard() {
    if (!state || !state.dirty) return true;
    var choice = await AIOS.confirmSave({
      label: T('thm.unsaved', '這個主題有未儲存的變更'),
      note: T('thm.unsavedNote', '「儲存」會存成自訂主題；「不儲存」會丟掉這些變更。'),
      host: state.dom.root.closest('.win') || undefined
    });
    if (choice === 'save') return !!(await save(false));
    return choice === 'discard';
  }

  function render(body, themeId) {
    body.innerHTML = '';
    themes.preview(null);
    var rec = themeId ? themes.find(themeId) : null;
    state = {
      draft: rec ? copyOf(rec) : draftFromCurrent(),
      dirty: false,
      dom: {}
    };
    var dom = state.dom;
    var draft = state.draft;

    var root = el('div', 'thm');
    dom.root = root;
    body.appendChild(root);

    /* ---- which one --------------------------------------------------- */
    var top = el('div', 'thm-top');
    top.appendChild(el('label', 'thm-lab', T('thm.which', '主題')));
    var pick = el('select', 'mp-input thm-pick');
    pick.setAttribute('aria-label', T('thm.which', '主題'));
    dom.pick = pick;
    top.appendChild(pick);
    var bNew = el('button', 'fbtn', T('thm.new', '＋ 新主題'));
    bNew.type = 'button';
    bNew.title = T('thm.newTitle', '從目前主題的主色調開始一個新的');
    top.appendChild(bNew);
    root.appendChild(top);

    var main = el('div', 'thm-main');
    root.appendChild(main);

    /* ---- the choices ------------------------------------------------- */
    var form = el('form', 'thm-form');
    // Enter in a field saves, the way a form is expected to.
    form.addEventListener('submit', function (e) { e.preventDefault(); save(false); });
    main.appendChild(form);

    var nameLab = el('label', 'thm-lab', T('thm.name', '名稱'));
    nameLab.htmlFor = 'thm-name';
    form.appendChild(nameLab);
    var name = el('input', 'mp-input thm-name');
    name.id = 'thm-name';
    name.type = 'text';
    name.maxLength = 40;
    name.placeholder = T('thm.namePh', '例如：我的藍、夜櫻');
    name.value = draft.name;
    dom.name = name;
    form.appendChild(name);

    form.appendChild(el('label', 'thm-lab', T('thm.mode', '明暗')));
    var seg = el('div', 'thm-seg');
    seg.setAttribute('role', 'radiogroup');
    [['dark', T('thm.dark', '深色')], ['light', T('thm.light', '淺色')]].forEach(function (pair) {
      var b = el('button', 'fbtn', pair[1]);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('data-mode', pair[0]);
      b.addEventListener('click', function () {
        if (draft.mode === pair[0]) return;
        draft.mode = pair[0];
        touch();
        repaint();
      });
      seg.appendChild(b);
    });
    dom.seg = seg;
    form.appendChild(seg);

    var primLab = el('label', 'thm-lab', T('thm.primary', '主色調'));
    primLab.htmlFor = 'thm-primary';
    form.appendChild(primLab);
    var prow = el('div', 'thm-row thm-row-primary');
    var pin = el('input', 'thm-swatch-in');
    pin.id = 'thm-primary';
    pin.type = 'color';
    pin.setAttribute('aria-label', T('thm.primary', '主色調'));
    var phex = el('input', 'mp-input thm-hex');
    phex.type = 'text';
    phex.spellcheck = false;
    phex.maxLength = 7;
    phex.setAttribute('aria-label', T('thm.primaryHex', '主色調（十六進位）'));
    dom.pin = pin; dom.phex = phex;
    prow.appendChild(pin);
    prow.appendChild(phex);
    /* The built-ins as starting points: their primary and their light/dark,
       so 「像深海那樣但偏綠」 is two clicks rather than a search for a hex. */
    var seedSel = el('select', 'mp-input thm-seed');
    seedSel.setAttribute('aria-label', T('thm.seed', '從內建主題取主色調'));
    var o0 = document.createElement('option');
    o0.value = ''; o0.textContent = T('thm.seed', '從內建主題取主色調…');
    seedSel.appendChild(o0);
    themes.list.forEach(function (t) {
      var o = document.createElement('option');
      o.value = t.id; o.textContent = T('theme.' + t.id, t.label);
      seedSel.appendChild(o);
    });
    seedSel.addEventListener('change', function () {
      if (!seedSel.value) return;
      var c = builtinColors(seedSel.value);
      draft.primary = c.accent;
      draft.mode = isLight(c) ? 'light' : 'dark';
      seedSel.value = '';
      touch();
      repaint();
    });
    prow.appendChild(seedSel);
    form.appendChild(prow);
    form.appendChild(el('p', 'micro', T('thm.primaryNote',
      '其餘顏色由系統依主色調搭配，亮度會自動調到讀得清楚（對比 4.5:1 以上）。你手動改過的細項不會被主色調牽動。')));

    function onPrimary(v) {
      var hexv = color.normalize(v);
      if (!hexv) return;
      if (hexv === draft.primary) return;
      draft.primary = hexv;
      touch();
      repaint();
    }
    pin.addEventListener('input', function () { onPrimary(pin.value); });
    phex.addEventListener('change', function () {
      var hexv = color.normalize(phex.value);
      if (!hexv) { phex.value = draft.primary; return; }
      onPrimary(hexv);
    });

    /* ---- the eleven -------------------------------------------------- */
    var head = el('div', 'thm-head');
    head.appendChild(el('label', 'thm-lab', T('thm.details', '細項')));
    var bAuto = el('button', 'fbtn', T('thm.autoAll', '全部交給系統搭配'));
    bAuto.type = 'button';
    bAuto.title = T('thm.autoAllTitle', '丟掉所有手動調整，重新從主色調搭配');
    bAuto.addEventListener('click', function () {
      if (!Object.keys(draft.overrides).length) return;
      draft.overrides = {};
      touch();
      repaint();
    });
    dom.bAuto = bAuto;
    head.appendChild(bAuto);
    form.appendChild(head);
    form.appendChild(el('p', 'micro', T('thm.detailsNote',
      '每一項都可以自己選。改過的會標「手動」，按 ↺ 交回給系統。')));

    /* ---- legibility, above the rows so it is seen without scrolling ------ */
    var checkBox = el('div', 'thm-check');
    dom.check = checkBox;
    form.appendChild(checkBox);

    var rows = el('div', 'thm-rows');
    dom.rows = {};
    KEYS.forEach(function (def) {
      var row = el('div', 'thm-row');
      row.setAttribute('data-key', def.key);
      var sw = el('input', 'thm-swatch-in');
      sw.type = 'color';
      sw.setAttribute('aria-label', keyLabel(def.key));
      var hx = el('input', 'mp-input thm-hex');
      hx.type = 'text';
      hx.spellcheck = false;
      hx.maxLength = 7;
      hx.setAttribute('aria-label', keyLabel(def.key) + T('thm.hexSuffix', '（十六進位）'));
      var text = el('div', 'thm-row-text');
      text.appendChild(el('b', null, keyLabel(def.key)));
      text.appendChild(el('span', null, T('thm.hint.' + def.key, def.hint)));
      var tag = el('em', 'thm-tag');
      var reset = el('button', 'fbtn thm-reset', '↺');
      reset.type = 'button';
      reset.title = T('thm.resetOne', '交回給系統搭配');
      reset.setAttribute('aria-label', T('thm.resetOne', '交回給系統搭配') + '：' + keyLabel(def.key));
      reset.addEventListener('click', function () {
        if (!(def.key in draft.overrides)) return;
        delete draft.overrides[def.key];
        touch();
        repaint();
      });
      function setOne(v) {
        var hexv = color.normalize(v);
        if (!hexv) return;
        if (draft.overrides[def.key] === hexv) return;
        draft.overrides[def.key] = hexv;
        touch();
        repaint();
      }
      sw.addEventListener('input', function () { setOne(sw.value); });
      hx.addEventListener('change', function () {
        var hexv = color.normalize(hx.value);
        if (!hexv) { repaint(); return; }
        setOne(hexv);
      });
      row.appendChild(sw);
      row.appendChild(hx);
      row.appendChild(text);
      row.appendChild(tag);
      row.appendChild(reset);
      rows.appendChild(row);
      dom.rows[def.key] = { sw: sw, hx: hx, tag: tag, reset: reset, row: row };
    });
    form.appendChild(rows);

    /* ---- the preview ------------------------------------------------- */
    var side = el('div', 'thm-side');
    main.appendChild(side);
    var pvHead = el('div', 'thm-head');
    pvHead.appendChild(el('label', 'thm-lab', T('thm.preview', '即時預覽')));
    var live = el('label', 'mp-check thm-live');
    var liveIn = el('input');
    liveIn.type = 'checkbox';
    liveIn.addEventListener('change', function () {
      if (liveIn.checked) themes.preview(draft);
      else themes.preview(null);
    });
    live.appendChild(liveIn);
    live.appendChild(document.createTextNode(T('thm.live', '同時套到整個桌面')));
    dom.liveIn = liveIn;
    pvHead.appendChild(live);
    side.appendChild(pvHead);
    var pv = buildPreview();
    dom.pv = pv;
    side.appendChild(pv);

    /* ---- the buttons ------------------------------------------------- */
    var foot = el('div', 'thm-foot');
    var bSave = el('button', 'fbtn', T('save', '儲存'));
    bSave.type = 'button';
    bSave.addEventListener('click', function () { save(false); });
    var bWear = el('button', 'fbtn fbtn-primary', T('thm.saveApply', '儲存並套用'));
    bWear.type = 'button';
    bWear.addEventListener('click', function () { save(true); });
    var bDup = el('button', 'fbtn', T('thm.duplicate', '另存為新主題'));
    bDup.type = 'button';
    bDup.title = T('thm.duplicateTitle', '把這一組連同手動調整複製成另一個主題');
    bDup.addEventListener('click', function () {
      var copy = copyOf(draft);
      copy.id = null;
      copy.name = (draft.name || T('thm.untitled', '未命名')) + T('thm.copySuffix', ' 副本');
      state.draft = draft = copy;
      name.value = draft.name;
      touch();
      refreshPicker();
      repaint();
      name.focus();
      name.select();
    });
    var bDel = el('button', 'fbtn fbtn-danger', T('thm.delete', '刪除'));
    bDel.type = 'button';
    bDel.addEventListener('click', remove);
    dom.bDup = bDup; dom.bDel = bDel;
    var status = el('span', 'thm-status');
    dom.status = status;
    foot.appendChild(bSave);
    foot.appendChild(bWear);
    foot.appendChild(bDup);
    foot.appendChild(bDel);
    foot.appendChild(status);
    root.appendChild(foot);

    /* ---- wiring ------------------------------------------------------ */
    name.addEventListener('input', function () {
      draft.name = name.value;
      touch();
    });
    pick.addEventListener('change', async function () {
      var want = pick.value;
      if ((want || null) === (draft.id || null)) return;
      if (state.dirty) {
        var ok = await closeGuard();
        if (!ok) { refreshPicker(); return; }
      }
      load(want || null);
    });
    bNew.addEventListener('click', async function () {
      if (state.dirty) {
        var ok = await closeGuard();
        if (!ok) return;
      }
      load(null);
    });

    function touch() {
      state.dirty = true;
      say('');
    }

    function load(id) {
      var r = id ? themes.find(id) : null;
      state.draft = draft = r ? copyOf(r) : draftFromCurrent();
      state.dirty = false;
      name.value = draft.name;
      themes.preview(null);
      liveIn.checked = false;
      refreshPicker();
      repaint();
      say('');
    }

    function refreshPicker() {
      pick.innerHTML = '';
      var o = document.createElement('option');
      o.value = '';
      o.textContent = draft.id ? T('thm.pickNew', '（新主題）') : T('thm.pickNewNow', '新主題（尚未儲存）');
      pick.appendChild(o);
      themes.custom.forEach(function (t) {
        var opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.name;
        pick.appendChild(opt);
      });
      pick.value = draft.id || '';
      bDel.disabled = !draft.id;
      bDup.disabled = false;
    }

    function say(text, bad) {
      status.textContent = text || '';
      status.className = 'thm-status' + (bad ? ' mp-bad' : '');
    }

    /** Everything on the left and the right, from the draft. */
    function repaint() {
      var c = resolve(draft);
      var light = draft.mode === 'light';
      Array.prototype.forEach.call(seg.children, function (b) {
        var on = b.getAttribute('data-mode') === draft.mode;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      pin.value = draft.primary;
      phex.value = draft.primary;
      var nOver = 0;
      KEYS.forEach(function (def) {
        var r = dom.rows[def.key];
        var manual = def.key in draft.overrides;
        if (manual) nOver++;
        r.sw.value = c[def.key];
        r.hx.value = c[def.key];
        r.tag.textContent = manual ? T('thm.manual', '手動') : T('thm.auto', '自動');
        r.tag.className = 'thm-tag' + (manual ? ' on' : '');
        r.reset.hidden = !manual;
        r.row.classList.toggle('manual', manual);
      });
      bAuto.disabled = !nOver;
      paintPreview(pv, c);
      paintCheck(c);
      if (liveIn.checked) previewSoon();
    }

    /* The whole-desktop preview rewrites a page-wide stylesheet. A colour
       well fires input on every tick of a drag, so the rewrites are coalesced
       to one per frame. */
    var previewTimer = 0;
    function previewSoon() {
      if (previewTimer) return;
      previewTimer = window.requestAnimationFrame(function () {
        previewTimer = 0;
        if (state && state.draft === draft && liveIn.checked) themes.preview(draft);
      });
    }

    function paintCheck(c) {
      checkBox.innerHTML = '';
      var bad = check(c);
      if (!bad.length) {
        checkBox.className = 'thm-check ok';
        checkBox.appendChild(el('span', null, '✓ ' + T('thm.checkOk', '每一組文字與底色的對比都在 4.5:1 以上')));
        return;
      }
      checkBox.className = 'thm-check bad';
      checkBox.appendChild(el('span', null, '⚠ ' + T('thm.checkBad', '{n} 組讀起來會吃力：', { n: bad.length })));
      var ul = el('ul');
      bad.forEach(function (b) {
        ul.appendChild(el('li', null, keyLabel(b.key) + ' → ' + keyLabel(b.against) + '　' + ratioText(b.ratio)));
      });
      checkBox.appendChild(ul);
      var fix = el('button', 'fbtn', T('thm.fix', '自動修正對比'));
      fix.type = 'button';
      fix.title = T('thm.fixTitle', '只動亮度，色相不變；修過的項目算手動');
      fix.addEventListener('click', function () {
        var fixed = legible(c, isLight(c));
        var changed = 0;
        KEY_IDS.forEach(function (k) {
          if (fixed[k] !== c[k]) { draft.overrides[k] = fixed[k]; changed++; }
        });
        var left = check(fixed).length;
        if (changed) touch();
        repaint();
        /* What lightness could not fix is said, not left to be discovered:
           a ground overridden to mid-grey, or a label colour on the page's
           side of the scale, needs a different colour, not a lighter one. */
        if (left) say(T('thm.unfixable', '{n} 組只靠亮度修不了：改底色或「填色上的文字」的顏色', { n: left }), true);
      });
      checkBox.appendChild(fix);
    }

    refreshPicker();
    repaint();
    if (!draft.id) { name.focus(); }
  }

  /** Persist the draft. Returns the saved record, or null with the reason shown. */
  async function save(wear) {
    if (!state) return null;
    /* Held for the whole call: the window may be repainted for another theme
       while the main process is writing, and the answer must land on the
       draft that was sent, not on whatever is on the bench by then. */
    var st = state;
    var draft = st.draft;
    var dom = st.dom;
    var nm = String(dom.name.value || '').trim();
    if (!nm) {
      dom.status.textContent = T('thm.needName', '先給這個主題一個名稱');
      dom.status.className = 'thm-status mp-bad';
      dom.name.focus();
      return null;
    }
    draft.name = nm;
    var r = await themes.save(draft);
    if (state !== st) return r.ok ? r.data.saved : null;
    if (!r.ok) {
      /* The store's reasons are Chinese; the two a person can act on have an
         English line, the rest show as they are rather than not at all. */
      var why = r.code && AIOS.i18n && AIOS.i18n.has('thm.err.' + r.code) ? T('thm.err.' + r.code, r.error || '?') : (r.error || '?');
      dom.status.textContent = T('thm.saveFail', '沒有存成：{err}', { err: why });
      dom.status.className = 'thm-status mp-bad';
      return null;
    }
    draft.id = r.data.saved.id;
    st.dirty = false;
    dom.pick.innerHTML = '';
    var o = document.createElement('option');
    o.value = ''; o.textContent = T('thm.pickNew', '（新主題）');
    dom.pick.appendChild(o);
    themes.custom.forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t.id; opt.textContent = t.name;
      dom.pick.appendChild(opt);
    });
    dom.pick.value = draft.id;
    dom.bDel.disabled = false;
    dom.status.textContent = T('thm.saved', '已儲存「{name}」', { name: nm });
    dom.status.className = 'thm-status';
    if (AIOS.ui) AIOS.ui.trace(T('thm.savedTrace', '自訂主題「{name}」已儲存', { name: nm }), 't-ok');
    if (wear) {
      dom.liveIn.checked = false;
      themes.preview(null);
      await AIOS.run('theme.set', { mode: draft.id });
    }
    return r.data.saved;
  }

  async function remove() {
    if (!state || !state.draft.id) return;
    var draft = state.draft;
    var dom = state.dom;
    var ok = await AIOS.confirm({
      label: T('thm.deleteAsk', '刪除自訂主題「{name}」？', { name: draft.name }),
      note: T('thm.deleteNote', '正在使用它的話，桌面會回到預設主題。'),
      okLabel: T('thm.delete', '刪除'),
      danger: true,
      host: dom.root.closest('.win') || undefined
    });
    if (!ok) return;
    dom.liveIn.checked = false;
    themes.preview(null);
    var r = await themes.remove(draft.id);
    if (!r.ok) {
      dom.status.textContent = T('thm.deleteFail', '沒有刪掉：{err}', { err: r.error || '?' });
      dom.status.className = 'thm-status mp-bad';
      return;
    }
    if (AIOS.ui) AIOS.ui.trace(T('thm.deletedTrace', '自訂主題「{name}」已刪除', { name: draft.name }), 't-info');
    state.dirty = false;
    render(dom.root.parentNode, null);
  }

  /* ---- the preview: a desktop in miniature ------------------------------- */

  /**
   * Built from the same custom properties the real chrome reads, set inline on
   * the preview's root so they override the page's for this subtree only. The
   * pieces are the ones a person looks at when judging a theme: the menu bar,
   * a window with its title strip, the three weights of text, a link, the
   * three kinds of button, a field, the trace with its four line colours, a
   * chip, the dock.
   */
  function buildPreview() {
    var pv = el('div', 'thm-pv');
    pv.setAttribute('aria-label', T('thm.preview', '即時預覽'));

    var bar = el('div', 'thm-pv-bar');
    bar.appendChild(el('span', 'thm-pv-logo', '◈'));
    [T('mb.system', '系統'), T('mb.view', '檢視'), T('mb.theme', '主題'), T('mb.help', '說明')].forEach(function (t, i) {
      bar.appendChild(el('span', 'thm-pv-mi' + (i === 2 ? ' open' : ''), t));
    });
    var led = el('span', 'thm-pv-led');
    led.appendChild(el('i'));
    led.appendChild(document.createTextNode('ONLINE'));
    bar.appendChild(led);
    bar.appendChild(el('span', 'thm-pv-clock', '12:34:56'));
    pv.appendChild(bar);

    var desk = el('div', 'thm-pv-desk');
    pv.appendChild(desk);

    var win = el('div', 'thm-pv-win');
    var wb = el('div', 'thm-pv-winbar');
    wb.appendChild(el('span', 'thm-pv-kind', 'DOC'));
    wb.appendChild(el('span', 'thm-pv-title', T('thm.pvTitle', '週報.docx')));
    wb.appendChild(el('span', 'thm-pv-wbtn', '–'));
    wb.appendChild(el('span', 'thm-pv-wbtn', '□'));
    wb.appendChild(el('span', 'thm-pv-wbtn', '✕'));
    win.appendChild(wb);
    var body = el('div', 'thm-pv-body');
    body.appendChild(el('h4', 'thm-pv-h', T('thm.pvHeading', '主要文字是標題與內文')));
    body.appendChild(el('p', 'thm-pv-fg', T('thm.pvFg', '這是一段主要文字：文件內文、記憶、對話都用它。')));
    body.appendChild(el('p', 'thm-pv-dim', T('thm.pvDim', '次要文字：選單、視窗標題、表格標頭。')));
    body.appendChild(el('p', 'thm-pv-faint', T('thm.pvFaint', '說明文字：附註、狀態列、佔位字。')));
    var linkP = el('p', 'thm-pv-fg');
    linkP.appendChild(document.createTextNode(T('thm.pvLinkPre', '主色畫的是')));
    linkP.appendChild(el('span', 'thm-pv-link', T('thm.pvLink', '連結與焦點')));
    linkP.appendChild(document.createTextNode(T('thm.pvLinkPost', '，也是選取的顏色。')));
    body.appendChild(linkP);
    var btns = el('div', 'thm-pv-btns');
    btns.appendChild(el('span', 'thm-pv-btn primary', T('thm.pvPrimary', '主要按鈕')));
    btns.appendChild(el('span', 'thm-pv-btn', T('thm.pvPlain', '一般按鈕')));
    btns.appendChild(el('span', 'thm-pv-btn danger', T('thm.pvDanger', '刪除')));
    body.appendChild(btns);
    var field = el('div', 'thm-pv-field');
    field.appendChild(el('span', 'thm-pv-sigil', '>'));
    field.appendChild(el('span', 'thm-pv-ph', T('intent.placeholder', '說出你想達成的事，不用說怎麼做…')));
    body.appendChild(field);
    var trace = el('div', 'thm-pv-trace');
    [['ok', T('thm.pvOk', 'exec fs.write — 已寫入 /notes/週報.md')],
     ['warn', T('thm.pvWarn', 'context 超出預算，驅逐 2 個分頁')],
     ['err', T('thm.pvErr', 'fail net.egress — 政策拒絕')],
     ['taint', T('thm.pvTaint', '讀了不可信內容，提權能力降級')]].forEach(function (pair) {
      var line = el('div', 'thm-pv-t ' + pair[0]);
      line.appendChild(el('b', null, '[ 1.20] '));
      line.appendChild(document.createTextNode(pair[1]));
      trace.appendChild(line);
    });
    body.appendChild(trace);
    var chips = el('div', 'thm-pv-chips');
    chips.appendChild(el('span', 'thm-pv-chip', T('thm.pvChip1', '設定 25 分鐘專注計時')));
    chips.appendChild(el('span', 'thm-pv-chip', T('thm.pvChip2', '整理視窗')));
    body.appendChild(chips);
    win.appendChild(body);
    desk.appendChild(win);

    var dock = el('div', 'thm-pv-dock');
    ['>_', '⨞', '▤', '✎', '◈', '✉'].forEach(function (g, i) {
      dock.appendChild(el('span', 'thm-pv-dk' + (i === 2 ? ' on' : ''), g));
    });
    desk.appendChild(dock);
    return pv;
  }

  function paintPreview(pv, c) {
    var v = vars(c);
    Object.keys(v).forEach(function (k) { pv.style.setProperty('--' + k, v[k]); });
    /* From the colours, not from the dark/light switch: the desktop decides
       the same way (syncLight), so a light theme whose ground was overridden
       dark previews as the dark page it will be. */
    pv.classList.toggle('thm-pv-light', isLight(c));
  }

  AIOS.themer = {
    open: open,
    WIN_ID: WIN_ID,
    /* For the tests: the live draft, or null when the window is closed. */
    draft: function () { return state ? state.draft : null; },
    dirty: function () { return !!(state && state.dirty); }
  };
})();
