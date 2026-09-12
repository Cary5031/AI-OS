/* ===========================================================================
   AI-OS // surfaces
   ---------------------------------------------------------------------------
   Everything the kernel is allowed to act on:

     * wm      - a real window manager (drag, resize, focus, min/max, tile)
     * fs      - a simulated filesystem, including one deliberately hostile file
     * memory  - the warm tier: retrieved by score, paged into context
     * exec    - the implementation behind every op in the syscall table

   Each executor returns { note, undo } so the journal can reverse it.
   =========================================================================== */

/* global window, document, AIOS */

(function () {
  var K = AIOS.kernel;

  function log(msg, cls) { if (AIOS.ui && AIOS.ui.trace) AIOS.ui.trace(msg, cls); }

  /**
   * A single-shot plan cannot contain data it has not read yet, so models fill
   * the gap with a template variable. Writing that to disk would be worse than
   * failing: the file would look real and be wrong. Refusing sends the error
   * back into context and the repair round picks fs.copy instead.
   */
  function looksLikePlaceholder(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s) return false;
    if (/\{\{[\s\S]{0,80}\}\}/.test(s)) return true;
    if (/\$\{[\s\S]{0,80}\}/.test(s)) return true;
    if (/\b(fs\.read|read)\.(result|output|content)\b/i.test(s)) return true;
    if (/^[\[<（(【][^\]>）)】]{0,40}(內容|content|here|此處|略|待填)[^\[<（(【]{0,10}[\]>）)】]$/i.test(s)) return true;
    return false;
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* =======================================================================
     Simulated filesystem
     ===================================================================== */

  /**
   * Client for the real sandbox. Nothing here touches a file: every call goes
   * to the main process, which validates the path, checks the capability and
   * enforces the quota. A cached listing is kept so path resolution and the
   * machine-state context page do not need a round trip per lookup.
   */
  AIOS.fs = {
    cache: { files: [], dirs: [], bytes: 0, at: 0 },

    async refresh() {
      var res = await window.aios.fs.tree();
      if (res && res.ok) {
        this.cache = { ...res.data, at: Date.now() };
      }
      return this.cache;
    },

    paths() {
      return this.cache.files.map(function (f) { return f.vpath; });
    },

    dirs() {
      var set = { '/': true };
      this.cache.dirs.forEach(function (d) { set[d + '/'] = true; });
      this.cache.files.forEach(function (f) {
        set[f.vpath.slice(0, f.vpath.lastIndexOf('/') + 1)] = true;
      });
      return Object.keys(set).sort();
    },

    entry(vpath) {
      var lower = String(vpath || '').toLowerCase();
      return this.cache.files.find(function (f) { return f.vpath.toLowerCase() === lower; }) || null;
    },

    /**
     * Map the model's near-miss at a filename onto something that exists:
     * missing leading slash, wrong case, base name only, or an unambiguous
     * partial. Returned as-is when nothing matches, so the main process still
     * gets to produce the real ENOENT.
     */
    resolve(vpath) {
      var raw = String(vpath == null ? '' : vpath).trim().replace(/\\/g, '/');
      if (!raw) return raw;
      var withSlash = raw[0] === '/' ? raw : '/' + raw;
      var keys = this.paths();

      var hit = keys.find(function (k) { return k === withSlash; });
      if (hit) return hit;

      var lower = withSlash.toLowerCase();
      hit = keys.find(function (k) { return k.toLowerCase() === lower; });
      if (hit) return hit;

      var base = raw.split('/').pop().toLowerCase();
      hit = keys.find(function (k) { return k.split('/').pop().toLowerCase() === base; });
      if (hit) return hit;

      var stem = base.replace(/\.[^.]*$/, '');
      if (stem.length >= 3) {
        var near = keys.filter(function (k) {
          var kb = k.split('/').pop().toLowerCase();
          return kb.indexOf(stem) >= 0 || stem.indexOf(kb.replace(/\.[^.]*$/, '')) >= 0;
        });
        if (near.length === 1) return near[0];
      }
      return withSlash;
    },

    isUntrusted(vpath) {
      var e = this.entry(this.resolve(vpath));
      return !!(e && e.untrusted);
    }
  };

  /** Turn a failed IPC result into something the journal can explain. */
  function ipcFail(res, fallback) {
    var msg = (res && res.error) || fallback || '操作失敗';
    var e = new Error(msg);
    e.code = res && res.code;
    e.verdict = res && res.verdict;
    return e;
  }

  function T(key, zh, vars) { return AIOS.i18n ? AIOS.i18n.t(key, zh, vars) : zh; }

  function bytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB';
    return (n / 1024 / 1024).toFixed(1) + ' MiB';
  }
  AIOS.bytes = bytes;

  /* =======================================================================
     Long-term memory (the warm tier)
     ===================================================================== */

  /* Long-term memory now lives in the main process (app/main/memory.js): it
     is user-editable, records whether each item was typed or learned, and is
     deliberately empty on a fresh machine. Nothing is cached here, so the
     store cannot drift out of sync with what the memory manager shows. */

  /* =======================================================================
     Window manager
     ===================================================================== */

  AIOS.wm = (function () {
    var wins = [];
    var zTop = 10;
    var layer, desk;

    function init() {
      layer = document.getElementById('winlayer');
      desk = document.getElementById('desktop');
    }

    /**
     * Usable rectangle: the desktop minus whatever chrome is actually on
     * screen. Measured rather than hardcoded, because the intent bar grows when
     * the suggestion chips wrap onto another row.
     */
    function freeRect() {
      if (!desk) init();
      var r = desk.getBoundingClientRect();
      var left = 16, right = 16, top = 14;

      var visible = window.innerWidth > 1040;
      var hl = document.getElementById('hud-left');
      var hr = document.getElementById('hud-right');
      if (visible && hl && !hl.classList.contains('off')) left = hl.offsetWidth + 28;
      if (visible && hr && !hr.classList.contains('off')) right = hr.offsetWidth + 28;

      // Bottom edge = top of the intent bar, which sits above the dock.
      var bar = document.getElementById('intent-form');
      var bottom = 150;
      if (bar) {
        var br = bar.getBoundingClientRect();
        bottom = Math.max(90, r.bottom - br.top + 12);
      }

      return {
        x: left,
        y: top,
        w: Math.max(260, r.width - left - right),
        h: Math.max(180, r.height - top - bottom)
      };
    }

    /**
     * The rectangle a maximised window gets.
     *
     * Maximise used to stop at the top edge of the intent bar: on a 1336x793
     * window that left 138px of desktop below the app plus a 14-16px gutter on
     * every other side, and a maximised window that does not fill the screen is
     * just a big window. So while anything is maximised the desktop folds its
     * own furniture away (see `.maxed` in os.css) -- the suggestion chips go,
     * the dock waits just off the bottom edge until you reach for it, and the
     * intent bar becomes a full-width strip flush with the bottom. The bar
     * itself stays: it is how you talk to the machine, and a mode that takes it
     * away is a mode you have to leave to get anything done.
     *
     * What is still reserved is that strip, and any HUD rail the user has
     * deliberately opened -- covering those would hide something somebody asked
     * to see. Closing the rails is what makes it edge-to-edge horizontally, and
     * that stays their decision, not this function's.
     */
    function maxRect() {
      if (!desk) init();
      var r = desk.getBoundingClientRect();
      var left = 0, right = 0;

      var visible = window.innerWidth > 1040;
      var hl = document.getElementById('hud-left');
      var hr = document.getElementById('hud-right');
      if (visible && hl && !hl.classList.contains('off')) left = hl.offsetWidth + 12;
      if (visible && hr && !hr.classList.contains('off')) right = hr.offsetWidth + 12;

      /* Measured, not assumed: the strip is a different height once the chips
         are gone, and this runs after the fold. */
      var bar = document.getElementById('intent-form');
      var strip = bar ? Math.round(bar.getBoundingClientRect().height) : 46;

      return {
        x: left,
        y: 0,
        w: Math.max(260, r.width - left - right),
        h: Math.max(180, r.height - strip)
      };
    }

    /**
     * Fold the desktop furniture away, or bring it back.
     *
     * The state is one class on <body>, so it is CSS that does the folding:
     * there is nothing to persist, and the chip row the user chose for
     * themselves is never written to -- it comes back exactly as they left it.
     */
    function syncMaxed() {
      var any = wins.some(function (w) {
        return !w.minimized && w.el && w.el.classList.contains('max');
      });
      document.body.classList.toggle('maxed', any);
      /* The rails are furniture too, and they are most of the cost: a maximised
         window gets 50% of a 1336px desktop with both of them open and 94% with
         them folded. They come back the moment nothing is maximised, and the
         dock buttons still work while it is -- opening one then makes the window
         give that width back rather than sit on top of it. */
      if (AIOS.foldRails) AIOS.foldRails(any);
      return any;
    }

    /** Re-fit whatever is maximised: the viewport changed, or a rail opened. */
    function refitMax() {
      if (!syncMaxed()) return 0;
      var f = maxRect();
      var n = 0;
      wins.forEach(function (w) {
        if (w.minimized || !w.el.classList.contains('max')) return;
        w.el.style.left = f.x + 'px'; w.el.style.top = f.y + 'px';
        w.el.style.width = f.w + 'px'; w.el.style.height = f.h + 'px';
        n++;
      });
      return n;
    }

    function place(w, h) {
      var f = freeRect();
      w = Math.min(w, f.w); h = Math.min(h, f.h);
      var n = wins.filter(function (x) { return !x.minimized; }).length;
      var step = 26;
      var x = f.x + (n * step) % Math.max(1, f.w - w);
      var y = f.y + (n * step) % Math.max(1, f.h - h);
      return { x: x, y: y, w: w, h: h };
    }

    function focus(win) {
      wins.forEach(function (x) { x.el.classList.remove('focus'); });
      win.el.classList.add('focus');
      win.z = ++zTop;
      win.el.style.zIndex = win.z;
    }

    function open(spec) {
      init();
      if (spec.id) {
        var found = wins.find(function (x) { return x.id === spec.id; });
        if (found) {
          found.title = spec.title || found.title;
          found.el.querySelector('.win-title').textContent = found.title;
          var b = found.el.querySelector('.win-body');
          b.innerHTML = '';
          spec.render(b, found);
          if (found.minimized) restore(found);
          focus(found);
          return found;
        }
      }

      var rect = place(spec.w || 420, spec.h || 260);
      var win = {
        id: spec.id || ('w' + Date.now() + Math.floor(Math.random() * 1000)),
        kind: spec.kind || 'TEXT',
        title: spec.title || '未命名',
        minimized: false,
        prev: null,
        onClose: spec.onClose || null,
        // Asked before the window goes away; see close().
        confirmClose: spec.confirmClose || null
      };

      var node = el('div', 'win');
      node.style.left = rect.x + 'px';
      node.style.top = rect.y + 'px';
      node.style.width = rect.w + 'px';
      node.style.height = rect.h + 'px';
      node.setAttribute('role', 'dialog');
      node.setAttribute('aria-label', win.title);

      var bar = el('div', 'win-bar');
      bar.appendChild(el('span', 'win-kind', win.kind));
      bar.appendChild(el('span', 'win-title', win.title));

      // Application-supplied title bar controls, e.g. the AI chat toggle every
      // app gets. Added before the window buttons so close stays rightmost.
      (spec.barExtras || []).forEach(function (extra) {
        var b = el('button', 'win-btn' + (extra.className ? ' ' + extra.className : ''), extra.label);
        b.type = 'button';
        b.title = extra.title || '';
        b.setAttribute('aria-label', extra.title || extra.label);
        if (extra.pressed !== undefined) b.setAttribute('aria-pressed', extra.pressed ? 'true' : 'false');
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          extra.onClick(b, win);
        });
        bar.appendChild(b);
        win.barButtons = win.barButtons || {};
        if (extra.key) win.barButtons[extra.key] = b;
      });

      var btns = el('div', 'win-btns');
      var bMin = el('button', 'win-btn', '\u2013');
      bMin.type = 'button'; bMin.title = '縮到 Dock'; bMin.setAttribute('aria-label', '縮小 ' + win.title);
      var bMax = el('button', 'win-btn', '\u25a1');
      bMax.type = 'button'; bMax.title = '最大化'; bMax.setAttribute('aria-label', '最大化 ' + win.title);
      var bX = el('button', 'win-btn x', '\u2715');
      bX.type = 'button'; bX.title = '關閉'; bX.setAttribute('aria-label', '關閉 ' + win.title);
      btns.appendChild(bMin); btns.appendChild(bMax); btns.appendChild(bX);
      bar.appendChild(btns);

      var body = el('div', 'win-body');
      var grip = el('div', 'win-grip');
      grip.setAttribute('aria-hidden', 'true');

      node.appendChild(bar); node.appendChild(body); node.appendChild(grip);
      layer.appendChild(node);

      win.el = node;
      wins.push(win);
      spec.render(body, win);

      bMin.addEventListener('click', function (e) { e.stopPropagation(); minimize(win); });
      bMax.addEventListener('click', function (e) { e.stopPropagation(); toggleMax(win); });
      bX.addEventListener('click', function (e) { e.stopPropagation(); close(win); });
      node.addEventListener('pointerdown', function () { focus(win); });
      bar.addEventListener('dblclick', function () { toggleMax(win); });

      dragify(bar, win, 'move');
      dragify(grip, win, 'resize');

      focus(win);
      wallmark();
      if (AIOS.ui && AIOS.ui.syncDock) AIOS.ui.syncDock();
      return win;
    }

    /** Fade the desktop watermark out while windows are on screen. */
    function wallmark() {
      var wm = document.querySelector('.wallmark');
      if (wm) wm.style.opacity = wins.length ? '0.25' : '1';
    }

    function dragify(handle, win, mode) {
      var start = null;
      handle.addEventListener('pointerdown', function (e) {
        if (e.target.closest('.win-btn')) return;
        if (win.el.classList.contains('max') && mode === 'move') return;
        handle.setPointerCapture(e.pointerId);
        start = {
          px: e.clientX, py: e.clientY,
          x: win.el.offsetLeft, y: win.el.offsetTop,
          w: win.el.offsetWidth, h: win.el.offsetHeight
        };
        focus(win);
        e.preventDefault();
      });
      handle.addEventListener('pointermove', function (e) {
        if (!start) return;
        var dx = e.clientX - start.px, dy = e.clientY - start.py;
        var deskH = desk.getBoundingClientRect().height;
        if (mode === 'move') {
          win.el.style.left = Math.max(4, Math.min(start.x + dx, desk.offsetWidth - 80)) + 'px';
          win.el.style.top = Math.max(2, Math.min(start.y + dy, deskH - 40)) + 'px';
        } else {
          /* Once someone has chosen a size by hand, nothing else gets to change
             it. Generated apps measure their own content and ask for a fit (see
             fitWindow in apps/appshell.js); a program that keeps re-measuring must
             not fight the person who has already decided. */
          win.userSized = true;
          win.el.style.width = Math.max(240, Math.min(start.w + dx, desk.offsetWidth - win.el.offsetLeft - 6)) + 'px';
          win.el.style.height = Math.max(130, Math.min(start.h + dy, deskH - win.el.offsetTop - 6)) + 'px';
        }
      });
      function end(e) {
        if (!start) return;
        start = null;
        try { handle.releasePointerCapture(e.pointerId); } catch (err) {}
      }
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    }

    function toggleMax(win) {
      // Maximising is the user deciding on a size, same as dragging the handle.
      win.userSized = true;
      if (win.el.classList.contains('max')) {
        win.el.classList.remove('max');
        /* Unfold first, then restore: the furniture coming back is what the
           window is being sized against. */
        syncMaxed();
        if (win.prev) {
          win.el.style.left = win.prev.x + 'px'; win.el.style.top = win.prev.y + 'px';
          win.el.style.width = win.prev.w + 'px'; win.el.style.height = win.prev.h + 'px';
        }
      } else {
        win.prev = { x: win.el.offsetLeft, y: win.el.offsetTop, w: win.el.offsetWidth, h: win.el.offsetHeight };
        win.el.classList.add('max');
        /* Fold before measuring, in that order: the strip is only 46px tall
           once the chips have gone, and measuring first would leave a gap
           exactly the height of the row that is no longer there. */
        syncMaxed();
        var f = maxRect();
        win.el.style.left = f.x + 'px'; win.el.style.top = f.y + 'px';
        win.el.style.width = f.w + 'px'; win.el.style.height = f.h + 'px';
      }
    }

    function minimize(win) {
      win.minimized = true;
      win.el.hidden = true;
      /* Putting the only maximised window away has to give the desktop its
         furniture back, or the chips stay hidden with nothing on screen to
         explain why. */
      syncMaxed();
      if (AIOS.ui && AIOS.ui.syncDock) AIOS.ui.syncDock();
    }

    function restore(win) {
      win.minimized = false;
      win.el.hidden = false;
      focus(win);
      /* It may have been maximised when it was put away, and the viewport may
         have changed since. */
      refitMax();
      if (AIOS.ui && AIOS.ui.syncDock) AIOS.ui.syncDock();
    }

    function take(win) {
      if (win.onClose) { try { win.onClose(); } catch (e) {} }
      win.el.classList.add('closing');
      window.setTimeout(function () {
        if (win.el.parentNode) win.el.parentNode.removeChild(win.el);
        wins = wins.filter(function (x) { return x !== win; });
        syncMaxed();
        if (AIOS.ui && AIOS.ui.syncDock) AIOS.ui.syncDock();
        wallmark();
      }, 160);
    }

    /**
     * Close a window, giving it a chance to object first.
     *
     * A window may set `confirmClose`, an async predicate: closing waits for it
     * and stops if it says no. That is how a document with unsaved changes asks
     * before it is thrown away -- a machine that loses an hour of work to one
     * click on an X is not one anybody would trust with the next hour.
     *
     * `opts.force` skips the question, for the paths where the window is going
     * away because its file did.
     *
     * Returns a promise for whether the window went, so `closeAll` can ask one
     * window at a time. Callers that do not care may ignore it.
     */
    function close(win, opts) {
      if (!win) return Promise.resolve(false);
      if (!win.confirmClose || (opts && opts.force)) { take(win); return Promise.resolve(true); }
      // A second click on the X while the question is open must not stack another.
      if (win.asking) return Promise.resolve(false);
      win.asking = true;
      return Promise.resolve()
        .then(function () { return win.confirmClose(); })
        .then(function (ok) {
          win.asking = false;
          if (ok) take(win);
          return !!ok;
        }, function () {
          // A guard that throws must not trap the window open forever.
          win.asking = false;
          take(win);
          return true;
        });
    }

    function find(q) {
      q = String(q || '').toLowerCase().trim();
      if (!q) return null;
      return wins.find(function (w) { return w.id === q; }) ||
             wins.find(function (w) { return w.title.toLowerCase() === q; }) ||
             wins.find(function (w) { return w.title.toLowerCase().indexOf(q) >= 0; }) ||
             wins.find(function (w) { return w.kind.toLowerCase() === q; });
    }

    function tile() {
      init();
      var vis = wins.filter(function (w) { return !w.minimized; });
      if (!vis.length) return 0;
      /* Arranging is deciding these are not maximised more, so the
         desktop unfolds first -- measuring against folded furniture would lay
         the grid out against a bottom edge that is about to move. */
      vis.forEach(function (w) { w.el.classList.remove('max'); });
      syncMaxed();
      var f = freeRect();
      var cols = Math.ceil(Math.sqrt(vis.length));
      var rows = Math.ceil(vis.length / cols);
      var gap = 10;
      var w = Math.floor((f.w - gap * (cols - 1)) / cols);
      var h = Math.floor((f.h - gap * (rows - 1)) / rows);
      vis.forEach(function (win, i) {
        // An arranged window keeps its slot; a generated app must not shrink out
        // of the grid the user just asked for.
        win.userSized = true;
        win.el.style.left = (f.x + (i % cols) * (w + gap)) + 'px';
        win.el.style.top = (f.y + Math.floor(i / cols) * (h + gap)) + 'px';
        win.el.style.width = w + 'px';
        win.el.style.height = h + 'px';
      });
      return vis.length;
    }

    function stack() {
      init();
      var vis = wins.filter(function (w) { return !w.minimized; });
      /* Arranging is deciding these are not maximised more, so the
         desktop unfolds first -- measuring against folded furniture would lay
         the grid out against a bottom edge that is about to move. */
      vis.forEach(function (w) { w.el.classList.remove('max'); });
      syncMaxed();
      var f = freeRect();
      vis.forEach(function (win, i) {
        win.userSized = true;
        win.el.style.left = (f.x + i * 30) + 'px';
        win.el.style.top = (f.y + i * 30) + 'px';
        win.el.style.width = Math.min(520, f.w) + 'px';
        win.el.style.height = Math.min(330, f.h) + 'px';
      });
      return vis.length;
    }

    function focusLayout() {
      init();
      var vis = wins.filter(function (w) { return !w.minimized; });
      if (!vis.length) return 0;
      /* Arranging is deciding these are not maximised more, so the
         desktop unfolds first -- measuring against folded furniture would lay
         the grid out against a bottom edge that is about to move. */
      vis.forEach(function (w) { w.el.classList.remove('max'); });
      syncMaxed();
      var f = freeRect();
      var top = vis.reduce(function (a, b) { return (a.z || 0) > (b.z || 0) ? a : b; });
      top.el.style.left = f.x + 'px'; top.el.style.top = f.y + 'px';
      top.el.style.width = f.w + 'px'; top.el.style.height = f.h + 'px';
      vis.forEach(function (w) { if (w !== top) minimize(w); });
      focus(top);
      return vis.length;
    }

    /**
     * Close every window, forwarding `opts` to each one.
     *
     * `forEach(close)` was wrong twice over: it handed the array index in as
     * `opts`, and it fired every window's save question at the same moment.
     * Five dialogs arriving together is a pile nobody can answer, so the
     * unforced path asks one window at a time. Cancelling one does not stop the
     * others -- "close all" was still the instruction.
     */
    function closeAll(opts) {
      var queue = wins.slice();
      if (opts && opts.force) {
        queue.forEach(function (w) { close(w, opts); });
        return Promise.resolve();
      }
      return queue.reduce(function (p, w) {
        return p.then(function () { return close(w, opts); });
      }, Promise.resolve());
    }

    return {
      open: open, close: close, find: find, focus: focus,
      minimize: minimize, restore: restore, tile: tile, stack: stack,
      focusLayout: focusLayout, closeAll: closeAll, freeRect: freeRect,
      maxRect: maxRect, refitMax: refitMax, toggleMax: toggleMax,
      list: function () { return wins.slice(); },

      /* Highest window that is actually on screen. Minimised windows are
         excluded: a keyboard shortcut aimed at "the window in front" must not
         land on one the user cannot see. */
      topmost: function () {
        return wins.reduce(function (best, w) {
          if (w.minimized) return best;
          return !best || (w.z || 0) > (best.z || 0) ? w : best;
        }, null);
      }
    };
  })();

  /* =======================================================================
     Window renderers
     ===================================================================== */

  var render = {
    text: function (body, text) {
      String(text || '').split(/\n{2,}/).forEach(function (para) {
        body.appendChild(el('p', null, para));
      });
    },

    note: function (body, path, content, onEdit) {
      body.appendChild(el('div', 'note-path', path));
      var ta = el('textarea', 'note-area');
      ta.value = content || '';
      ta.setAttribute('aria-label', path + ' 內容');
      ta.addEventListener('input', function () { if (onEdit) onEdit(ta.value); });
      body.appendChild(ta);
    },

    /**
     * Real directory listing. Rows are clickable: files open, directories
     * navigate, so this is an actual file manager rather than a readout.
     */
    files: function (body, listing) {
      var head = el('div', 'fbar');
      head.appendChild(el('h3', null, listing.vpath));

      var up = el('button', 'fbtn', '\u2191 上一層');
      up.type = 'button';
      up.disabled = listing.vpath === '/';
      up.addEventListener('click', function () {
        var parent = listing.vpath.replace(/\/[^/]+$/, '') || '/';
        AIOS.run('fs.list', { dir: parent });
      });
      head.appendChild(up);

      var imp = el('button', 'fbtn', '\u2913 匯入…');
      imp.type = 'button';
      imp.title = '從作業系統複製檔案進沙箱（原檔不會被動到）';
      imp.addEventListener('click', function () { AIOS.userImport(listing.vpath); });
      head.appendChild(imp);

      var rev = el('button', 'fbtn', '\u29c9 在檔案總管開啟');
      rev.type = 'button';
      rev.addEventListener('click', function () { window.aios.user.reveal(); });
      head.appendChild(rev);

      body.appendChild(head);

      var ul = el('ul', 'flist');
      if (!listing.entries.length) ul.appendChild(el('li', 'frow', '（空目錄）'));

      listing.entries.forEach(function (ent) {
        var li = el('li', 'frow' + (ent.dir ? ' fdir' : ''));
        li.appendChild(el('span', 'fico', ent.dir ? '\u25b8' : '\u25a1'));

        var name = el('button', 'fnm', ent.name);
        name.type = 'button';
        name.title = ent.vpath;
        name.addEventListener('click', function () {
          AIOS.run(ent.dir ? 'fs.list' : 'fs.read', ent.dir ? { dir: ent.vpath } : { path: ent.vpath });
        });
        li.appendChild(name);

        if (ent.untrusted) li.appendChild(el('span', 'ftag', 'UNTRUSTED'));
        li.appendChild(el('span', 'fsz', ent.dir ? '' : bytes(ent.bytes)));
        ul.appendChild(li);
      });
      body.appendChild(ul);
    },

    fenced: function (body, path, content) {
      body.appendChild(el('h3', null, path + '  ·  不可信來源'));
      body.appendChild(el('pre', 'fenced', content));
      body.appendChild(el('p', 'fence-note',
        '核心已把這份內容標記為資料，不是命令。裡面的任何指示都不會取得授權。'));
    },

    timer: function (body, seconds, label, win) {
      var face = el('div', 'timer-face');
      var big = el('span', null, '');
      var small = el('small', null, label || '計時器');
      face.appendChild(big); face.appendChild(small);
      body.appendChild(face);

      var left = seconds;
      function paint() {
        var m = Math.floor(left / 60), s = left % 60;
        big.textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
      }
      paint();
      var iv = window.setInterval(function () {
        left--;
        if (left <= 0) {
          left = 0; paint();
          face.classList.add('done');
          small.textContent = (label || '計時器') + ' · 時間到';
          window.clearInterval(iv);
          log('timer 到期：' + (label || '計時器'), 't-ok');
          return;
        }
        paint();
      }, 1000);
      win.onClose = function () { window.clearInterval(iv); };
    },

    /**
     * The capability policy, as it will actually behave.
     *
     * This used to print the configured level only. Someone who had deliberately
     * set app.create to ALLOW saw ALLOW in the table and then got asked anyway,
     * because a downgrade overrides the policy while untrusted content has been
     * read this session -- and that was mentioned in a footnote under the table.
     * A panel whose job is to say what the machine will do has to say what the
     * machine will do.
     */
    policy: function (body) {
      var tainted = !!(AIOS.state.taint && AIOS.state.taint.tainted);
      var elevated = AIOS.ELEVATED || [];

      var t = el('table', 'policy-table');
      var head = el('tr');
      head.appendChild(el('th', null, '能力'));
      head.appendChild(el('th', null, '你設定的'));
      head.appendChild(el('th', null, '現在生效的'));
      t.appendChild(head);

      Object.keys(AIOS.state.policy).forEach(function (cap) {
        var set = String(AIOS.state.policy[cap]).toUpperCase();
        var downgraded = tainted && elevated.indexOf(cap) >= 0 && set === 'ALLOW';
        var live = downgraded ? 'ASK' : set;

        var tr = el('tr', downgraded ? 'policy-downgraded' : null);
        tr.appendChild(el('td', null, cap));
        tr.appendChild(el('td', null, set));
        var cell = el('td', null, live);
        if (downgraded) cell.appendChild(el('span', 'policy-why', '　← 已降級'));
        tr.appendChild(cell);
        t.appendChild(tr);
      });
      body.appendChild(t);

      if (tainted) {
        var src = (AIOS.state.taint.sources || []).map(function (s) { return s.vpath || s.source; });
        body.appendChild(el('p', 'fence-note',
          '這個工作階段讀過不可信內容（' + src.join('、') + '），所以 ' +
          elevated.join(' / ') + ' 的 ALLOW 暫時降級為 ASK。' +
          '要恢復就用桌面選單的「清除汙染標記」。'));
      } else {
        body.appendChild(el('p', 'fence-note',
          '目前沒有讀過不可信內容，所以設定值就是生效值。一旦讀了，' +
          elevated.join(' / ') + ' 的 ALLOW 會降級為 ASK。'));
      }
      body.appendChild(el('p', 'fence-note', '政策由主程序保管與執行，渲染層改不動。'));
    },

    /** The trash is what makes deletion reversible. Restoring is a user action. */
    trash: function (body, items) {
      body.appendChild(el('h3', null, '沙箱回收桶'));
      if (!items.length) {
        body.appendChild(el('p', null, '（空）刪除的檔案會先移到這裡，隨時可以還原。'));
        return;
      }
      var ul = el('ul', 'flist');
      items.forEach(function (it) {
        var li = el('li', 'frow');
        li.appendChild(el('span', 'fico', '\u267b'));
        li.appendChild(el('span', 'fnm', it.vpath));
        var undo = el('button', 'fbtn', '還原');
        undo.type = 'button';
        undo.addEventListener('click', async function () {
          undo.disabled = true;
          var res = await window.aios.fs.restore(it.id);
          if (res.ok) {
            log('restore: ' + res.data.vpath, 't-ok');
            await AIOS.afterFsChange();
            AIOS.openTrash();
          } else {
            log('restore 失敗：' + res.error, 't-err');
            undo.disabled = false;
          }
        });
        li.appendChild(undo);
        ul.appendChild(li);
      });
      body.appendChild(ul);

      var empty = el('button', 'fbtn fbtn-danger', '清空回收桶（不可復原）');
      empty.type = 'button';
      empty.addEventListener('click', async function () {
        var res = await window.aios.user.trashEmpty();
        if (res.ok && !res.data.canceled) {
          log('回收桶已清空（' + res.data.removed + ' 項）', 't-warn');
          AIOS.openTrash();
        }
      });
      body.appendChild(empty);
    }
  };

  AIOS.render = render;

  /* =======================================================================
     Sandbox glue
     ===================================================================== */

  /**
   * Open a file. Untrusted content gets a fenced, read-only view: offering an
   * editor for a file whose whole purpose is to look legitimate would be the
   * wrong affordance. Trusted files are editable, and saving is explicit so a
   * capability prompt does not fire on every keystroke.
   */
  function openFileWindow(vpath, content, untrusted) {
    var name = vpath.split('/').pop();
    return AIOS.wm.open({
      id: 'file:' + vpath,
      kind: untrusted ? 'DATA' : 'NOTE',
      title: name,
      w: 480, h: 320,
      render: function (b) {
        if (untrusted) { render.fenced(b, vpath, content); return; }

        var bar = el('div', 'fbar');
        bar.appendChild(el('div', 'note-path', vpath));
        var save = el('button', 'fbtn', '儲存');
        save.type = 'button';
        save.disabled = true;
        bar.appendChild(save);
        var state = el('span', 'note-state', '');
        bar.appendChild(state);
        b.appendChild(bar);

        var ta = el('textarea', 'note-area');
        ta.value = content || '';
        ta.setAttribute('aria-label', vpath + ' 內容');
        b.appendChild(ta);

        ta.addEventListener('input', function () {
          save.disabled = false;
          state.textContent = '未儲存';
        });

        async function commit() {
          save.disabled = true;
          state.textContent = '儲存中…';
          var res = await window.aios.fs.write(vpath, ta.value);
          if (res.ok) {
            state.textContent = '已儲存 ' + bytes(res.data.bytes);
            await AIOS.afterFsChange();
          } else {
            state.textContent = res.error || '儲存失敗';
            save.disabled = false;
          }
        }

        save.addEventListener('click', commit);
        ta.addEventListener('keydown', function (e) {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            if (!save.disabled) commit();
          }
        });
      }
    });
  }

  /* How many times the sandbox has been mutated this session.
     Every write in the machine calls afterFsChange when it is done -- that is
     already the convention, in thirty-odd places -- so counting here is the one
     honest answer to "did this round put anything on disk", without asking each
     application to report it and without a second list to keep in step. */
  AIOS.fsWrites = 0;

  /**
   * Refresh the cached view of the sandbox after anything mutates it.
   *
   * `external` is for a change this machine did not make -- a file dropped into
   * the directory from outside. It refreshes the same way but does not touch the
   * counter, because the counter answers "did this round write something", and a
   * file someone copied in mid-turn is not the round's doing.
   */
  /**
   * Size the resident-page budget to the model that is actually connected.
   *
   * The slider shipped with `max="32768"`, which was a sensible ceiling for a
   * local 8k model and is three per cent of what this machine is now connected
   * to. The user watched a 392-token page evicted 「超出預算」 with a million
   * tokens of room going spare, and asked for the ceiling raised and the
   * default set to the top of it.
   *
   * Raising it is cheap, and it is worth being clear why: the budget is a
   * ceiling on what may STAY resident, not an amount that gets sent. A turn
   * carries the pages that exist; an empty machine sends a few thousand tokens
   * whether the ceiling is eight thousand or eight hundred thousand. What the
   * ceiling decides is whether something already read has to be thrown away to
   * make room -- and throwing away something the user just read, while the
   * model could have held it, is the failure being fixed.
   *
   * The ceiling leaves the reply's worth of room plus a fifth for the parts of
   * a turn that are not resident pages: the system prompt, the syscall table,
   * the question itself. With no context window reported there is nothing to
   * scale to, so the old numbers stand -- a guess dressed as a measurement
   * would be worse than the honest small default.
   */
  AIOS.budgetCeiling = function (nCtx, maxOut) {
    var ctx = Number(nCtx) || 0;
    if (ctx <= 0) return 32768;
    var reply = Math.min(Number(maxOut) || 0, Math.round(ctx * 0.25)) || Math.round(ctx * 0.1);
    var room = Math.max(1024, ctx - reply);
    return Math.max(8192, Math.round(room * 0.8 / 256) * 256);
  };

  /**
   * Apply that ceiling to the slider and, unless the user has chosen otherwise,
   * to the budget itself.
   *
   * A budget saved by an older session is upgraded rather than honoured when it
   * is the number that shipped, or when it no longer fits the slider: those are
   * not choices, they are defaults from a machine that did not know how big the
   * model was.
   */
  AIOS.fitBudget = function (opts) {
    var S = AIOS.state;
    var top = AIOS.budgetCeiling(S.nCtx, S.maxOut);
    var slider = document.getElementById('budget-slider');
    var out = document.getElementById('budget-out');
    if (!slider) return top;

    /* Anything at or below the ceiling this slider used to have was chosen on a
       slider that could not go higher, so it is not evidence that a small budget
       was wanted -- it is the old maximum, or the old default, wearing the same
       clothes. Those are raised once. A number picked on the new slider is a
       real preference and is left alone. */
    var OLD_CEILING = 32768;
    var wasDefault = !S.budget || S.budget <= OLD_CEILING || S.budget > top;

    /* The maximum has to be a value the slider can actually stop on. With a min
       of 640 and a step that does not divide the span, the browser snaps the
       thumb short of the end and 「最大」 is a number the control cannot reach --
       off by a step and impossible to explain. */
    var low = Math.min(640, top);
    var step = Math.max(256, Math.round(top / 400 / 256) * 256);
    top = low + Math.floor((top - low) / step) * step;

    slider.max = String(top);
    slider.min = String(low);
    slider.step = String(step);
    if (wasDefault || (opts && opts.force)) S.budget = top;
    slider.value = String(S.budget);
    if (out) out.value = S.budget;

    var note = document.querySelector('.hp-note');
    if (note) {
      note.textContent = S.nCtx
        ? '上限跟著模型走：' + Number(S.nCtx).toLocaleString() +
          ' 的 context，常駐預算最多 ' + top.toLocaleString() + '。' +
          '預算是「可以留多少」，不是「每次送多少」——調高不會讓平常的請求變大，' +
          '只會讓已經讀進來的東西不用被丟掉。'
        : '把預算調低，看核心驅逐分頁 — 模型會當場忘記東西。';
    }
    if (AIOS.ui && AIOS.ui.renderContext) AIOS.ui.renderContext(AIOS.kernel.schedule());
    return top;
  };

  AIOS.afterFsChange = async function (opts) {
    if (!(opts && opts.external)) AIOS.fsWrites++;
    await AIOS.fs.refresh();
    var u = await window.aios.fs.usage();
    if (u && u.ok) AIOS.state.fsUsage = u.data;
    if (AIOS.ui && AIOS.ui.renderSandbox) AIOS.ui.renderSandbox();

    /* Keep any open file browser honest about what is on disk now, by asking it
       to redraw itself.

       This used to empty the window body and re-run `render.files`, the flat
       single-pane renderer from before the file manager was an application.
       That renderer knows nothing about the tree pane, the toolbar or the
       search box, so every refresh replaced a working file manager with a bare
       list -- and once the sandbox watcher started firing on every change, that
       happened constantly and the window looked corrupted. An application
       redraws itself; nothing outside it should be drawing into its body. */
    await Promise.all(AIOS.apps.instances()
      .filter(function (i) { return i.def.id === 'files'; })
      .map(function (i) {
        var api = i.ctx && i.ctx.api;
        if (!api || typeof api.refresh !== 'function') return null;
        return Promise.resolve(api.refresh()).catch(function () { /* window is going away */ });
      })
      .filter(Boolean));
  };

  /**
   * Import from the real operating system. This is a user gesture: the file
   * chooser is opened by the main process, the source is copied rather than
   * moved, and the model has no way to reach this path.
   */
  AIOS.userImport = async function (into, opts) {
    var res = await window.aios.user.import(into || '/inbox');
    if (!res.ok) { log('匯入失敗：' + res.error, 't-err'); return null; }
    if (res.data.canceled) return null;

    var d = res.data;
    d.imported.forEach(function (f) {
      log('import: ' + f.from + ' → ' + f.vpath + '（' + bytes(f.bytes) + '，標記為不可信）', 't-taint');
    });
    d.skipped.forEach(function (s) { log('skip: ' + s.src + ' — ' + s.why, 't-warn'); });
    await AIOS.afterFsChange();
    if (AIOS.ui && AIOS.ui.renderSandbox) AIOS.ui.renderSandbox();
    // `quiet` is for callers that already have somewhere to show the result --
    // a file picker, say, where opening the file manager on top of it would
    // bury the dialog the user is still standing in.
    if (d.imported.length && !(opts && opts.quiet)) {
      await AIOS.run('fs.list', { dir: into || '/inbox' });
    }
    return d;
  };

  AIOS.openTrash = async function () {
    var res = await window.aios.fs.trashList();
    var items = res.ok ? res.data : [];
    AIOS.wm.open({
      id: 'trash', kind: 'TRASH', title: '回收桶', w: 440, h: 280,
      render: function (b) { render.trash(b, items); }
    });
  };

  /* =======================================================================
     Shared window furniture: context menus, text prompts, confirmations
     ---------------------------------------------------------------------
     These grew up inside the file manager and are hoisted here because every
     application needs them and none of them should reimplement the same
     scrim, the same keyboard handling, or the same focus juggling.

     They are not the browser's dialogs. window.prompt and window.confirm are
     disabled in this renderer, and a native dialog would look like it came
     from somewhere else -- which matters on a machine where a modal window is
     also how the capability gate asks for authority. Anything that looks like
     an OS prompt but is drawn by the renderer would blur that line, so these
     are visibly window furniture: scoped inside the window that raised them,
     never covering the whole screen.

     Only one is on screen at a time, per host element. Stacking them is how a
     user ends up answering the wrong question.
     ===================================================================== */

  /* =======================================================================
     Overlays, and the one surface that paints above them
     ---------------------------------------------------------------------
     A menu or a popover is renderer DOM inside a window. A browser page is
     not: it is a native WebContentsView positioned over the same rectangle,
     and it paints above everything this document draws. So a menu opened from
     the browser's toolbar drops down *underneath* the page and is invisible.

     Rather than teach every caller about native views, opening one of these
     announces itself here and the browser window listens: while an overlay is
     up in its window, it detaches its page. The count is per host element, so
     a menu in the file manager does not blank a page in another window.
     ===================================================================== */

  AIOS.overlay = (function () {
    var hosts = new Map();      // host element -> open count
    var subs = [];

    function fire() {
      subs.forEach(function (fn) { try { fn(); } catch (e) { /* never block a menu */ } });
    }

    return {
      up: function (host) {
        if (!host) return;
        hosts.set(host, (hosts.get(host) || 0) + 1);
        fire();
      },
      down: function (host) {
        if (!host) return;
        var n = (hosts.get(host) || 0) - 1;
        if (n > 0) hosts.set(host, n); else hosts.delete(host);
        fire();
      },
      /** Is anything open inside `el`? Asked by whoever owns a native view. */
      activeIn: function (el) {
        if (!el) return false;
        var hit = false;
        hosts.forEach(function (_n, host) {
          if (hit) return;
          if (host === el || el.contains(host) || host.contains(el)) hit = true;
        });
        return hit;
      },
      /** Returns an unsubscribe: a closed window must stop being called. */
      onChange: function (fn) {
        if (typeof fn !== 'function') return function () {};
        subs.push(fn);
        return function () {
          var at = subs.indexOf(fn);
          if (at >= 0) subs.splice(at, 1);
        };
      }
    };
  })();

  AIOS.menu = (function () {
    var openScrim = null;
    var openHost = null;

    function close() {
      if (openScrim) { openScrim.remove(); openScrim = null; }
      if (openHost) { AIOS.overlay.down(openHost); openHost = null; }
    }

    /**
     * Show a context menu at viewport coordinates (x, y), clamped inside host.
     *
     * items: an array of
     *   { label, run, disabled, danger }   an entry
     *   { sep: true }                      a divider
     *   null / undefined / false           skipped, so callers can inline
     *                                      conditionals without filtering
     */
    function open(host, x, y, items) {
      close();
      var live = (items || []).filter(Boolean);
      if (!live.length) return null;

      var scrim = el('div', 'ui-menu-scrim');
      var m = el('div', 'ui-menu');
      scrim.appendChild(m);

      live.forEach(function (it) {
        if (it.sep) { m.appendChild(el('div', 'ui-menu-sep')); return; }
        var b = el('button', 'ui-menu-item' + (it.danger ? ' ui-menu-danger' : ''), it.label);
        b.type = 'button';
        if (it.hint) {
          var k = el('span', 'ui-menu-hint', it.hint);
          b.appendChild(k);
        }
        if (it.disabled) {
          b.disabled = true;
        } else {
          b.addEventListener('click', function () {
            close();
            try { it.run(); } catch (e) { log('menu ' + it.label + ' — ' + (e.message || e), 't-err'); }
          });
        }
        m.appendChild(b);
      });

      host.appendChild(scrim);

      // Measure, then place. Guessing the size gets menus clipped by the
      // window edge as soon as an app adds a longer label.
      var hr = host.getBoundingClientRect();
      var mr = m.getBoundingClientRect();
      var left = x - hr.left;
      var top = y - hr.top;
      if (left + mr.width > hr.width - 4) left = Math.max(4, hr.width - mr.width - 4);
      if (top + mr.height > hr.height - 4) top = Math.max(4, hr.height - mr.height - 4);
      m.style.left = Math.max(4, left) + 'px';
      m.style.top = Math.max(4, top) + 'px';

      scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) close(); });
      scrim.addEventListener('contextmenu', function (e) { e.preventDefault(); close(); });
      openScrim = scrim;
      openHost = host;
      AIOS.overlay.up(host);

      var first = m.querySelector('.ui-menu-item:not([disabled])');
      if (first) first.focus();
      return scrim;
    }

    // Escape closes whatever is open, from anywhere.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && openScrim) { e.preventDefault(); close(); }
    });

    return { open: open, close: close };
  })();

  /* =======================================================================
     Popovers
     ---------------------------------------------------------------------
     A panel anchored under the button that opened it, living inside one
     window rather than on the desktop.

     Shared because the deck, the spreadsheet and the word processor all want
     one, and a popover that is 236px in one program and 260px in the next,
     or that closes on a click outside in one and not the other, is three
     programs that were written by three people. Only one can be open per
     host, which is the behaviour a person expects from a toolbar.
     ===================================================================== */

  AIOS.popover = function (host, anchor, build, cls) {
    AIOS.popover.close(host);

    var scrim = el('div', 'ui-pop-scrim');
    var panel = el('div', 'ui-pop' + (cls ? ' ' + cls : ''));
    var api = { el: panel, close: function () { close(); } };

    var counted = false;
    function close() {
      if (host.__aiosPop === api) delete host.__aiosPop;
      if (scrim.parentNode) scrim.remove();
      if (counted) { counted = false; AIOS.overlay.down(host); }
    }

    build(panel, close);
    scrim.appendChild(panel);
    // Only a click on the scrim itself: one that landed on the panel is a click
    // on a control inside it.
    scrim.addEventListener('mousedown', function (e) {
      if (e.target === scrim) close();
    });
    host.appendChild(scrim);
    host.__aiosPop = api;
    counted = true;
    AIOS.overlay.up(host);

    /* Placed after insertion, because offsetWidth/Height are what keep the panel
       inside the window and a detached element reports zero for both. */
    var a = anchor.getBoundingClientRect();
    var box = host.getBoundingClientRect();

    /* Clamped to the window in pixels rather than left to the stylesheet's
       percentage. The percentage is measured against the containing block, and a
       panel with more controls than the window is tall then hangs out of the
       bottom of it -- which is what the border toolbox did, being the tallest
       panel here by some way. It scrolls instead. */
    panel.style.maxHeight = Math.max(120, box.height - 12) + 'px';

    var left = Math.max(6, Math.min(a.left - box.left, box.width - panel.offsetWidth - 6));
    // Below the button, flipped above it when there is no room, and pinned to the
    // top when there is no room either way.
    var top = a.bottom - box.top + 4;
    if (top + panel.offsetHeight > box.height - 6) {
      var above = a.top - box.top - panel.offsetHeight - 4;
      top = above >= 6 ? above : Math.max(6, box.height - panel.offsetHeight - 6);
    }
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    return api;
  };

  /* =======================================================================
     Picking a range of table cells
     ---------------------------------------------------------------------
     Press and drag across the cells of a table to select a rectangle of them,
     the way a spreadsheet does. Used by the table in a document and the table
     object on a slide, whose cells are contentEditable -- the spreadsheet has
     its own because its cells are not.

     The distinction is drag versus click, not one gesture instead of the other:

       press and release on one cell   -> the caret goes there, as before
       press and drag inside one cell  -> the browser selects text, as before
       press and drag across cells     -> a cell range

     So typing into a table still works the way anybody would expect, and the
     range selection that merging and borders need is finally reachable with the
     mouse. Shift+click still sets the far corner, for the same range without a
     drag.

     The default is deliberately not prevented on the initial press: doing so is
     what would take the caret away. It is prevented only once the pointer has
     left the cell it started in, and at that moment the browser's own text
     selection is thrown away and the table is marked unselectable -- otherwise
     dragging across contentEditable cells selects their text instead, which is
     exactly what used to happen.

     The anchor lives here rather than in the caller. Deriving it from the current
     range is what the two applications were doing, and it drifts: once the range
     has grown over a merged region its first corner is no longer where the finger
     went down, so dragging back the other way cannot shrink it again.
     ===================================================================== */

  AIOS.cellPicker = function (table, opts) {
    var o = opts || {};
    var anchor = null;                       // { c, r }, kept between gestures
    var dragging = false;
    var pressed = false;

    function cellAt(x, y) {
      var node = document.elementFromPoint(x, y);
      var td = node && node.closest ? node.closest('[data-r][data-c]') : null;
      if (!td || !table.contains(td)) return null;
      return { c: Number(td.dataset.c), r: Number(td.dataset.r), el: td };
    }

    function emit(to, how) {
      if (!anchor || !to) return;
      o.onSelect({
        c0: Math.min(anchor.c, to.c), c1: Math.max(anchor.c, to.c),
        r0: Math.min(anchor.r, to.r), r1: Math.max(anchor.r, to.r)
      }, how);
    }

    function stopText() {
      table.classList.add('ui-picking');
      var s = window.getSelection();
      if (s) s.removeAllRanges();
      // A caret left inside the range would keep typing into one cell while the
      // range says several are chosen.
      if (table.contains(document.activeElement)) document.activeElement.blur();
    }

    /* Pressing on text that is already selected and dragging it is a native
       drag-and-drop in Chromium, not a selection -- and starting one fires
       pointercancel, which used to abandon the pick before it began. A table's
       cells have nothing to gain from dragging their text out of them, so the
       whole gesture is refused here. */
    table.addEventListener('dragstart', function (e) { e.preventDefault(); });

    function onMove(e) {
      if (!pressed || !anchor) return;
      var to = cellAt(e.clientX, e.clientY);
      if (!to) return;
      if (!dragging && to.c === anchor.c && to.r === anchor.r) return;
      if (!dragging) { dragging = true; }
      stopText();
      e.preventDefault();
      emit(to, { dragging: true });
    }

    function onUp() {
      pressed = false;
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      table.classList.remove('ui-picking');
      if (dragging && o.onDone) o.onDone();
      dragging = false;
    }

    /* Captured, not bubbled. A slide's editable cell stops pointerdown from
       propagating -- that is how a click in the text of a selected object avoids
       starting a drag of the object -- so a listener on the table would never see
       the press at all. */
    table.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var hit = cellAt(e.clientX, e.clientY);
      if (!hit) return;

      if (e.shiftKey && anchor) {
        // The far corner of a range, without a drag. No caret here: the point is
        // the range, and the browser would otherwise select text across the cells.
        e.preventDefault();
        e.stopPropagation();
        stopText();
        emit(hit, { shift: true });
        table.classList.remove('ui-picking');
        return;
      }

      anchor = { c: hit.c, r: hit.r };
      pressed = true;
      dragging = false;
      emit(hit, {});
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
    }, true);

    return {
      /** Where the next Shift+click or drag measures from. */
      anchor: function () { return anchor; },
      setAnchor: function (c, r) { anchor = { c: c, r: r }; },
      dragging: function () { return dragging; }
    };
  };

  /** Close the popover open in `host`, if any. Safe to call blind. */
  AIOS.popover.close = function (host) {
    if (host && host.__aiosPop) host.__aiosPop.close();
  };

  /** A small caps heading inside a popover. */
  AIOS.popover.label = function (panel, text) {
    panel.appendChild(el('div', 'ui-pop-label', text));
    return panel;
  };

  /**
   * Single-field text prompt. Resolves with the trimmed string, or null when
   * the user backs out -- callers must treat null as "do nothing", never as an
   * empty value.
   */
  AIOS.prompt = function (opts) {
    var o = opts || {};
    var host = o.host || document.getElementById('desktop');
    return new Promise(function (resolve) {
      AIOS.menu.close();
      var scrim = el('div', 'ui-menu-scrim');
      var box = el('form', 'ui-prompt');

      box.appendChild(el('label', 'ui-prompt-label', o.label || ''));
      if (o.note) box.appendChild(el('p', 'ui-prompt-note', o.note));

      var inp = el('input', 'ui-prompt-input');
      inp.value = o.value == null ? '' : String(o.value);
      inp.placeholder = o.placeholder || '';
      inp.setAttribute('aria-label', o.label || T('prompt.input', '輸入'));
      box.appendChild(inp);

      var row = el('div', 'ui-prompt-row');
      var cancel = el('button', 'fbtn', o.cancelLabel || T('cancel', '取消'));
      cancel.type = 'button';
      var ok = el('button', 'fbtn fbtn-primary', o.okLabel || T('ok', '確定'));
      ok.type = 'submit';
      row.appendChild(cancel);
      row.appendChild(ok);
      box.appendChild(row);

      scrim.appendChild(box);
      host.appendChild(scrim);

      // Select the stem, not the extension: renaming "report.docx" almost
      // always means changing "report".
      inp.focus();
      var dot = inp.value.lastIndexOf('.');
      if (o.selectStem !== false && dot > 0) inp.setSelectionRange(0, dot);
      else inp.select();

      /* A dialog is an overlay too: a native browser view paints above
         everything this document draws, so a prompt inside the browser
         window would be answered blind. The window that owns the view
         detaches it while this is up. */
      AIOS.overlay.up(host);
      function done(v) { scrim.remove(); AIOS.overlay.down(host); resolve(v); }
      box.addEventListener('submit', function (e) {
        e.preventDefault();
        var v = inp.value.trim();
        done(v || null);
      });
      cancel.addEventListener('click', function () { done(null); });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
      });
      scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) done(null); });
    });
  };

  /** Yes/no confirmation. Resolves true only on an explicit confirm. */
  AIOS.confirm = function (opts) {
    var o = opts || {};
    var host = o.host || document.getElementById('desktop');
    return new Promise(function (resolve) {
      AIOS.menu.close();
      var scrim = el('div', 'ui-menu-scrim');
      var box = el('div', 'ui-prompt');
      box.appendChild(el('label', 'ui-prompt-label', o.label || T('confirm.continue', '確定要繼續？')));
      if (o.note) box.appendChild(el('p', 'ui-prompt-note', o.note));

      var row = el('div', 'ui-prompt-row');
      var cancel = el('button', 'fbtn', o.cancelLabel || T('cancel', '取消'));
      cancel.type = 'button';
      var ok = el('button', 'fbtn ' + (o.danger ? 'fbtn-danger' : 'fbtn-primary'), o.okLabel || T('ok', '確定'));
      ok.type = 'button';
      row.appendChild(cancel);
      row.appendChild(ok);
      box.appendChild(row);
      scrim.appendChild(box);
      host.appendChild(scrim);
      cancel.focus();

      /* A dialog is an overlay too: a native browser view paints above
         everything this document draws, so a prompt inside the browser
         window would be answered blind. The window that owns the view
         detaches it while this is up. */
      AIOS.overlay.up(host);
      function done(v) { scrim.remove(); AIOS.overlay.down(host); resolve(v); }
      ok.addEventListener('click', function () { done(true); });
      cancel.addEventListener('click', function () { done(false); });
      box.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      });
      scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) done(false); });
    });
  };

  /**
   * Save, discard, or don't close. Resolves 'save' | 'discard' | 'cancel'.
   *
   * Three buttons rather than two, because there are three things that can
   * happen and folding them into a yes/no makes one of them unreachable: a
   * confirm that says "close without saving?" gives no way to save, and one that
   * says "save first?" gives no way to abandon a change on purpose.
   *
   * Escape and clicking away both mean cancel -- the answer that changes nothing
   * is the safe default for a question raised by an accidental click on a close
   * button.
   */
  AIOS.confirmSave = function (opts) {
    var o = opts || {};
    var host = o.host || document.getElementById('desktop');
    return new Promise(function (resolve) {
      AIOS.menu.close();
      var scrim = el('div', 'ui-menu-scrim');
      var box = el('div', 'ui-prompt');
      box.appendChild(el('label', 'ui-prompt-label', o.label || T('confirm.unsaved', '有未儲存的變更')));
      if (o.note) box.appendChild(el('p', 'ui-prompt-note', o.note));

      var row = el('div', 'ui-prompt-row');
      var discard = el('button', 'fbtn fbtn-danger', o.discardLabel || T('discard', '不儲存'));
      discard.type = 'button';
      var cancel = el('button', 'fbtn', T('cancel', '取消'));
      cancel.type = 'button';
      var save = el('button', 'fbtn fbtn-primary', o.saveLabel || T('save', '儲存'));
      save.type = 'button';
      // Discard on the left, away from the button the hand goes to.
      row.appendChild(discard);
      row.appendChild(el('span', 'ui-prompt-gap'));
      row.appendChild(cancel);
      row.appendChild(save);
      box.appendChild(row);
      scrim.appendChild(box);
      host.appendChild(scrim);
      save.focus();

      /* A dialog is an overlay too: a native browser view paints above
         everything this document draws, so a prompt inside the browser
         window would be answered blind. The window that owns the view
         detaches it while this is up. */
      AIOS.overlay.up(host);
      function done(v) { scrim.remove(); AIOS.overlay.down(host); resolve(v); }
      save.addEventListener('click', function () { done('save'); });
      discard.addEventListener('click', function () { done('discard'); });
      cancel.addEventListener('click', function () { done('cancel'); });
      box.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done('cancel'); }
      });
      scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) done('cancel'); });
    });
  };

  /* =======================================================================
     Typefaces
     ---------------------------------------------------------------------
     One list, shared by every document application, because a font chosen in
     the word processor and the same font chosen in the spreadsheet have to mean
     the same string -- that string is what gets written into the OOXML.

     Only families verified present on this machine are listed. Offering a font
     that is not installed produces the worst kind of bug: the picker says one
     thing, the screen silently substitutes another, and the exported file names
     a typeface the recipient may not have either. `custom` exists for naming a
     family deliberately, with the caveat visible.

     CJK families are listed under their localised names because that is what
     Windows and Word both call them; a document that says "PMingLiU" and one
     that says the localised name are not interchangeable in Word's UI.
     ===================================================================== */

  /* ######################################################### printing #### */

  /**
   * Assemble a print-ready document and hand it to Chromium's print engine.
   *
   * Shared because four applications need the same thing and the interesting part
   * is identical for all of them: paged layout, a light palette, and rules that
   * keep a heading from being orphaned at the foot of a page.
   *
   * PRINT IS LIGHT, ALWAYS
   *
   * The shell is dark. A PDF is not: it gets printed, attached to mail and read
   * on other people's machines, and a dark page there is a wall of ink and
   * unreadable in a paper printout. So the print stylesheet sets its own colours
   * rather than inheriting the theme, and every app's content is placed inside it.
   *
   * The content arrives as serialised DOM -- already-parsed nodes the apps built
   * with createElement and createTextNode -- and is served to an offscreen window
   * under script-src 'none'. It is measured, never executed.
   */
  AIOS.printing = {
    /** Page geometry and the rules that stop things being cut in half. */
    baseCss: function (opts) {
      var o = opts || {};
      var size = o.pageSize || 'A4';
      var margin = o.margin || '16mm';
      return [
        '@page { size: ' + size + (o.landscape ? ' landscape' : '') + '; margin: ' + margin + '; }',
        'html, body { margin: 0; padding: 0; background: #fff; color: #16202c; }',
        'body { font-family: ' + AIOS.fonts.cssFor(o.font || '微軟正黑體').replace(/"/g, "'") +
          ', "Noto Sans TC", system-ui, sans-serif;',
        '  font-size: ' + (o.size ? o.size + 'pt' : '11pt') + '; line-height: 1.6;',
        '  -webkit-print-color-adjust: exact; print-color-adjust: exact; }',
        // A heading alone at the bottom of a page, or a table row split across
        // two, is the usual way a generated PDF looks careless.
        'h1, h2, h3, h4, h5, h6 { color: #0f1720; break-after: avoid; page-break-after: avoid; }',
        'h1 { font-size: 1.9em; margin: 0 0 .5em; }',
        'h2 { font-size: 1.5em; margin: 1.2em 0 .4em; }',
        'h3 { font-size: 1.25em; margin: 1em 0 .35em; }',
        'h4 { font-size: 1.1em; margin: 1em 0 .3em; }',
        'p, li { orphans: 2; widows: 2; }',
        'p { margin: 0 0 .7em; }',
        'ul, ol { padding-left: 1.4em; margin: .5em 0; }',
        'li { margin: .25em 0; }',
        'blockquote { margin: .8em 0; padding: .1em 0 .1em 1em;',
        '  border-left: 3px solid #c7d2de; color: #45566a; }',
        'pre, code { font-family: Consolas, "Courier New", monospace; font-size: .92em; }',
        'pre { background: #f4f6f9; border: 1px solid #dde4ec; border-radius: 4px;',
        '  padding: .7em .9em; white-space: pre-wrap; word-break: break-word;',
        '  break-inside: avoid; page-break-inside: avoid; }',
        'code { background: #f4f6f9; padding: .1em .3em; border-radius: 3px; }',
        'table { border-collapse: collapse; width: 100%; margin: .8em 0; }',
        'th, td { border: 1px solid #c7d2de; padding: 4px 7px; text-align: left;',
        '  vertical-align: top; }',
        'th { background: #eef2f7; font-weight: 600; }',
        'tr { break-inside: avoid; page-break-inside: avoid; }',
        // Repeat the header row when a table runs over a page boundary.
        'thead { display: table-header-group; }',
        'img { max-width: 100%; height: auto; break-inside: avoid; }',
        /* A picture standing alone in its paragraph is an illustration, and an
           illustration is centred and given room. The height cap is the page:
           without it a tall picture is scaled to the column width, runs past
           the bottom margin and is cut in half, because `max-width` alone says
           nothing about how far down the page the result reaches. */
        'p > img:only-child { display: block; margin: .9em auto; max-height: 21cm; }',
        /* An inline picture -- one sitting in a sentence -- is an icon or a
           formula, and must not push the line apart. */
        'p > img { vertical-align: middle; }',
        'hr { border: 0; border-top: 1px solid #c7d2de; margin: 1.4em 0; }',
        'a { color: #0b5fa4; text-decoration: none; }',
        // Where a picture was. See printing.blocksHtml: the print document is
        // not allowed to fetch one, so it says so rather than leaving a gap.
        '.pr-img { color: #6b7a8c; font-size: .92em; }',
        '.pr-sub { color: #55636f; font-size: .95em; margin: -.2em 0 1.4em; }',
        '.pr-page-break { break-after: page; page-break-after: always; }'
      ].join('\n');
    },

    /**
     * Wrap content in a complete document.
     *
     * `bodyHtml` is serialised DOM from an application. No script tag is emitted
     * and none would run: the offscreen window has javascript disabled and the
     * response carries script-src 'none'.
     */
    document: function (opts) {
      var o = opts || {};
      var esc = function (s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      };
      return [
        '<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">',
        '<title>' + esc(o.title || '文件') + '</title>',
        '<style>',
        AIOS.printing.baseCss(o),
        o.css || '',
        '</style></head><body>',
        o.bodyHtml || '',
        '</body></html>'
      ].join('\n');
    },

    /* ------------------------------------------------------- overlays --

       A page-sized transparent sheet, to be laid over a page of an existing
       PDF. Deliberately not built on baseCss/document above: those paint a
       white A4 page with margins and a document stylesheet, and every one of
       those is wrong here. An overlay is furniture -- it must be exactly the
       size of the page it will sit on, have no margin, and be transparent
       everywhere it is not drawing, or it would hide the page underneath.

       Everything is positioned in points from the top-left of the page as the
       reader sees it, because that is the only coordinate system a person can
       point at. PDF's own origin is the bottom-left and its y grows upward;
       the flip happens here, once, rather than at every call site.
       ------------------------------------------------------------------ */

    /** Geometry for a sheet exactly `w` x `h` points, and nothing else. */
    overlayCss: function (opts) {
      var o = opts || {};
      var w = Number(o.width) || 595.28;
      var h = Number(o.height) || 841.89;
      return [
        '@page { size: ' + w + 'pt ' + h + 'pt; margin: 0; }',
        'html, body { margin: 0; padding: 0; background: transparent;',
        '  width: ' + w + 'pt; height: ' + h + 'pt; overflow: hidden; }',
        '.ov { position: absolute; box-sizing: border-box; }',
        /* Print-colour-adjust so a highlight is not helpfully removed by the
           engine's own idea of what saves ink. */
        '.ov-text { white-space: pre-wrap; word-break: break-word;',
        '  -webkit-print-color-adjust: exact; print-color-adjust: exact; }',
        /* Multiply rather than opacity: the words underneath stay black and
           readable instead of being washed out along with the background. */
        '.ov-mark { mix-blend-mode: multiply; -webkit-print-color-adjust: exact;',
        '  print-color-adjust: exact; }'
      ].join('\n');
    },

    /**
     * One overlay sheet, as a complete document.
     *
     * `marks` is what to draw: `{kind: 'text'|'mark', x, y, w, h, text, size,
     * colour, font}`, all in points from the top-left. Nothing here runs -- the
     * offscreen window has scripting off and the response carries
     * `script-src 'none'` -- so this is measured, never executed.
     */
    overlay: function (opts) {
      var o = opts || {};
      var w = Number(o.width) || 595.28;
      var h = Number(o.height) || 841.89;
      var esc = function (s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      };

      var body = (o.marks || []).map(function (m) {
        var x = Math.max(0, Number(m.x) || 0);
        var y = Math.max(0, Number(m.y) || 0);
        var style = 'left:' + x + 'pt; top:' + y + 'pt;';

        if (m.kind === 'mark') {
          return '<div class="ov ov-mark" style="' + style +
            'width:' + (Number(m.w) || 0) + 'pt; height:' + (Number(m.h) || 0) + 'pt;' +
            'background:' + esc(m.colour || '#ffe14d') + ';"></div>';
        }

        var size = Number(m.size) || 12;
        /* A width is optional: without one the box is as wide as it needs to be
           up to the page edge, which is what a short note wants. */
        var width = Number(m.w) > 0 ? Number(m.w) : (w - x);
        return '<div class="ov ov-text" style="' + style +
          'width:' + width + 'pt;' +
          'font-family:' + AIOS.fonts.cssFor(m.font || '微軟正黑體').replace(/"/g, "'") +
          ', "Noto Sans TC", sans-serif;' +
          'font-size:' + size + 'pt; line-height:' + (Number(m.leading) || 1.35) + ';' +
          'color:' + esc(m.colour || '#111111') + ';">' +
          esc(m.text) + '</div>';
      }).join('\n');

      return [
        '<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">',
        '<title>overlay</title><style>',
        AIOS.printing.overlayCss({ width: w, height: h }),
        '</style></head><body>',
        body,
        '</body></html>'
      ].join('\n');
    },

    /**
     * A block list, as print-ready HTML.
     *
     * The same block list `office.writeDocx` takes, so a document exported to
     * Word and the same document exported to PDF are rendered from one
     * description rather than from two readings of the source. They disagreed
     * about lists once; one input is how that stops happening.
     *
     * Only `text`, `rows`, `level` and `ordered` are read -- never `runs` --
     * because runs are inline formatting only: they carry the bold and the
     * italic and drop the links, and a web page exported without its links has
     * had something taken out of it.
     *
     * `opts.images` is a `{ url: 'data:...' }` map of pictures the caller has
     * already fetched. It is passed rather than substituted into the Markdown
     * on purpose: one conversion feeds both the PDF and the Word file, and
     * base64 written into the Markdown would come out of Word as several
     * hundred kilobytes of visible gibberish where the picture should be.
     */
    blocksHtml: function (blocks, opts) {
      var o = opts || {};
      /* `{ url: 'data:...' }` for pictures the caller has already fetched. An
         absent map is the whole of the old behaviour, which is why the callers
         that have no pictures to offer did not have to change. */
      var pics = (o.images && typeof o.images === 'object') ? o.images : {};
      var esc = function (s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      };

      /* Inline Markdown to HTML. Code spans are taken first and their contents
         are not scanned again, so an asterisk inside `code` stays an asterisk
         -- the same rule office.js applies when it builds runs. */
      var inline = function (raw) {
        var src = String(raw == null ? '' : raw);
        var out = '';
        var re = /(`+)([\s\S]+?)\1|!\[([^\]]*)\]\(([^)\s]+)[^)]*\)|\[([^\]]+)\]\(([^)\s]+)[^)]*\)|(\*\*|__)([\s\S]+?)\7|(~~)([\s\S]+?)\9|(\*|_)([\s\S]+?)\11/g;
        var at = 0;
        var m;
        while ((m = re.exec(src))) {
          out += esc(src.slice(at, m.index));
          at = m.index + m[0].length;
          if (m[1]) { out += '<code>' + esc(m[2]) + '</code>'; continue; }
          if (m[4] !== undefined) {
            /* The print document is served under `img-src data:` -- it is
               measured offline and must not reach the network, which is the
               rule that stops a converted document fetching anything. So the
               only picture that can be drawn is one whose bytes are already in
               hand: either the Markdown carried them as a data: URI, or the
               caller fetched them first and passed them in `opts.images`, keyed
               by the URL exactly as it appears here.

               A remote URL with nothing behind it stays a line saying a picture
               was there. That is not a fallback that went wrong -- it is what
               an unfetchable picture honestly looks like. */
            var got = /^data:/i.test(m[4]) ? m[4] : (pics[m[4]] || '');
            if (got) {
              out += '<img src="' + esc(got) + '" alt="' + esc(m[3]) + '">';
            } else {
              out += '<span class="pr-img">［圖片' + (m[3] ? '：' + esc(m[3]) : '') + '］</span>';
            }
            continue;
          }
          if (m[6]) { out += '<a href="' + esc(m[6]) + '">' + esc(m[5]) + '</a>'; continue; }
          if (m[7]) { out += '<strong>' + inline(m[8]) + '</strong>'; continue; }
          if (m[9]) { out += '<s>' + inline(m[10]) + '</s>'; continue; }
          if (m[11]) { out += '<em>' + inline(m[12]) + '</em>'; continue; }
        }
        return out + esc(src.slice(at));
      };

      var html = [];
      var list = null;      // the open <ul>/<ol>, or null
      var closeList = function () {
        if (list) { html.push(list === 'ol' ? '</ol>' : '</ul>'); list = null; }
      };

      (blocks || []).forEach(function (b) {
        if (!b || !b.type) return;
        if (b.type === 'list') {
          var want = b.ordered ? 'ol' : 'ul';
          if (list !== want) { closeList(); html.push('<' + want + '>'); list = want; }
          html.push('<li>' + inline(b.text) + '</li>');
          return;
        }
        closeList();
        if (b.type === 'heading') {
          var lv = Math.min(6, Math.max(1, Number(b.level) || 1));
          html.push('<h' + lv + '>' + inline(b.text) + '</h' + lv + '>');
        } else if (b.type === 'quote') {
          html.push('<blockquote>' + inline(b.text) + '</blockquote>');
        } else if (b.type === 'break') {
          html.push('<div class="pr-page-break"></div>');
        } else if (b.type === 'table') {
          var rows = b.rows || [];
          if (!rows.length) return;
          html.push('<table><thead><tr>' + (rows[0] || []).map(function (c) {
            return '<th>' + inline(c) + '</th>';
          }).join('') + '</tr></thead><tbody>');
          rows.slice(1).forEach(function (r) {
            html.push('<tr>' + r.map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>');
          });
          html.push('</tbody></table>');
        } else {
          html.push('<p>' + inline(b.text) + '</p>');
        }
      });
      closeList();

      if (o.title) html.unshift('<h1>' + esc(o.title) + '</h1>');
      if (o.subtitle) html.splice(o.title ? 1 : 0, 0, '<p class="pr-sub">' + esc(o.subtitle) + '</p>');
      return html.join('\n');
    },

    /**
     * Export to PDF. Returns the path written.
     *
     * The caller supplies the content and the page setup; everything about talking
     * to the print engine lives here.
     */
    /**
     * The running head and foot, as the print engine wants them.
     *
     * These cannot be part of the document: the header repeats on every page and
     * nothing in the page knows where the page boundaries fell. Chromium takes
     * two HTML fragments and substitutes into a handful of reserved class names,
     * of which `pageNumber` and `totalPages` are the ones worth having.
     *
     * Both fragments carry their own font size and colour. The default is around
     * 8px unstyled, which is legible on a screen at 1:1 and not on paper.
     */
    headerFooter: function (opts) {
      var o = opts || {};
      var head = String(o.header || '').trim();
      var foot = String(o.footer || '').trim();
      var nums = !!o.pageNumbers;
      if (!head && !foot && !nums) return { on: false, header: '', footer: '' };

      var esc = function (s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      };
      var base = 'font-family: sans-serif; font-size: 9pt; color: #55636f;' +
                 ' width: 100%; box-sizing: border-box; padding: 0 14mm; display: flex;';
      var both = foot && nums;
      return {
        on: true,
        header: '<div style="' + base + ' justify-content: center;">' + esc(head) + '</div>',
        footer: '<div style="' + base + ' justify-content: ' +
                (both ? 'space-between' : 'center') + ';">' +
                (foot ? '<span>' + esc(foot) + '</span>' : '') +
                (nums ? '<span>第 <span class="pageNumber"></span> / ' +
                        '<span class="totalPages"></span> 頁</span>' : '') +
                '</div>'
      };
    },

    toPdf: async function (target, opts) {
      var o = opts || {};
      var html = AIOS.printing.document(o);
      var hf = AIOS.printing.headerFooter(o);
      var res = await window.aios.office.writePdf(target, html, {
        pageSize: o.pageSize || 'A4',
        landscape: !!o.landscape,
        /* The document's own @page rule is authoritative, so margins are set in
           CSS rather than passed here -- except when there is a running head,
           which the engine draws in the page margin and therefore needs one it
           knows the size of. */
        margins: hf.on ? { marginType: 'custom', top: 0.7, bottom: 0.7, left: 0.63, right: 0.63 }
                       : { marginType: 'none' },
        displayHeaderFooter: hf.on,
        headerTemplate: hf.header,
        footerTemplate: hf.footer
      });
      if (!res.ok) throw new Error(res.error);

      var out = { vpath: res.data.vpath, bytes: res.data.bytes, warning: null };
      var bad = await AIOS.printing.radicalDamage(res.data.vpath);
      if (bad) {
        out.warning = '這個字型讓 PDF 的文字層有 ' + bad +
          ' 處變成康熙部首碼位，看起來正確但搜尋與複製會不準。' +
          '改用新細明體或標楷體匯出可以避免。';
      }
      return out;
    },

    /**
     * How many characters came out as radical lookalikes.
     *
     * Chromium's PDF is visually right and its text layer is not: with the
     * sans-serif CJK fonts on this machine, 一 is written as U+2F00 KANGXI RADICAL
     * ONE, 用 as U+2F64, and so on -- measured at 12 of 13 common characters for
     * 微軟正黑體 and Noto Sans TC, and 0 for 新細明體 and 標楷體. Confirmed against
     * pdf.js as a second reader, which agrees codepoint for codepoint, so the
     * defect is in the file rather than in this project's extractor.
     *
     * It matters because a PDF nobody can search is half a document, and because
     * an exported PDF read back into the model's context would feed it radicals.
     * The reader repairs what it extracts, so the model is safe -- but the file
     * on disk is still wrong for Adobe, for Chrome's viewer and for Windows
     * search, which is what this warning is for.
     *
     * The count comes from the extractor's own repair tally rather than from
     * scanning the text it returned: after the repair there is nothing left to
     * scan, and a check that counts zero because the damage was fixed for it is
     * a false all-clear.
     *
     * Every page, not page one. The deck this was measured on had 0 radicals on
     * its title page and 39 across the other five -- a one-page sample would
     * have called it clean.
     */
    radicalDamage: async function (vpath) {
      try {
        var r = await window.aios.pdf.read(vpath);
        if (!r.ok || !r.data.pages) return 0;
        return r.data.pages.reduce(function (n, p) { return n + (p.radicals || 0); }, 0);
      } catch (e) {
        return 0;      // a check that fails must not fail the export
      }
    }
  };

  AIOS.fonts = {
    families: [
      { id: 'sans',   name: '微軟正黑體',      css: '"微軟正黑體", "Microsoft JhengHei UI", sans-serif', note: '無襯線，中英文都齊' },
      { id: 'noto',   name: 'Noto Sans TC',    css: '"Noto Sans TC", sans-serif',                        note: '無襯線，字重多' },
      { id: 'mingliu', name: '新細明體',        css: '"新細明體", "PMingLiU", serif',                     note: '襯線，傳統排版' },
      { id: 'kai',    name: '標楷體',          css: '"標楷體", "DFKai-SB", serif',                       note: '楷書，公文常用' },
      { id: 'segoe',  name: 'Segoe UI',        css: '"Segoe UI", sans-serif',                            note: '介面字，中文會退回代用' },
      { id: 'arial',  name: 'Arial',           css: 'Arial, Helvetica, sans-serif',                       note: '' },
      { id: 'times',  name: 'Times New Roman', css: '"Times New Roman", Times, serif',                    note: '' },
      { id: 'georgia', name: 'Georgia',        css: 'Georgia, serif',                                     note: '' },
      { id: 'calibri', name: 'Calibri',        css: 'Calibri, sans-serif',                                note: 'Word 預設' },
      { id: 'cambria', name: 'Cambria',        css: 'Cambria, serif',                                     note: '' },
      { id: 'verdana', name: 'Verdana',        css: 'Verdana, sans-serif',                                note: '' },
      { id: 'tahoma', name: 'Tahoma',          css: 'Tahoma, sans-serif',                                 note: '' },
      { id: 'consolas', name: 'Consolas',      css: 'Consolas, ui-monospace, monospace',                  note: '等寬' },
      { id: 'courier', name: 'Courier New',    css: '"Courier New", monospace',                            note: '等寬' }
    ],

    sizes: [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48],

    /** The CSS stack for a family name, falling back to quoting the name. */
    cssFor: function (name) {
      if (!name) return '';
      var hit = AIOS.fonts.families.find(function (f) { return f.name === name; });
      return hit ? hit.css : '"' + String(name).replace(/"/g, '') + '"';
    },

    /**
     * Fill a <select> with the catalogue. Each option previews itself, which is
     * the only way to notice a substitution before it reaches a file.
     */
    fillSelect: function (sel, opts) {
      var o = opts || {};
      sel.innerHTML = '';
      if (o.inheritLabel) {
        var inh = document.createElement('option');
        inh.value = '';
        inh.textContent = o.inheritLabel;
        sel.appendChild(inh);
      }
      AIOS.fonts.families.forEach(function (f) {
        var opt = document.createElement('option');
        opt.value = f.name;
        opt.textContent = f.name;
        opt.style.fontFamily = f.css;
        if (f.note) opt.title = f.note;
        sel.appendChild(opt);
      });
      var custom = document.createElement('option');
      custom.value = '__custom__';
      custom.textContent = '自訂字型名稱…';
      sel.appendChild(custom);
      return sel;
    },

    fillSizeSelect: function (sel, opts) {
      var o = opts || {};
      sel.innerHTML = '';
      if (o.inheritLabel) {
        var inh = document.createElement('option');
        inh.value = '';
        inh.textContent = o.inheritLabel;
        sel.appendChild(inh);
      }
      AIOS.fonts.sizes.forEach(function (n) {
        var opt = document.createElement('option');
        opt.value = String(n);
        opt.textContent = String(n);
        sel.appendChild(opt);
      });
      return sel;
    },

    /**
     * Resolve a picker's value, prompting when the user chose "custom".
     * Returns the family name, '' for inherit, or null when they backed out.
     */
    resolveChoice: async function (value, host) {
      if (value !== '__custom__') return value;
      var name = await AIOS.prompt({
        host: host,
        label: '字型名稱',
        note: '照 Windows 字型名稱輸入。這台機器上沒有的字型，畫面會用代用字顯示，' +
              '但檔案裡記的還是你輸入的名字。',
        value: '',
        selectStem: false
      });
      return name || null;
    }
  };

  /**
   * Ask for a target path for "save a copy".
   *
   * Shared because every document application needs the identical three steps
   * and the third one is the one that matters: an overwrite has to be a
   * separate, explicit answer. The whole point of Save As is usually "keep the
   * original", so silently clobbering a file the user picked by mistake would
   * defeat the feature it is implementing.
   *
   * Resolves with a sandbox path, or null if the user backed out at any step.
   */
  AIOS.saveAsPath = async function (opts) {
    var o = opts || {};
    var current = o.current || '';
    var dir = current ? current.slice(0, current.lastIndexOf('/')) : (o.dir || '/notes');
    var name = current ? current.slice(current.lastIndexOf('/') + 1) : (o.defaultName || '未命名');

    // Suggest a sibling copy rather than the same name, so pressing Enter is
    // never destructive.
    //
    // Unless there is nothing to be destructive to: `fresh` is for a file being
    // made rather than copied -- a web page on its way to becoming a PDF has no
    // original, and 「台北天氣 副本.pdf」 is just a wrong name to have to correct.
    var dot = name.lastIndexOf('.');
    var suggestion = o.fresh ? name
      : (dot > 0 ? name.slice(0, dot) + ' 副本' + name.slice(dot) : name + ' 副本');

    var answer = await AIOS.prompt({
      host: o.host,
      label: '另存新檔',
      note: o.note || ('存到沙箱路徑。目前是 ' + (current || '（尚未存檔）') +
        (o.formats ? '\n可用格式：' + o.formats : '')),
      value: (dir || '') + '/' + suggestion,
      okLabel: '另存'
    });
    if (!answer) return null;

    var target = AIOS.fs.resolve
      ? (answer[0] === '/' ? answer : '/' + answer)
      : answer;
    target = target.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    if (target === current) {
      // Not an error: they asked to save, so just let the normal save path run.
      return target;
    }

    var existing = AIOS.fs.entry(target);
    if (existing) {
      var ok = await AIOS.confirm({
        host: o.host,
        label: target + ' 已經存在',
        note: '要覆蓋掉它嗎？舊內容不會進回收桶，直接被取代。',
        okLabel: '覆蓋',
        danger: true
      });
      if (!ok) return null;
    }
    return target;
  };

  /* =======================================================================
     Document colours
     ---------------------------------------------------------------------
     One palette for every document surface, as concrete hex rather than theme
     variables: a file keeps its colours when it is exported, printed, or opened
     on a machine that has never heard of this shell's themes, and .xlsx has
     nowhere to store "whatever the current theme calls accent".

     Shared so that "深藍" means one colour in the spreadsheet and the same colour
     in the deck. Two lists would diverge on the first addition.

     Stored without the leading '#' because that is the form OOXML wants;
     hexOf() accepts either, plus the localised name.
     ===================================================================== */

  AIOS.palette = {
    fills: [
      { hex: '', name: '無' },
      { hex: 'FFF2CC', name: '淺黃' },
      { hex: 'FCE4D6', name: '淺橙' },
      { hex: 'FFD6D6', name: '淺紅' },
      { hex: 'DDEBF7', name: '淺藍' },
      { hex: 'E2EFDA', name: '淺綠' },
      { hex: 'E9E2F5', name: '淺紫' },
      { hex: 'EDEDED', name: '淺灰' },
      { hex: 'FFFFFF', name: '白' },
      { hex: 'C00000', name: '深紅' },
      { hex: 'BF8F00', name: '深黃' },
      { hex: '1F4E79', name: '深藍' },
      { hex: '375623', name: '深綠' },
      { hex: '404040', name: '深灰' },
      { hex: '000000', name: '黑' }
    ],

    /** The names a caller may use, for an error message worth reading. */
    names: function () {
      return AIOS.palette.fills.filter(function (c) { return c.hex; })
        .map(function (c) { return c.name; });
    },

    /**
     * Like hexOf, but a value that means nothing is an error rather than grey.
     *
     * An empty value still means "no colour" -- that is a real answer. What this
     * refuses is a name nobody has, because the alternative is what the border
     * commands already refuse for their own vocabulary: doing something other than
     * what was asked and reporting success. A model that asks for 橙 and silently
     * gets grey has no way to find out.
     */
    require: function (value, what) {
      if (value === null || value === undefined || value === '') return null;
      var hex = AIOS.palette.hexOf(value);
      if (hex) return hex;
      throw new Error('不認得的' + (what || '顏色') + '「' + value + '」；' +
        '可用 #RRGGBB 或：' + AIOS.palette.names().join('、'));
    },

    /** '#RRGGBB', 'RRGGBB' or a localised name -> 'RRGGBB'. null when unreadable. */
    hexOf: function (value) {
      if (value == null || value === '') return null;
      var s = String(value).trim().replace(/^#/, '').toUpperCase();
      if (/^[0-9A-F]{6}$/.test(s)) return s;
      var named = AIOS.palette.fills.filter(function (c) {
        return c.name === String(value).trim();
      })[0];
      return named && named.hex ? named.hex : null;
    },

    /** WCAG relative luminance, 0 (black) to 1 (white). */
    luminance: function (hex) {
      var h = AIOS.palette.hexOf(hex);
      if (!h) return 1;
      var lin = [0, 2, 4].map(function (i) {
        var c = parseInt(h.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    },

    /**
     * A text colour that can actually be read on this fill.
     *
     * The crossover between these two inks is luminance 0.184 -- above it the
     * dark one wins, below it the light one. Applied automatically wherever a
     * user picks a fill, because "bright green button, white label" is a thing
     * people choose by accident and then cannot read.
     *
     * Returns null for no fill: there is nothing to contrast against, so the
     * surface's own text colour should stand.
     */
    readableOn: function (hex) {
      var h = AIOS.palette.hexOf(hex);
      if (!h) return null;
      return AIOS.palette.luminance(h) > 0.184 ? '#0b1016' : '#f4f8ff';
    }
  };

  /* =======================================================================
     Cell borders and shading
     ---------------------------------------------------------------------
     One border model for the three surfaces that have tables: the spreadsheet,
     a slide's table object, and a table block in a document.

     A border is stored per cell, as the edges that cell draws. Storing the
     *intent* instead ("this range has an outer box") would mean every cell had to
     know where it sat inside a range it no longer belongs to the moment a row is
     inserted. So the range arithmetic happens once, at the point of the command,
     and what survives is per-cell facts.

     An edge is { style, width, colour } or absent. Not a boolean and not a
     letter: the whole point of this round of work is that a person can choose a
     double line, a quarter-point hairline and a colour, and Word's border toolbox
     is those three controls plus "which edges". The old form -- a string like
     `tblr` with capitals for thick -- is still read, because saved files have it.

     The pen is shared session state, which is what Word does: you set the line
     style, width and colour once, and the next border you draw uses them. Making
     it per-application would mean setting it three times to get one table to
     match another.

     Widths are points, because that is the unit the format and the ruler agree
     on. docx stores eighths of a point, so every value here is exact there.
     xlsx has no width at all -- it has named styles -- so a spreadsheet border
     snaps to the nearest one Excel can express. That is a real limitation of the
     format, reported rather than hidden.
     ===================================================================== */

  AIOS.borders = {

    /* The line styles all three formats can express. `css` is what the screen
       and the PDF get; `docx` and `xlsx` are the names in the two file formats. */
    STYLES: [
      { id: 'single',  name: '單線',   css: 'solid',  docx: 'single',         xlsx: 'thin' },
      { id: 'double',  name: '雙線',   css: 'double', docx: 'double',         xlsx: 'double' },
      { id: 'dashed',  name: '虛線',   css: 'dashed', docx: 'dashed',         xlsx: 'dashed' },
      { id: 'dotted',  name: '點線',   css: 'dotted', docx: 'dotted',         xlsx: 'dotted' },
      { id: 'dashDot', name: '虛點線', css: 'dashed', docx: 'dashDotStroked', xlsx: 'dashDot' }
    ],

    /* Word's list, and for the same reason: these are the widths a printer can
       actually distinguish. */
    WIDTHS: [0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6],

    EDGES: ['t', 'r', 'b', 'l'],
    EDGE_NAMES: { t: '上', r: '右', b: '下', l: '左' },

    /**
     * Which edges a command touches.
     *
     * `undefined` for an edge means "leave whatever is there", which is what
     * makes 下框線 add a bottom line without erasing the box around it. Only
     * 無框線 clears, and it clears all four.
     */
    APPLY: [
      { id: 'all',     name: '所有框線' },
      { id: 'box',     name: '外框線' },
      { id: 'inside',  name: '內框線' },
      { id: 'insideH', name: '水平內框線' },
      { id: 'insideV', name: '垂直內框線' },
      { id: 'top',     name: '上框線' },
      { id: 'bottom',  name: '下框線' },
      { id: 'left',    name: '左框線' },
      { id: 'right',   name: '右框線' },
      { id: 'none',    name: '無框線' }
    ],

    /* The current pen. Shared on purpose; see the note above. */
    pen: { style: 'single', width: 0.5, colour: '808080' },

    setPen: function (patch) {
      var p = patch || {};
      if (p.style) {
        var known = AIOS.borders.STYLES.some(function (s) { return s.id === p.style; });
        if (known) AIOS.borders.pen.style = p.style;
      }
      if (p.width !== undefined) {
        var w = Number(p.width);
        if (Number.isFinite(w) && w > 0) AIOS.borders.pen.width = Math.min(12, Math.max(0.25, w));
      }
      if (p.colour !== undefined) {
        // '' is a legitimate answer: it means the automatic ink.
        AIOS.borders.pen.colour = AIOS.palette.hexOf(p.colour) || '808080';
      }
      return AIOS.borders.pen;
    },

    styleOf: function (id) {
      return AIOS.borders.STYLES.filter(function (s) { return s.id === id; })[0] ||
             AIOS.borders.STYLES[0];
    },

    /** `1/2 pt`, the way the picker and Word both write it. */
    widthLabel: function (w) {
      var whole = Math.floor(w);
      var frac = { 0.25: '1/4', 0.5: '1/2', 0.75: '3/4' }[Math.round((w - whole) * 100) / 100];
      if (!frac) return w + ' pt';
      return (whole ? whole + ' ' : '') + frac + ' pt';
    },

    /** One edge, cleaned. `true` means "use the pen". null for no edge. */
    edge: function (raw) {
      if (!raw) return null;
      var src = raw === true ? AIOS.borders.pen : raw;
      var style = AIOS.borders.styleOf(src.style).id;
      var w = Number(src.width);
      if (!Number.isFinite(w) || w <= 0) w = 0.5;
      return {
        style: style,
        width: Math.min(12, Math.max(0.25, Math.round(w * 100) / 100)),
        colour: AIOS.palette.hexOf(src.colour) || '808080'
      };
    },

    /**
     * A cell's borders, cleaned.
     *
     * Three states per edge, not two, and the third is the one that makes the
     * whole thing work:
     *
     *   an edge object  -- draw this
     *   null            -- draw nothing, explicitly
     *   the key absent  -- say nothing; whatever the surface draws by default
     *
     * That is Word's model, and it is the only one in which adding a bottom rule
     * to a cell leaves the rest of the table's grid alone while 無框線 actually
     * removes a line. Collapsing null and absent into one would force a choice
     * between those two, and either choice is wrong half the time.
     *
     * Accepts the old letter form -- `tblr`, capitals for thick -- because files
     * saved before borders had a style or a colour still contain it. A capital
     * meant "medium", which was 1.5pt in everything but name.
     */
    norm: function (spec) {
      if (!spec) return null;
      var out = {};
      if (typeof spec === 'string') {
        AIOS.borders.EDGES.forEach(function (e) {
          if (spec.indexOf(e.toUpperCase()) >= 0) {
            out[e] = AIOS.borders.edge({ style: 'single', width: 1.5, colour: '8A8A8A' });
          } else if (spec.indexOf(e) >= 0) {
            out[e] = AIOS.borders.edge({ style: 'single', width: 0.5, colour: '8A8A8A' });
          }
        });
      } else {
        AIOS.borders.EDGES.forEach(function (e) {
          if (!Object.prototype.hasOwnProperty.call(spec, e)) return;
          out[e] = AIOS.borders.edge(spec[e]);
        });
      }
      return Object.keys(out).length ? out : null;
    },

    /**
     * A stable string for one border set.
     *
     * Needed for two things that both go wrong without it: interning distinct
     * borders into a style table when writing xlsx, and answering "did this
     * survive being saved" without an object comparison that reports a difference
     * in key order as a difference in the border. `-` is an edge that says
     * nothing, which is not the same answer as one that says none.
     */
    key: function (spec) {
      var b = AIOS.borders.norm(spec);
      if (!b) return '';
      return AIOS.borders.EDGES.map(function (e) {
        if (!Object.prototype.hasOwnProperty.call(b, e)) return e + ':-';
        var v = b[e];
        return e + ':' + (v ? v.style + ':' + v.width + ':' + v.colour : 'none');
      }).join('|');
    },

    same: function (a, b) { return AIOS.borders.key(a) === AIOS.borders.key(b); },

    /**
     * CSS for one edge.
     *
     * Rounded up to whole pixels with a floor of one, because a border the
     * browser renders as zero is a border the user asked for and cannot see.
     * Ceiling rather than rounding makes 3/4, 1 1/2, 3 and 6 pt exact at 96dpi,
     * which are the ones people pick.
     */
    css: function (e, opts) {
      if (!e) return '';
      var o = opts || {};
      var w;
      if (o.unit && o.ptPerUnit) {
        /* A slide is drawn in units of its own height, so everything on it scales
           with it. A border in pixels would be the one thing that did not, and
           would look four times too heavy in a 170px thumbnail. */
        w = (Math.round((e.width / o.ptPerUnit) * 1000) / 1000) + o.unit;
      } else {
        w = Math.max(1, Math.ceil(e.width * 4 / 3)) + 'px';
      }
      return w + ' ' + AIOS.borders.styleOf(e.style).css + ' #' + e.colour;
    },

    /**
     * Write a border set onto a node as inline styles.
     *
     * An edge that says nothing gets no inline value, so whatever the stylesheet
     * draws underneath shows through. What an edge that says *none* should do
     * depends on what is underneath, and the two surfaces differ: in a document's
     * table the line under it is the table's own border and has to go, while in
     * the spreadsheet it is a gridline, which Excel keeps whatever the borders
     * say. `opts.noneAs` is that choice, made by the surface that knows.
     */
    paint: function (node, spec, opts) {
      var b = AIOS.borders.norm(spec);
      var noneAs = opts && opts.noneAs !== undefined ? opts.noneAs : 'none';
      var side = { t: 'Top', r: 'Right', b: 'Bottom', l: 'Left' };
      AIOS.borders.EDGES.forEach(function (e) {
        var css = '';
        if (b && Object.prototype.hasOwnProperty.call(b, e)) {
          css = b[e] ? AIOS.borders.css(b[e], opts) : noneAs;
        }
        node.style['border' + side[e]] = css;
      });
      return node;
    },

    /**
     * What one cell gets when `kind` is applied over `range`.
     *
     * `cell` is the cell's own rectangle -- already grown through any merge it is
     * the master of, because the node that draws the border reaches the far side
     * of the span. Asking whether its own column is the last one in the range
     * would leave the right-hand edge of every merged block undrawn.
     *
     * An interior line is set once, on the bottom or right of the cell above or
     * to the left. Setting it on both sides draws the same line twice and makes
     * which one wins under border-collapse a coin toss.
     */
    edgesFor: function (kind, cell, range, pen) {
      var e = AIOS.borders.edge(pen || true);
      var k = String(kind || '');
      if (k === 'none') return { t: null, r: null, b: null, l: null };
      if (k === 'all') return { t: e, r: e, b: e, l: e };

      var atTop = cell.r0 <= range.r0;
      var atBottom = cell.r1 >= range.r1;
      var atLeft = cell.c0 <= range.c0;
      var atRight = cell.c1 >= range.c1;
      var out = {};
      switch (k) {
        case 'box':
          if (atTop) out.t = e;
          if (atBottom) out.b = e;
          if (atLeft) out.l = e;
          if (atRight) out.r = e;
          break;
        case 'inside':
          if (!atBottom) out.b = e;
          if (!atRight) out.r = e;
          break;
        case 'insideH': if (!atBottom) out.b = e; break;
        case 'insideV': if (!atRight) out.r = e; break;
        case 'top':     if (atTop) out.t = e; break;
        case 'bottom':  if (atBottom) out.b = e; break;
        case 'left':    if (atLeft) out.l = e; break;
        case 'right':   if (atRight) out.r = e; break;
        default: throw new Error('不認得的框線種類「' + k + '」；可用：' +
          AIOS.borders.APPLY.map(function (a) { return a.id; }).join('、'));
      }
      return out;
    },

    /**
     * Patch edges onto an existing set. `null` clears an edge, an absent key
     * leaves it, which is what lets 下框線 add to a box instead of replacing it.
     */
    patch: function (spec, changes) {
      var base = AIOS.borders.norm(spec) || {};
      var c = changes || {};
      var out = {};
      AIOS.borders.EDGES.forEach(function (e) {
        if (Object.prototype.hasOwnProperty.call(c, e)) out[e] = AIOS.borders.edge(c[e]);
        else if (Object.prototype.hasOwnProperty.call(base, e)) out[e] = base[e];
      });
      return Object.keys(out).length ? out : null;
    },

    /**
     * Word's border toolbox, built into a popover panel.
     *
     * One implementation for all three tables. The alternative is three panels
     * that disagree about how many line widths exist, or about whether 內框線
     * means what it means in Word -- and a person who has learnt one table would
     * have to learn the others.
     *
     * opts:
     *   scope        what the buttons will act on, said out loud
     *   fill         the shading of the current cell, or undefined to omit shading
     *   onFill(hex)  called with '' for no fill
     *   onApply(kind, whole)  `whole` is true when the scope toggle says so
     *   whole        offer the "the whole table" toggle
     *   wholeDefault start with it on -- see the note where it is read
     */
    panel: function (host, opts) {
      var o = opts || {};
      var B = AIOS.borders;
      var whole = !!o.wholeDefault;

      function row(parent) {
        var r = el('div', 'ui-pop-row');
        parent.appendChild(r);
        return r;
      }
      function chip(parent, label, title, on, onClick) {
        var b = el('button', 'fbtn' + (on ? ' on' : ''), label);
        b.type = 'button';
        if (title) b.title = title;
        // The caret must stay where it was; see the note on the toolbar buttons.
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', onClick);
        parent.appendChild(b);
        return b;
      }
      function swatches(parent, current, onPick, autoLabel) {
        var r = el('div', 'ui-swatches');
        AIOS.palette.fills.forEach(function (col) {
          var b = el('button', 'ui-swatch' + (current === col.hex ? ' on' : ''));
          b.type = 'button';
          b.title = col.name;
          b.setAttribute('aria-label', col.name);
          if (col.hex) b.style.background = '#' + col.hex;
          else b.classList.add('ui-swatch-none');
          b.addEventListener('mousedown', function (e) { e.preventDefault(); });
          b.addEventListener('click', function () { onPick(col.hex); });
          r.appendChild(b);
        });
        if (autoLabel) {
          var a = el('button', 'ui-swatch ui-swatch-auto', 'A');
          a.type = 'button';
          a.title = autoLabel;
          a.addEventListener('mousedown', function (e) { e.preventDefault(); });
          a.addEventListener('click', function () { onPick(''); });
          r.appendChild(a);
        }
        parent.appendChild(r);
        return r;
      }

      if (o.scope) host.appendChild(el('div', 'ui-pop-count', o.scope));

      /* Shading is read after the scope toggle is built, so it lands on the same
         cells a border would. A shade that went to one cell while the border next
         to it went to the whole table would be a panel that means two things. */
      if (o.onFill) {
        host.appendChild(el('div', 'ui-pop-sub', '網底'));
        swatches(host, o.fill || null, function (hex) { o.onFill(hex, whole); }, '無網底');
      }

      /* The pen. Three controls that all write into the shared pen, and a live
         preview so the next click on a border button is predictable. */
      host.appendChild(el('div', 'ui-pop-sub', '框線樣式'));
      var styleRow = row(host);
      var preview = el('div', 'ui-bpen');
      var line = el('i');
      preview.appendChild(line);

      function syncPen() {
        [].forEach.call(styleRow.children, function (b) {
          b.classList.toggle('on', b.dataset.style === B.pen.style);
        });
        var e = B.edge(true);
        line.style.borderTop = B.css(e);
        preview.title = B.styleOf(B.pen.style).name + '　' + B.widthLabel(B.pen.width) +
                        '　#' + B.pen.colour;
        [].forEach.call(host.querySelectorAll('.ui-bpen-ink'), function (b) {
          b.classList.toggle('on', b.dataset.hex === B.pen.colour);
        });
      }

      B.STYLES.forEach(function (s) {
        var b = chip(styleRow, '', s.name, false, function () {
          B.setPen({ style: s.id });
          syncPen();
        });
        b.dataset.style = s.id;
        b.classList.add('ui-bstyle');
        var pv = el('i');
        pv.style.borderTop = '2px ' + s.css + ' currentColor';
        b.appendChild(pv);
      });

      host.appendChild(el('div', 'ui-pop-sub', '線寬'));
      var wRow = row(host);
      var wSel = el('select', 'ui-pop-field');
      wSel.style.width = '96px';
      B.WIDTHS.forEach(function (w) {
        var opt = el('option', null, B.widthLabel(w));
        opt.value = String(w);
        wSel.appendChild(opt);
      });
      wSel.value = String(B.pen.width);
      wSel.title = '線寬（pt）';
      wSel.addEventListener('change', function () {
        B.setPen({ width: Number(wSel.value) });
        syncPen();
      });
      wRow.appendChild(wSel);
      wRow.appendChild(preview);

      host.appendChild(el('div', 'ui-pop-sub', '畫筆色彩'));
      var inkRow = el('div', 'ui-swatches');
      AIOS.palette.fills.forEach(function (col) {
        if (!col.hex) return;                       // there is no "no colour" pen
        var b = el('button', 'ui-swatch ui-bpen-ink');
        b.type = 'button';
        b.title = col.name;
        b.dataset.hex = col.hex;
        b.style.background = '#' + col.hex;
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', function () { B.setPen({ colour: col.hex }); syncPen(); });
        inkRow.appendChild(b);
      });
      host.appendChild(inkRow);

      host.appendChild(el('div', 'ui-pop-sub', '框線'));
      if (o.whole) {
        var scopeRow = row(host);
        var lab = el('label', 'ui-pop-check');
        var box = el('input');
        box.type = 'checkbox';
        box.checked = whole;
        box.addEventListener('change', function () { whole = box.checked; });
        lab.appendChild(box);
        lab.appendChild(document.createTextNode('套用到整張表格'));
        scopeRow.appendChild(lab);
      }
      var grid = el('div', 'ui-bedges');
      B.APPLY.forEach(function (a) {
        var b = el('button', 'ui-bedge ui-bedge-' + a.id);
        b.type = 'button';
        b.title = a.name;
        b.setAttribute('aria-label', a.name);
        b.appendChild(el('i'));
        b.appendChild(el('span', null, a.name));
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', function () { o.onApply(a.id, whole); });
        grid.appendChild(b);
      });
      host.appendChild(grid);

      syncPen();
      return host;
    },

    /**
     * A whole sparse cell-style map, cleaned.
     *
     * Entries outside the table are dropped, because a file or a chat action can
     * name a cell the table does not have and the renderer should not have to
     * guess. Returns null for an empty map, so a table that has never been styled
     * carries no field at all.
     */
    normCellStyles: function (map, bounds) {
      if (!map || typeof map !== 'object') return null;
      var b = bounds || {};
      var out = {};
      Object.keys(map).forEach(function (k) {
        var parts = String(k).split(',');
        var c = Number(parts[0]);
        var r = Number(parts[1]);
        if (!Number.isFinite(c) || !Number.isFinite(r) || c < 0 || r < 0) return;
        if (b.cols !== undefined && c >= b.cols) return;
        if (b.rows !== undefined && r >= b.rows) return;
        var st = map[k] || {};
        var clean = {};
        var border = AIOS.borders.norm(st.border);
        if (border) clean.border = border;
        var bg = AIOS.palette.hexOf(st.bg);
        if (bg) clean.bg = bg;
        if (Object.keys(clean).length) out[c + ',' + r] = clean;
      });
      return Object.keys(out).length ? out : null;
    },

    /** How a border set reads out loud, for a menu label or the model's context. */
    describe: function (spec) {
      var b = AIOS.borders.norm(spec);
      if (!b) return '未設定框線';
      var groups = {};
      var cleared = [];
      AIOS.borders.EDGES.forEach(function (e) {
        if (!Object.prototype.hasOwnProperty.call(b, e)) return;
        if (!b[e]) { cleared.push(AIOS.borders.EDGE_NAMES[e]); return; }
        var k = b[e].style + ':' + b[e].width + ':' + b[e].colour;
        (groups[k] = groups[k] || []).push(AIOS.borders.EDGE_NAMES[e]);
      });
      var said = Object.keys(groups).map(function (k) {
        var parts = k.split(':');
        return groups[k].join('') + ' ' + AIOS.borders.styleOf(parts[0]).name +
               ' ' + AIOS.borders.widthLabel(Number(parts[1])) + ' #' + parts[2];
      });
      if (cleared.length) said.push(cleared.join('') + ' 無框線');
      return said.length ? said.join('　') : '未設定框線';
    }
  };

  /* =======================================================================
     Merged cells
     ---------------------------------------------------------------------
     Three surfaces have tables -- the spreadsheet, a slide's table object, and a
     table block in a document -- and merging behaves identically in all of them.
     Only the drawing differs, so only the drawing lives in the applications.

     A merge is a rectangle of zero-based inclusive indices: { c0, r0, c1, r1 }.
     Rectangles rather than per-cell "I am merged" marks, because a rectangle is
     the unit a person manipulates, and because it is what both OOXML formats
     store -- `<mergeCell ref="A1:C1"/>` in a sheet, `gridSpan`/`vMerge` in a
     document. The round trip is a translation rather than an inference.

     Every rectangle has a master: its top-left cell. The master holds the value
     and is the only cell that renders, as a <td> with colSpan/rowSpan. The others
     produce no node at all, which is how an HTML table expresses a span.

     Everything here is a pure function over a list. No DOM, no state: the caller
     owns the list and swaps in what it gets back, so a merge is undone by the
     same snapshot mechanism as any other edit.
     ===================================================================== */

  AIOS.grid = {

    /** The key format the index below uses. Column first, to read like a ref. */
    key: function (c, r) { return c + ',' + r; },

    overlaps: function (a, b) {
      return a.c0 <= b.c1 && b.c0 <= a.c1 && a.r0 <= b.r1 && b.r0 <= a.r1;
    },

    /** `A1:C2`, for a message a person has to act on. */
    label: function (m) {
      var col = AIOS.formula.indexToCol;
      return col(m.c0) + (m.r0 + 1) + ':' + col(m.c1) + (m.r1 + 1);
    },

    /** A rectangle with its corners ordered, or null if it is not one. */
    rect: function (raw) {
      var m = raw || {};
      var c0 = Math.round(Number(m.c0));
      var c1 = Math.round(Number(m.c1));
      var r0 = Math.round(Number(m.r0));
      var r1 = Math.round(Number(m.r1));
      if (![c0, c1, r0, r1].every(Number.isFinite)) return null;
      if (Math.min(c0, c1, r0, r1) < 0) return null;
      return {
        c0: Math.min(c0, c1), c1: Math.max(c0, c1),
        r0: Math.min(r0, r1), r1: Math.max(r0, r1)
      };
    },

    /**
     * Sanitise a list from a file, a model, or a hand edit.
     *
     * One cell is not a merge -- storing it would leave the grid maintaining a
     * colSpan of 1 forever. Overlaps cannot be drawn at all, because two masters
     * would both claim the same cell, so the first one wins and the rest go.
     */
    norm: function (list, opts) {
      var o = opts || {};
      var out = [];
      (Array.isArray(list) ? list : []).forEach(function (raw) {
        var m = AIOS.grid.rect(raw);
        if (!m) return;
        if (m.c0 === m.c1 && m.r0 === m.r1) return;
        if (o.cols !== undefined && m.c1 >= o.cols) return;
        if (o.rows !== undefined && m.r1 >= o.rows) return;
        if (out.some(function (kept) { return AIOS.grid.overlaps(kept, m); })) return;
        out.push(m);
      });
      return out.slice(0, o.limit || 400);
    },

    /** The region covering a position, master included, or null. */
    at: function (list, c, r) {
      for (var i = 0; i < (list || []).length; i++) {
        var m = list[i];
        if (c >= m.c0 && c <= m.c1 && r >= m.r0 && r <= m.r1) return m;
      }
      return null;
    },

    /** Every region that meets a rectangle. */
    within: function (list, rect) {
      return (list || []).filter(function (m) { return AIOS.grid.overlaps(m, rect); });
    },

    /**
     * Which cells render and which are swallowed, built once per draw.
     *
     * A renderer asks this for every cell in the table, and answering it by
     * scanning the list each time is a few hundred thousand comparisons for a
     * sheet -- per keystroke.
     */
    map: function (list) {
      var masterAt = {};
      var coveredBy = {};
      (list || []).forEach(function (m) {
        var home = AIOS.grid.key(m.c0, m.r0);
        masterAt[home] = m;
        for (var r = m.r0; r <= m.r1; r++) {
          for (var c = m.c0; c <= m.c1; c++) {
            var k = AIOS.grid.key(c, r);
            if (k !== home) coveredBy[k] = { c: m.c0, r: m.r0, of: m };
          }
        }
      });
      return { masterAt: masterAt, coveredBy: coveredBy };
    },

    /**
     * Grow a rectangle until it contains every region it touches.
     *
     * This is what lets a selection model be merge-aware in one place: there is no
     * sensible meaning for "the left two thirds of a merged cell", so a selection
     * either holds a whole region or none of it. Growing can bring a further
     * region into range, so it repeats until it settles.
     */
    grow: function (list, rect) {
      var q = { c0: rect.c0, c1: rect.c1, r0: rect.r0, r1: rect.r1 };
      if (!(list || []).length) return q;
      for (var pass = 0; pass < 12; pass++) {
        var grew = false;
        for (var i = 0; i < list.length; i++) {
          var m = list[i];
          if (!AIOS.grid.overlaps(m, q)) continue;
          if (m.c0 < q.c0) { q.c0 = m.c0; grew = true; }
          if (m.c1 > q.c1) { q.c1 = m.c1; grew = true; }
          if (m.r0 < q.r0) { q.r0 = m.r0; grew = true; }
          if (m.r1 > q.r1) { q.r1 = m.r1; grew = true; }
        }
        if (!grew) break;
      }
      return q;
    },

    /**
     * Add a region, replacing anything it overlaps.
     *
     * Replaced rather than refused, so dragging across a merge and merging again
     * does the obvious thing instead of reporting a conflict the user can see is
     * not one.
     */
    merge: function (list, rect) {
      var kept = (list || []).filter(function (m) { return !AIOS.grid.overlaps(m, rect); });
      kept.push({ c0: rect.c0, c1: rect.c1, r0: rect.r0, r1: rect.r1 });
      return kept;
    },

    /** Remove every region meeting a rectangle. */
    clear: function (list, rect) {
      return (list || []).filter(function (m) { return !AIOS.grid.overlaps(m, rect); });
    },

    /**
     * Move and resize regions when rows or columns are inserted or deleted.
     *
     * op = { kind: 'insertRow'|'deleteRow'|'insertCol'|'deleteCol', at, count },
     * `at` zero-based. The same shape of answer a formula's range gets: a region
     * entirely after the cut shifts, one the cut lands inside grows or shrinks,
     * and one whose every line is deleted goes with them. A region reduced to a
     * single cell stops being a merge.
     */
    reshape: function (list, op) {
      var rowAxis = op.kind === 'insertRow' || op.kind === 'deleteRow';
      var insert = op.kind.indexOf('insert') === 0;
      var at = op.at;
      var n = op.count;
      var end = at + n - 1;
      var out = [];
      (list || []).forEach(function (m) {
        var lo = rowAxis ? m.r0 : m.c0;
        var hi = rowAxis ? m.r1 : m.c1;
        var a;
        var b;
        if (insert) {
          a = lo >= at ? lo + n : lo;
          // Inserting inside the region widens it, which is what happens
          // visually: the merged block keeps covering what it covered.
          b = hi >= at ? hi + n : hi;
        } else {
          if (lo >= at && hi <= end) return;
          a = lo > end ? lo - n : (lo >= at ? at : lo);
          b = hi > end ? hi - n : (hi >= at ? at - 1 : hi);
          if (b < a) return;
        }
        var next = rowAxis
          ? { c0: m.c0, c1: m.c1, r0: a, r1: b }
          : { c0: a, c1: b, r0: m.r0, r1: m.r1 };
        if (next.c0 === next.c1 && next.r0 === next.r1) return;
        out.push(next);
      });
      return out;
    },

    /**
     * The cells a merge swallows, as [row, col] pairs.
     *
     * Used to clear the contents that are about to become invisible, and to count
     * what merging is throwing away so it can be said out loud.
     */
    covered: function (rect) {
      var out = [];
      for (var r = rect.r0; r <= rect.r1; r++) {
        for (var c = rect.c0; c <= rect.c1; c++) {
          if (r === rect.r0 && c === rect.c0) continue;
          out.push([r, c]);
        }
      }
      return out;
    },

    /**
     * Move a sparse per-cell map through a structural change.
     *
     * Cell formatting lives in a map keyed by `key(c, r)` rather than alongside
     * the text, so an untouched table costs nothing and the text stays a plain
     * array of strings. The price is that inserting a row has to move the keys,
     * and forgetting to is how a border ends up one row below the cell it was
     * drawn on.
     *
     * `op` is the same shape `reshape` takes: {kind, at, count}. A key inside a
     * deleted band goes with it.
     */
    reshapeCells: function (map, op) {
      if (!map) return map;
      var kind = op && op.kind;
      var at = Math.max(0, Math.round((op && op.at) || 0));
      var count = Math.max(1, Math.round((op && op.count) || 1));
      var rowAxis = kind === 'insertRow' || kind === 'deleteRow';
      var adding = kind === 'insertRow' || kind === 'insertCol';
      var out = {};
      Object.keys(map).forEach(function (k) {
        var parts = k.split(',');
        var c = Number(parts[0]);
        var r = Number(parts[1]);
        var axis = rowAxis ? r : c;
        if (adding) {
          if (axis >= at) axis += count;
        } else {
          if (axis >= at && axis < at + count) return;      // it went with the band
          if (axis >= at + count) axis -= count;
        }
        out[AIOS.grid.key(rowAxis ? c : axis, rowAxis ? axis : r)] = map[k];
      });
      return out;
    },

    /* -------------------------------------------------------------------
       A plain table

       The shape a slide's table object and a document's table block both use:
       { rows: [[cell, ...], ...], merges: [rect, ...] }. Cells are strings, and
       per-cell formatting lives in `cellStyles`, keyed by `key(c, r)`.

       These mutate the table in place, because both callers snapshot the whole
       document before an edit and put the snapshot back if it throws. Returning a
       new table instead would mean each caller writing the same reassignment.

       The spreadsheet does not use these: its cells are objects with formatting
       and formulas, its grid is sparse, and inserting a row there has to rewrite
       every formula on every sheet. Same rectangles, different substance.
       ------------------------------------------------------------------- */

    table: {

      /** How big it is, measured from the rows rather than trusted from a field. */
      size: function (t) {
        var rows = (t.rows || []).length;
        var cols = (t.rows || []).reduce(function (n, row) {
          return Math.max(n, (row || []).length);
        }, 0);
        return { rows: rows, cols: cols };
      },

      /** Every row the same length, which is what colSpan bookkeeping assumes. */
      square: function (t) {
        var wide = AIOS.grid.table.size(t).cols;
        t.rows = (t.rows || []).map(function (row) {
          var out = (row || []).map(function (c) { return c == null ? '' : String(c); });
          while (out.length < wide) out.push('');
          return out;
        });
        return t;
      },

      /* Structure changes move three things, not one: the text, the merged
         rectangles, and the per-cell formatting. Moving two of them is worse than
         moving none, because the result looks right until you look at the borders. */
      restructure: function (t, op) {
        t.merges = AIOS.grid.reshape(t.merges, op);
        if (t.cellStyles) t.cellStyles = AIOS.grid.reshapeCells(t.cellStyles, op);
        return t;
      },

      insertRow: function (t, at) {
        var n = AIOS.grid.table.size(t);
        var where = Math.max(0, Math.min(n.rows, Math.round(at)));
        t.rows.splice(where, 0, new Array(n.cols).fill(''));
        AIOS.grid.table.restructure(t, { kind: 'insertRow', at: where, count: 1 });
        return where;
      },

      deleteRow: function (t, at) {
        var n = AIOS.grid.table.size(t);
        if (n.rows <= 1) throw new Error('至少要留一列');
        var where = Math.max(0, Math.min(n.rows - 1, Math.round(at)));
        t.rows.splice(where, 1);
        AIOS.grid.table.restructure(t, { kind: 'deleteRow', at: where, count: 1 });
        return where;
      },

      insertCol: function (t, at) {
        var n = AIOS.grid.table.size(t);
        var where = Math.max(0, Math.min(n.cols, Math.round(at)));
        t.rows.forEach(function (row) { row.splice(where, 0, ''); });
        AIOS.grid.table.restructure(t, { kind: 'insertCol', at: where, count: 1 });
        return where;
      },

      deleteCol: function (t, at) {
        var n = AIOS.grid.table.size(t);
        if (n.cols <= 1) throw new Error('至少要留一欄');
        var where = Math.max(0, Math.min(n.cols - 1, Math.round(at)));
        t.rows.forEach(function (row) { row.splice(where, 1); });
        AIOS.grid.table.restructure(t, { kind: 'deleteCol', at: where, count: 1 });
        return where;
      },

      /** One cell's formatting, or an empty object. Never null, so callers read. */
      styleAt: function (t, c, r) {
        return (t.cellStyles || {})[AIOS.grid.key(c, r)] || {};
      },

      /**
       * Write one cell's formatting. A patch, so shading and borders are set
       * independently; an empty result drops the entry rather than leaving `{}`
       * behind, which keeps a saved file the size of what is actually in it.
       */
      setStyleAt: function (t, c, r, patch) {
        var k = AIOS.grid.key(c, r);
        t.cellStyles = t.cellStyles || {};
        var next = Object.assign({}, t.cellStyles[k] || {});
        Object.keys(patch || {}).forEach(function (key) {
          if (patch[key] === null || patch[key] === '' || patch[key] === undefined) delete next[key];
          else next[key] = patch[key];
        });
        if (Object.keys(next).length) t.cellStyles[k] = next;
        else delete t.cellStyles[k];
        if (!Object.keys(t.cellStyles).length) delete t.cellStyles;
        return next;
      },

      /**
       * Apply a border command over a rectangle.
       *
       * The range arithmetic happens here, once, and what it leaves behind is
       * per-cell edges. A cell that is the master of a merge is measured by the
       * whole region: the node that draws its border reaches the far side of the
       * span, so its own column being short of the range's edge means nothing.
       */
      applyBorder: function (t, rect, kind, pen) {
        var n = AIOS.grid.table.size(t);
        var range = {
          c0: Math.max(0, rect.c0), r0: Math.max(0, rect.r0),
          c1: Math.min(n.cols - 1, rect.c1), r1: Math.min(n.rows - 1, rect.r1)
        };
        var touched = 0;
        for (var r = range.r0; r <= range.r1; r++) {
          for (var c = range.c0; c <= range.c1; c++) {
            var master = AIOS.grid.at(t.merges, c, r);
            // A cell swallowed by a merge draws nothing, so it is given nothing.
            if (master && (master.c0 !== c || master.r0 !== r)) continue;
            var own = master || { c0: c, r0: r, c1: c, r1: r };
            var changes = AIOS.borders.edgesFor(kind, own, range, pen);
            var was = AIOS.grid.table.styleAt(t, c, r).border;
            var now = AIOS.borders.patch(was, changes);
            if (!AIOS.borders.same(was, now)) touched++;
            AIOS.grid.table.setStyleAt(t, c, r, { border: now });
          }
        }
        return touched;
      },

      /** Shade a rectangle, or clear it when `hex` is empty. */
      applyFill: function (t, rect, hex) {
        var colour = AIOS.palette.hexOf(hex) || null;
        var n = AIOS.grid.table.size(t);
        var count = 0;
        for (var r = Math.max(0, rect.r0); r <= Math.min(n.rows - 1, rect.r1); r++) {
          for (var c = Math.max(0, rect.c0); c <= Math.min(n.cols - 1, rect.c1); c++) {
            AIOS.grid.table.setStyleAt(t, c, r, { bg: colour });
            count++;
          }
        }
        return count;
      },

      /**
       * Merge a rectangle, keeping only the top-left cell's text.
       *
       * Returns how many cells' contents were discarded, so the caller can say so:
       * losing what was in the other cells is the one part of merging that
       * surprises people, and undo cannot volunteer itself.
       */
      merge: function (t, rect) {
        var n = AIOS.grid.table.size(t);
        var q = {
          c0: Math.max(0, rect.c0), r0: Math.max(0, rect.r0),
          c1: Math.min(n.cols - 1, rect.c1), r1: Math.min(n.rows - 1, rect.r1)
        };
        if (q.c0 === q.c1 && q.r0 === q.r1) throw new Error('只有一格，沒有東西可以合併');
        var lost = 0;
        AIOS.grid.covered(q).forEach(function (rc) {
          var row = t.rows[rc[0]];
          if (!row) return;
          if (row[rc[1]]) lost++;
          row[rc[1]] = '';
        });
        t.merges = AIOS.grid.merge(t.merges, q);
        return lost;
      },

      unmerge: function (t, rect) {
        var hit = AIOS.grid.within(t.merges, rect);
        if (!hit.length) throw new Error('這裡沒有合併的儲存格');
        t.merges = AIOS.grid.clear(t.merges, rect);
        return hit.length;
      }
    }
  };

  /* =======================================================================
     Pictures
     ---------------------------------------------------------------------
     One MIME table for the whole shell.

     Every surface that shows a picture has the same problem and only one route
     out of it. This document is file://, the sandbox has no URL scheme of its
     own, and the shell's CSP allows `img-src 'self' data:` -- so bytes read
     through the bridge and turned into a data URL is how a sandbox image
     reaches the screen. There is no cheaper path to discover later.

     Kept here rather than copied into each application because two tables drift:
     one of them learns about a format and the other keeps rejecting it, and the
     bug reads as "this picture works in the document but not in the deck".

     Deliberately no SVG. An SVG is a document, not a bitmap, and the ones that
     arrive here come from files the machine has marked untrusted. The browser
     will not run script inside <img>, but there is no reason to lean on that.

     Reads are cached. A picture on a slide is re-rendered on every keystroke,
     and pushing a megabyte through IPC each time would make typing stutter. The
     cached entry remembers the file's size, so replacing a picture with one of a
     different size shows the new one rather than the stale bytes.
     ===================================================================== */

  AIOS.images = (function () {
    var cache = {};                        // vpath -> { url, bytes, at }
    var inflight = {};                     // vpath -> Promise, so reads coalesce
    var held = 0;                          // approximate bytes of data URL held
    var HOLD = 64 * 1024 * 1024;

    function drop(vpath) {
      var c = cache[vpath];
      if (!c) return;
      held -= c.url.length;
      delete cache[vpath];
    }

    /** Oldest out first, so a long editing session does not grow without end. */
    function trim() {
      var keys = Object.keys(cache).sort(function (a, b) { return cache[a].at - cache[b].at; });
      while (held > HOLD && keys.length) drop(keys.shift());
    }

    return {
      EXT: /\.(png|jpe?g|gif|webp|bmp|avif)$/i,

      MIME: {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif'
      },

      /* Below the sandbox's own 32 MiB per-file ceiling: a picture this big on a
         slide is a mistake, and holding several of them as base64 is worse. */
      MAX_BYTES: 24 * 1024 * 1024,

      /** The MIME type this path claims by its extension, or null. */
      mimeFor: function (vpath) {
        var bare = String(vpath || '').split('#')[0].split('?')[0];
        var m = bare.match(AIOS.images.EXT);
        return m ? (AIOS.images.MIME[m[1].toLowerCase()] || null) : null;
      },

      /**
       * A cached data URL, or null. Synchronous, for renderers that have to
       * return a node now and fill the picture in afterwards.
       */
      peek: function (vpath) {
        var c = cache[vpath];
        if (!c) return null;
        var e = AIOS.fs.entry(vpath);
        if (e && e.bytes !== c.bytes) { drop(vpath); return null; }
        c.at = Date.now();
        return c.url;
      },

      /**
       * Read and encode, resolving { ok, url, bytes } or { ok: false, error }.
       *
       * Concurrent callers for the same path share one read. A slide's picture is
       * asked for by the stage, the thumbnail and sometimes the presenter view in
       * the same frame, and three copies of the same megabyte over IPC is three
       * times the stall for one result.
       */
      dataUrl: function (vpath) {
        var p = String(vpath || '');
        var hit = AIOS.images.peek(p);
        if (hit) return Promise.resolve({ ok: true, url: hit, bytes: cache[p].bytes, cached: true });
        if (inflight[p]) return inflight[p];

        var mime = AIOS.images.mimeFor(p);
        if (!mime) return Promise.resolve({ ok: false, error: '不支援這個圖片格式' });

        inflight[p] = (async function () {
          try {
            var r = await window.aios.fs.readBytes(p);
            if (!r.ok) return { ok: false, error: r.error || '讀不到' };
            if (r.data.bytes > AIOS.images.MAX_BYTES) {
              return { ok: false, error: '圖片太大（上限 ' + bytes(AIOS.images.MAX_BYTES) + '）' };
            }
            var url = 'data:' + mime + ';base64,' + r.data.base64;
            cache[p] = { url: url, bytes: r.data.bytes, at: Date.now() };
            held += url.length;
            trim();
            return { ok: true, url: url, bytes: r.data.bytes };
          } finally {
            delete inflight[p];
          }
        })();
        return inflight[p];
      },

      forget: drop,

      clear: function () { cache = {}; held = 0; }
    };
  })();

  /**
   * Ask the user to pick a file that is already in the sandbox.
   *
   * The mirror of saveAsPath, and needed for the same reason: applications that
   * insert a picture, or attach a file, need a path the user chose, and typing
   * one from memory is not a feature. The list comes from the cached tree, so
   * this costs no IPC until something is previewed.
   *
   * Importing is offered inside the picker because the honest answer to "insert
   * a picture" is usually a file that is not in the sandbox yet, and sending the
   * user away to the file manager to fetch it first loses their place.
   *
   * Resolves with a sandbox path, or null when the user backs out.
   */
  AIOS.openPath = function (opts) {
    var o = opts || {};
    var host = o.host || document.getElementById('desktop');
    var filter = o.filter || null;
    var wantPreview = o.preview !== false;

    return new Promise(function (resolve) {
      AIOS.menu.close();
      var scrim = el('div', 'ui-menu-scrim');
      var box = el('div', 'ui-pick');

      box.appendChild(el('label', 'ui-prompt-label', o.label || '選擇檔案'));
      if (o.note) box.appendChild(el('p', 'ui-prompt-note', o.note));

      var search = el('input', 'ui-prompt-input ui-pick-search');
      search.placeholder = '過濾檔名或路徑';
      search.setAttribute('aria-label', '過濾檔案');
      box.appendChild(search);

      var cols = el('div', 'ui-pick-cols');
      var list = el('div', 'ui-pick-list');
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', '沙箱檔案');
      cols.appendChild(list);

      var preview = null;
      if (wantPreview) {
        preview = el('div', 'ui-pick-preview');
        cols.appendChild(preview);
      }
      box.appendChild(cols);

      var row = el('div', 'ui-prompt-row');
      var imp = el('button', 'fbtn', '從電腦匯入…');
      imp.type = 'button';
      imp.title = '開啟系統檔案對話框，把檔案複製進沙箱的 ' + (o.importInto || '/inbox');
      var spacer = el('span', 'ui-pick-spacer');
      var cancel = el('button', 'fbtn', T('cancel', '取消'));
      cancel.type = 'button';
      var ok = el('button', 'fbtn fbtn-primary', o.okLabel || T('choose', '選擇'));
      ok.type = 'button';
      row.appendChild(imp);
      row.appendChild(spacer);
      row.appendChild(cancel);
      row.appendChild(ok);
      box.appendChild(row);

      scrim.appendChild(box);
      host.appendChild(scrim);

      var shown = [];
      var at = -1;

      function keep(f) {
        if (!filter) return true;
        if (typeof filter === 'function') return !!filter(f.vpath);
        return filter.test(f.vpath);
      }

      function build(prefer) {
        var q = search.value.trim().toLowerCase();
        shown = (AIOS.fs.cache.files || [])
          .filter(function (f) {
            return keep(f) && (!q || f.vpath.toLowerCase().indexOf(q) >= 0);
          })
          .sort(function (a, b) { return a.vpath.localeCompare(b.vpath); })
          .slice(0, 400);

        list.innerHTML = '';
        if (!shown.length) {
          list.appendChild(el('p', 'ui-pick-empty',
            q ? '沒有符合「' + search.value.trim() + '」的檔案'
              : '沙箱裡沒有可用的檔案。按「從電腦匯入…」帶一個進來。'));
          at = -1;
          paint();
          return;
        }

        shown.forEach(function (f, i) {
          var item = el('button', 'ui-pick-item');
          item.type = 'button';
          item.setAttribute('role', 'option');
          var name = f.vpath.slice(f.vpath.lastIndexOf('/') + 1);
          var dir = f.vpath.slice(0, f.vpath.lastIndexOf('/')) || '/';
          item.appendChild(el('span', 'ui-pick-name', name));
          item.appendChild(el('span', 'ui-pick-dir', dir));
          item.appendChild(el('span', 'ui-pick-bytes',
            bytes(f.bytes) + (f.untrusted ? '　不可信' : '')));
          item.addEventListener('click', function () { at = i; paint(); });
          item.addEventListener('dblclick', function () { at = i; choose(); });
          list.appendChild(item);
        });

        var want = prefer ? shown.findIndex(function (f) { return f.vpath === prefer; }) : -1;
        at = want >= 0 ? want : 0;
        paint();
      }

      var previewFor = null;

      function paint() {
        [].forEach.call(list.children, function (n, i) {
          if (n.classList) n.classList.toggle('on', i === at);
        });
        var f = shown[at];
        ok.disabled = !f;
        if (f && list.children[at] && list.children[at].scrollIntoView) {
          list.children[at].scrollIntoView({ block: 'nearest' });
        }
        if (!preview) return;

        preview.innerHTML = '';
        if (!f) { preview.appendChild(el('span', 'ui-pick-ph', '沒有選擇')); return; }

        preview.appendChild(el('span', 'ui-pick-ph-path', f.vpath));
        if (!AIOS.images.mimeFor(f.vpath)) {
          preview.appendChild(el('span', 'ui-pick-ph', '（不是圖片，沒有預覽）'));
          return;
        }

        var img = el('img', 'ui-pick-img');
        img.alt = f.vpath;
        preview.appendChild(img);
        previewFor = f.vpath;
        AIOS.images.dataUrl(f.vpath).then(function (r) {
          // A fast clicker can move on before the bytes arrive; only the
          // still-selected file may paint.
          if (previewFor !== f.vpath || !img.parentNode) return;
          if (!r.ok) {
            img.replaceWith(el('span', 'ui-pick-ph', r.error));
            return;
          }
          img.src = r.url;
        });
      }

      function done(v) {
        document.removeEventListener('keydown', keys, true);
        scrim.remove();
        resolve(v);
      }
      function choose() {
        var f = shown[at];
        if (f) done(f.vpath);
      }
      function move(d) {
        if (!shown.length) return;
        at = Math.max(0, Math.min(shown.length - 1, at + d));
        paint();
      }
      function keys(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); choose(); }
      }

      search.addEventListener('input', function () { build(); });
      ok.addEventListener('click', choose);
      cancel.addEventListener('click', function () { done(null); });
      scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) done(null); });
      document.addEventListener('keydown', keys, true);

      imp.addEventListener('click', async function () {
        imp.disabled = true;
        try {
          var d = await AIOS.userImport(o.importInto || '/inbox', { quiet: true });
          var landed = d && d.imported && d.imported.filter(function (f) {
            return keep({ vpath: f.vpath });
          });
          // Land on what they just brought in, and clear the filter so it is
          // not hidden by a search from before the import.
          if (landed && landed.length) search.value = '';
          build(landed && landed.length ? landed[0].vpath : null);
          if (d && d.imported && d.imported.length && !(landed && landed.length)) {
            log('匯入的檔案不符合這個選擇器要的格式', 't-warn');
          }
        } finally {
          imp.disabled = false;
          search.focus();
        }
      });

      build(o.current || null);
      search.focus();
    });
  };

  /** Run an op from a UI gesture, reporting failures the same way the pipeline does. */
  AIOS.run = async function (op, args) {
    try {
      var out = await AIOS.exec[op](args || {});
      if (out && out.note) log('exec ' + op + ' — ' + out.note, 't-ok');
      return out;
    } catch (e) {
      log('fail ' + op + ' — ' + (e.message || e), 't-err');
      return null;
    }
  };


  /* =======================================================================
     Op executors
     ---------------------------------------------------------------------
     One function per entry in the kernel's syscall table. Each returns
     { note, undo?, tainted? }; throwing marks the action failed, and the
     message goes back into context so the repair round can use it.

     Authority is not decided here. Filesystem, mail and web calls are gated
     inside the main process, so these executors are free to be straight-line
     code that reports what came back.
     ===================================================================== */

  /* ######################################################### datasets #### */

  /**
   * Where a batch gets its rows, and how a template becomes one call's arguments.
   *
   * Two sources, both things the machine already produces: a file in the sandbox
   * (CSV or JSON), or rows handed over inline. A spreadsheet reaches this by
   * exporting itself first -- `app.do {sheets, exportAs, {format:"csv"}}` -- so
   * the parts compose instead of this needing to know about workbooks.
   */
  AIOS.rows = {
    async load(a) {
      if (Array.isArray(a.rows)) return a.rows.filter(function (r) { return r && typeof r === 'object'; });

      var file = String(a.file || '').trim();
      if (!file) throw new Error('要給 file（沙箱裡的 .csv 或 .json）或 rows（直接給陣列）');

      var res = await window.aios.fs.read(file);
      if (!res.ok) throw new Error('讀不到 ' + file + '：' + res.error);
      var text = res.data.content || '';

      if (/\.json$/i.test(file)) {
        var parsed;
        try { parsed = JSON.parse(text); } catch (e) { throw new Error(file + ' 不是合法的 JSON'); }
        var arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.rows) ? parsed.rows : null);
        if (!arr) throw new Error(file + ' 裡沒有陣列');
        return arr.filter(function (r) { return r && typeof r === 'object'; });
      }

      var conv = await window.aios.office.convert('csv->rows', text);
      if (!conv.ok) throw new Error('CSV 解析失敗：' + conv.error);
      var grid = conv.data || [];
      if (grid.length < 2) throw new Error(file + ' 只有標題列或是空的');

      /* The first row is the header, and the header is what the template names.
         Positional templates ({{3}}) would break the moment a column moved. */
      var head = grid[0].map(function (h, i) { return String(h || '').trim() || ('欄' + (i + 1)); });
      return grid.slice(1)
        .filter(function (r) { return r.some(function (c) { return String(c || '').trim(); }); })
        .map(function (r) {
          var obj = {};
          head.forEach(function (h, i) { obj[h] = r[i] === undefined ? '' : r[i]; });
          return obj;
        });
    },

    /**
     * `{{欄位}}` becomes that row's value, everywhere in the arguments.
     *
     * A name that is not a column is left as it is rather than becoming an empty
     * string: a filename that silently loses a field is worse than one that
     * still shows `{{編號}}` and can be corrected.
     */
    fill(args, row, index) {
      function one(v) {
        if (typeof v === 'string') {
          return v.replace(/\{\{\s*([^}]+?)\s*\}\}/g, function (whole, key) {
            if (key === '#') return String(index + 1);
            return Object.prototype.hasOwnProperty.call(row, key) ? String(row[key]) : whole;
          });
        }
        if (Array.isArray(v)) return v.map(one);
        if (v && typeof v === 'object') {
          var out = {};
          Object.keys(v).forEach(function (k) { out[k] = one(v[k]); });
          return out;
        }
        return v;
      }
      return one(args);
    }
  };

  AIOS.exec = {

    /* ------------------------------------------------------ applications */

    'app.open': async function (a) {
      var name = String(a.app || '').toLowerCase().trim();
      var def = AIOS.apps.get(name) || AIOS.apps.get('gen:' + name) ||
        AIOS.apps.list().find(function (d) { return d.name === a.app; });
      if (!def) {
        throw new Error('沒有這個程式：' + a.app + '。可用的有：' +
          AIOS.apps.list().map(function (d) { return d.id; }).join('、'));
      }
      /* Same rule as opening a file from anywhere else: naming a document asks
         to see it, and `launch` keys windows by document, so the model asking
         twice for one path brings the window forward rather than stacking a
         second copy of it that would later save over the first. */
      await AIOS.apps.launch(def.id, a.arg, { forceNew: false });
      return { note: '開啟「' + def.name + '」' + (a.arg ? '（' + a.arg + '）' : '') };
    },

    /**
     * Call one of an application's published actions.
     *
     * The bridge between the two levels of verb this machine has. Syscalls could
     * open the spreadsheet and could send mail; the spreadsheet's own verbs --
     * addSheet, setRange, exportAs -- were reachable only from its chat panel.
     * A request that crosses both ("split this workbook and mail each person")
     * had nowhere to be expressed.
     *
     * It grants nothing new: every action already runs when a person clicks the
     * app's own buttons, and the dangerous parts of one (a write, a send) pass
     * the same gate they always did. What it removes is the wall between the
     * kernel's vocabulary and the applications'.
     */
    'app.do': async function (a) {
      var name = String(a.app || '').toLowerCase().trim();
      var def = AIOS.apps.get(name) || AIOS.apps.get('gen:' + name) ||
        AIOS.apps.list().find(function (d) { return d.name === a.app; });
      if (!def) {
        throw new Error('沒有這個程式：' + a.app + '。可用的有：' +
          AIOS.apps.list().map(function (d) { return d.id; }).join('、'));
      }

      var action = String(a.action || '').trim();
      var known = Object.keys(def.actions || {});
      if (!action) throw new Error('沒有說要做什麼。「' + def.name + '」可以做：' + known.join('、'));
      if (!def.actions || !def.actions[action]) {
        throw new Error('「' + def.name + '」沒有 ' + action + ' 這個動作。可以做：' +
          (known.join('、') || '（這個程式沒有發布任何動作）'));
      }

      /* Open it first if it is not already: an action needs a window to act in,
         and asking the user to open it themselves would make every chain start
         with a step they have to do by hand. */
      var live = AIOS.apps.instances().filter(function (i) { return i.def.id === def.id; });
      if (!live.length) {
        await AIOS.apps.launch(def.id, undefined, { forceNew: false });
        // Give mount() a moment to finish; a freshly opened app has no ctx.api yet.
        for (var w = 0; w < 40 && !AIOS.apps.instances().some(function (i) {
          return i.def.id === def.id && i.ctx && i.ctx.api;
        }); w++) await wait(100);
      }

      /* The action's arguments, wherever the planner put them. The signature
         is {app, action, args}, and the planner wrote {app, action, request}
         -- the argument beside the action instead of inside args -- so the
         forge's create action received nothing and answered 「沒有描述需求」.
         A key that is not app or action can only have been meant for the
         action, so when args is absent the rest of the object is the args. */
      var args = a.args && typeof a.args === 'object' ? a.args : null;
      if (!args) {
        args = {};
        Object.keys(a).forEach(function (k) {
          if (k !== 'app' && k !== 'action' && k !== 'args') args[k] = a[k];
        });
      }
      var out = await AIOS.apps.invoke(def.id, action, args);
      return {
        note: def.name + '：' + action + ((out && out.note) ? ' — ' + out.note : ''),
        data: out
      };
    },

    /**
     * Run one operation once per row of a dataset.
     *
     * Not a loop construct -- that would be inventing a programming language in
     * the plan format. It is the one shape that kept being needed and could not
     * be written: a hundred rows means a hundred files or a hundred messages,
     * and a plan is a flat list capped at six steps.
     *
     * The loop is mechanical and the template is written once. That is what
     * makes it affordable: a hundred rows is one model call, not a hundred.
     *
     * Anything irreversible done a hundred times is confirmed once, with the
     * whole list on screen -- asked and granted by the main process, which is
     * the only one entitled to approve anything. A prompt per row would be
     * a hundred clicks, and nobody reads the tenth.
     */
    'data.each': async function (a) {
      var op = String(a.op || '').trim();
      if (!op) throw new Error('沒有說要對每一列做什麼（op）');
      if (op === 'data.each') throw new Error('data.each 不能套自己');
      if (!AIOS.exec[op]) throw new Error('不認得的 op：' + op);

      var rows = await AIOS.rows.load(a);
      if (!rows.length) throw new Error('沒有讀到任何資料列');
      var MAX = 500;
      if (rows.length > MAX) {
        throw new Error('資料有 ' + rows.length + ' 列，超過一次 ' + MAX + ' 列的上限。' +
          '先縮小範圍，或分批處理。');
      }

      /* Fill the template for every row up front, so what is about to happen can
         be shown in full before any of it happens. */
      var planned = rows.map(function (row, i) {
        return { row: row, index: i, args: AIOS.rows.fill(a.args || {}, row, i) };
      });

      var spec = AIOS.OPS[op] || {};
      var elevated = spec.cap && AIOS.ELEVATED.indexOf(spec.cap) >= 0;
      var chosen = planned;

      if (elevated) {
        /* One decision, with everything it covers visible -- and taken in the
           main process, which is the only one entitled to grant anything. The
           shell may ask and may display; it may not approve.

           Asking here also settles a collision found the hard way: reading the
           source file arms the taint downgrade, so without a batch grant every
           one of the hundred writes would have asked separately. That is exactly
           the hundred dialogs this is meant to replace, arriving by another
           route. */
        var verdict = await window.aios.gate.askBatch(op, planned.map(function (p) { return p.args; }),
          spec.desc || op);
        if (!verdict.ok || !verdict.data.ok) {
          return { note: '已取消：' + op + ' × ' + planned.length + ' 沒有執行' +
            (verdict.data && verdict.data.reason ? '（' + verdict.data.reason + '）' : '') };
        }
        var keepSet = {};
        (verdict.data.indices || []).forEach(function (i) { keepSet[i] = true; });
        chosen = planned.filter(function (p) { return keepSet[p.index]; });
        if (!chosen.length) return { note: '全部取消勾選了，沒有執行任何一列' };
      }

      var done = 0;
      var failed = [];
      for (var i = 0; i < chosen.length; i++) {
        var item = chosen[i];
        AIOS.ui.trace('data.each ' + op + '　' + (i + 1) + '/' + chosen.length, 't-info');
        try {
          await AIOS.exec[op](item.args);
          done++;
        } catch (e) {
          failed.push('第 ' + (item.index + 1) + ' 列：' + (e.message || e));
          /* Stop at the first failure. The rows are usually one job, and
             carrying on after a failure means finishing with a result nobody can
             describe -- ninety-three of a hundred, with the gap somewhere in the
             middle. */
          break;
        }
      }

      var note = op + ' 完成 ' + done + ' / ' + chosen.length + ' 列';
      if (failed.length) note += '，在此中止：' + failed.join('；');
      if (chosen.length < planned.length) {
        note += '（原本 ' + planned.length + ' 列，你取消了 ' + (planned.length - chosen.length) + ' 列）';
      }
      return { note: note };
    },

    /* Delegates to the forge, which owns the whole spec-code-check-install
       sequence and shows it happening. */
    'app.create': async function (a) {
      /* The user's own words when the planner passed them on; the name and
         purpose it wrote otherwise. A build planned from a one-line purpose
         drops whatever the paragraph said. */
      var request = String(a.request || '').trim() ||
        [a.name, a.purpose].filter(Boolean).join('：');
      if (!request) throw new Error('沒有說要做什麼程式');

      await AIOS.apps.launch('forge');
      var inst = AIOS.apps.instances().find(function (i) { return i.def.id === 'forge'; });
      if (!inst || !inst.ctrl || !inst.ctrl.api) throw new Error('App Forge 還沒準備好，請再試一次');

      return { note: await inst.ctrl.api.create(request) };
    },

    'surface.close': async function (a) {
      var w = AIOS.wm.find(a.title);
      if (!w) throw new Error('找不到視窗：' + a.title);
      AIOS.wm.close(w);
      return { note: '關閉視窗「' + w.title + '」' };
    },

    'surface.arrange': async function (a) {
      var layout = String(a.layout || 'grid').toLowerCase();
      var n = layout === 'focus' ? AIOS.wm.focusLayout()
            : layout === 'stack' ? AIOS.wm.stack()
            : AIOS.wm.tile();
      return { note: '以 ' + layout + ' 重排 ' + n + ' 個視窗' };
    },

    /* ------------------------------------------------------------- files */

    'fs.list': async function (a) {
      var dir = String(a.dir || '/');
      var res = await window.aios.fs.list(dir);
      if (!res.ok && res.code === 'ENOENT') res = await window.aios.fs.list('/');
      if (!res.ok) throw ipcFail(res, '列出目錄失敗');
      await AIOS.apps.launch('files', res.data.vpath);
      return { note: '列出 ' + res.data.vpath + '（' + res.data.entries.length + ' 個項目）' };
    },

    /**
     * Search, and put the hits in context rather than only in the trace.
     *
     * The lines are the point. A list of paths makes the next round open each
     * one to find out which was the right file; a matching line usually settles
     * it without a second read, which is the difference between one round and
     * five. The result is a `data` page for the same reason a file read is: it
     * is content the plan could not have had when it was written.
     */
    'fs.find': async function (a) {
      var q = String(a.query || '').trim();
      if (!q) throw new Error('沒有給搜尋字串');
      var res = await window.aios.fs.find(q, { dir: a.dir });
      if (!res.ok) throw ipcFail(res, '搜尋失敗');
      var d = res.data;

      var body = d.hits.length
        ? d.hits.map(function (h) {
          var head = h.vpath + (h.untrusted ? '（不可信）' : '');
          return h.lines.length
            ? head + '\n' + h.lines.map(function (l) { return '  L' + l.line + '  ' + l.text; }).join('\n')
            : head + '（檔名符合）';
        }).join('\n')
        : '（沒有符合的檔案）';

      K.page('data/find:' + q, {
        kind: 'data', label: 'find/' + q, priority: 45,
        text: '搜尋「' + q + '」在 ' + d.dir + ' 的結果：\n' + body
      });
      AIOS.ui.renderContext(K.schedule());

      var note = '搜尋「' + q + '」：' + d.hits.length + ' 個檔案命中' +
        (d.scanned ? '（讀了 ' + d.scanned + ' 個檔案的內容）' : '');
      /* Say when the search stopped early. One that quietly gave up reports
         「找不到」 about a file that is sitting right there. */
      if (d.truncated) note += '　⚠ 已達上限，還有沒搜到的';
      if (d.skippedBig) note += '　（' + d.skippedBig + ' 個檔案太大，只比對了檔名）';
      return { note: note };
    },

    'fs.read': async function (a) {
      var vpath = AIOS.fs.resolve(a.path);
      var res = await window.aios.fs.read(vpath);
      if (!res.ok) throw ipcFail(res, '讀取失敗');
      var f = res.data;

      if (f.binary) {
        return { note: '讀取 ' + f.vpath + '（二進位 ' + bytes(f.bytes) + '，未進 context）' };
      }

      openFileWindow(f.vpath, f.content, f.untrusted);

      K.page('data/' + f.vpath, {
        kind: 'data', label: 'data' + f.vpath, priority: 44,
        text: f.content, tainted: !!f.untrusted, source: f.vpath
      });

      if (f.untrusted) {
        await K.refreshTaint();
        log('taint: ' + f.vpath + ' 標記為不可信，' + AIOS.ELEVATED.join('/') + ' 授權降級', 't-taint');
      }
      return {
        note: '讀取 ' + f.vpath + '（' + bytes(f.bytes) + (f.untrusted ? '，不可信' : '') + '）',
        tainted: !!f.untrusted,
        undo: function () { K.drop('data/' + f.vpath); }
      };
    },

    /* Open a file with whichever application claims its extension. */
    'fs.open': async function (a) {
      var vpath = AIOS.fs.resolve(a.path);
      if (!AIOS.fs.entry(vpath)) {
        var listing = AIOS.fs.cache.dirs || [];
        if (listing.indexOf(vpath) < 0) throw new Error('找不到：' + a.path);
      }
      await AIOS.apps.openPath(vpath);
      var def = AIOS.apps.forPath(vpath);
      return { note: '用「' + (def ? def.name : '編輯器') + '」開啟 ' + vpath };
    },

    'fs.write': async function (a) {
      if (looksLikePlaceholder(a.content)) {
        throw new Error('content 是佔位符而不是真正的內容；要複製檔案請改用 fs.copy {from, to}');
      }
      var vpath = AIOS.fs.resolve(a.path || '/notes/未命名.txt');
      var content = String(a.content == null ? '' : a.content);

      var before = null;
      if (AIOS.fs.entry(vpath)) {
        var prev = await window.aios.fs.read(vpath);
        if (prev && prev.ok) before = prev.data.content;
      }

      var res = await window.aios.fs.write(vpath, content);
      if (!res.ok) throw ipcFail(res, '寫入失敗');
      await AIOS.afterFsChange();
      openFileWindow(res.data.vpath, content, false);

      return {
        note: (res.data.created ? '建立' : '覆寫') + ' ' + res.data.vpath +
              '（' + bytes(res.data.bytes) + '）',
        undo: async function () {
          if (before === null) await window.aios.fs.remove(res.data.vpath);
          else await window.aios.fs.write(res.data.vpath, before);
          await AIOS.afterFsChange();
          var w = AIOS.wm.find(res.data.vpath.split('/').pop());
          if (w) AIOS.wm.close(w);
        }
      };
    },

    'fs.copy': async function (a) {
      var from = AIOS.fs.resolve(a.from);
      var to = String(a.to || '').trim();
      if (!to) throw new Error('沒有給目標路徑');

      var existed = !!AIOS.fs.entry(to);
      var before = null;
      if (existed) {
        var prev = await window.aios.fs.read(to);
        if (prev && prev.ok) before = prev.data.content;
      }

      var res = await window.aios.fs.copy(from, to);
      if (!res.ok) throw ipcFail(res, '複製失敗');
      await AIOS.afterFsChange();

      return {
        note: '複製 ' + res.data.from + ' → ' + res.data.to + '（' + bytes(res.data.bytes) + '）',
        undo: async function () {
          if (before === null) await window.aios.fs.remove(res.data.to);
          else await window.aios.fs.write(res.data.to, before);
          await AIOS.afterFsChange();
        }
      };
    },

    'fs.move': async function (a) {
      var from = AIOS.fs.resolve(a.from);
      var to = String(a.to || '').trim();
      if (!to) throw new Error('沒有給目標路徑');
      var res = await window.aios.fs.move(from, to);
      if (!res.ok) throw ipcFail(res, '搬移失敗');
      await AIOS.afterFsChange();
      return {
        note: '搬移 ' + res.data.from + ' → ' + res.data.to,
        undo: async function () {
          await window.aios.fs.move(res.data.to, res.data.from);
          await AIOS.afterFsChange();
        }
      };
    },

    'fs.mkdir': async function (a) {
      var res = await window.aios.fs.mkdir(a.path);
      if (!res.ok) throw ipcFail(res, '建立目錄失敗');
      await AIOS.afterFsChange();
      return { note: '建立目錄 ' + res.data.vpath };
    },

    'fs.delete': async function (a) {
      var vpath = AIOS.fs.resolve(a.path);
      var res = await window.aios.fs.remove(vpath);
      if (!res.ok) throw ipcFail(res, '刪除失敗');
      await AIOS.afterFsChange();

      var w = AIOS.wm.find(vpath.split('/').pop());
      if (w) AIOS.wm.close(w);
      K.drop('data/' + res.data.vpath);

      return {
        note: '刪除 ' + res.data.vpath + ' → 回收桶',
        undo: async function () {
          var r = await window.aios.fs.restore(res.data.id);
          if (!r.ok) throw ipcFail(r, '還原失敗');
          await AIOS.afterFsChange();
        }
      };
    },

    /* --------------------------------------------------------------- web */

    'web.read': async function (a) {
      var res = await window.aios.web.read(a.url);
      if (!res.ok) throw ipcFail(res, '抓取失敗');
      var d = res.data;

      AIOS.wm.open({
        id: 'read:' + d.url, kind: 'READER', title: d.title.slice(0, 40), w: 560, h: 400,
        render: function (b) {
          b.appendChild(el('h3', null, d.title));
          b.appendChild(el('p', 'micro', d.url + '　·　' + bytes(d.bytes) +
            (d.extracted ? '　·　正文占比 ' + d.ratio + '%' : '')));
          b.appendChild(el('pre', 'fenced', d.text.slice(0, 40000)));
          b.appendChild(el('p', 'fence-note',
            '網頁內容來自外部，核心一律當成不可信資料。'));
        }
      });

      K.page('data/web:' + d.url, {
        kind: 'data', label: 'web/' + d.title.slice(0, 30), priority: 44,
        tainted: true, source: d.url,
        text: '網頁「' + d.title + '」（' + d.url + '）：\n' + d.text.slice(0, 12000)
      });
      await window.aios.taint.add(d.url, '網頁「' + d.title.slice(0, 60) + '」');
      await K.refreshTaint();
      log('taint: 網頁 ' + d.url + ' 進入 context，提權能力降級', 't-taint');

      return {
        note: '讀取網頁「' + d.title + '」（' + d.text.length + ' 字）',
        tainted: true,
        undo: function () { K.drop('data/web:' + d.url); }
      };
    },

    'web.open': async function (a) {
      if (!a.url) throw new Error('沒有網址');
      await AIOS.apps.launch('browser', String(a.url), { forceNew: false });
      return { note: '瀏覽器開啟 ' + a.url };
    },

    /* -------------------------------------------------------------- mail */

    'mail.list': async function (a) {
      var res = await window.aios.mail.list(a.folder || 'INBOX', a.limit || 25);
      if (!res.ok) throw ipcFail(res, '收信失敗');
      await AIOS.apps.launch('mail');
      var d = res.data;
      K.page('ui/mail', {
        kind: 'ui', label: 'ui/mail', priority: 64,
        text: '信件清單（' + d.folder + '）：\n' + d.messages.slice(0, 20).map(function (m) {
          return '  uid ' + m.uid + '　' + (m.seen ? '' : '[未讀] ') + m.from + '：' + m.subject;
        }).join('\n')
      });
      return { note: d.folder + ' 有 ' + d.total + ' 封，取回最近 ' + d.messages.length + ' 封' };
    },

    'mail.read': async function (a) {
      /* By Message-ID through the mirror when one is given -- which is what
         mail.search hands back, and the only handle a webmail source has. The
         uid form stays for plans written against the older signature. */
      var res = a.messageId
        ? await window.aios.mail.mirrorRead(String(a.messageId))
        : await window.aios.mail.read(a.folder || 'INBOX', a.uid);
      if (!res.ok) throw ipcFail(res, '讀信失敗');
      var m = res.data;
      await AIOS.apps.launch('mail', m.messageId || undefined);

      var key = 'data/mail:' + (m.messageId || m.uid);
      var files = (m.attachments || []).map(function (x) { return x.name; });
      var handle = m.handle || m.messageId;
      K.page(key, {
        kind: 'data', label: 'mail/' + String(m.subject).slice(0, 30), priority: 44,
        tainted: true, source: '信件「' + m.subject + '」',
        text: '信件（不可信來源）\n寄件人：' + m.from + '\n主旨：' + m.subject +
              (m.date ? '\n時間：' + new Date(m.date).toLocaleString('zh-TW') : '') +
              (m.messageId ? '\n連結：aios-mail:' + handle + '（原樣寫進筆記就可以直接打開這封信）' : '') +
              (files.length ? '\n附件：' + files.join('、') : '') +
              '\n內容：\n' + String(m.text || '').slice(0, 8000)
      });
      await K.refreshTaint();
      log('taint: 信件「' + m.subject + '」進入 context，提權能力降級', 't-taint');

      return {
        note: '讀取信件「' + m.subject + '」（來自 ' + m.from + '）',
        tainted: true,
        undo: function () { K.drop(key); }
      };
    },

    /* Over the mirror: subject, sender and body. The hits are how the kernel
       finds 「這禮拜 ABC 公司寄來、提到我的」 without reading every message
       into context first, and each carries an aios-mail: link so a note can
       point back at the message it came from. A body snippet is a piece of
       somebody else's mail, so the page is tainted the way a read is. */
    'mail.search': async function (a) {
      var since = a.since ? Date.parse(String(a.since)) : 0;
      var until = a.until ? Date.parse(String(a.until)) : 0;
      if (a.until && Number.isFinite(until) && /^\d{4}-\d{2}-\d{2}$/.test(String(a.until).trim())) {
        until += 86400 * 1000 - 1;    // a bare date means the whole of that day
      }
      var res = await window.aios.mail.search({
        text: a.text || '', from: a.from || '', to: a.to || '',
        since: Number.isFinite(since) ? since : 0, until: Number.isFinite(until) ? until : 0,
        folder: a.folder || null, hasAttachment: !!a.hasAttachment,
        limit: Math.min(Number(a.limit) || 30, 200),
        withBody: Math.min(Number(a.withBody) || 0, 12)
      });
      if (!res.ok) throw ipcFail(res, '搜尋失敗');
      var hits = res.data.hits || [];
      await AIOS.apps.launch('mail');

      var what = [a.text && '「' + a.text + '」', a.from && '來自 ' + a.from,
        a.since && a.since + ' 起', a.until && '到 ' + a.until].filter(Boolean).join('　');
      var key = 'data/mail-search:' + (what || 'all').slice(0, 60);
      K.page(key, {
        kind: 'data', label: 'mail-search/' + (a.text || a.from || '').slice(0, 24), priority: 46,
        tainted: hits.some(function (h) { return h.where === 'body' || h.text; }),
        source: '信件搜尋 ' + what,
        text: '信件搜尋結果（不可信來源）' + (what ? '：' + what : '') + '\n' +
          (hits.length ? hits.map(function (h, i) {
            return (i + 1) + '. ' + (h.date ? new Date(h.date).toLocaleDateString('zh-TW') : '') +
              '　' + h.from + '　' + h.subject +
              (h.hasAttachments ? '　[有附件]' : '') +
              '\n   連結：aios-mail:' + (h.handle || h.messageId) +
              (h.snippet ? '\n   內文片段：' + h.snippet : '') +
              (h.text ? '\n   內文：\n' + h.text.slice(0, 2000).split('\n').map(function (l) {
                return '     ' + l;
              }).join('\n') : '') +
              (h.bodyError ? '\n   內文取不到：' + h.bodyError : '');
          }).join('\n') : '（沒有符合的信）') +
          '\n\n要一次拿到多封信的內文，用 mail.search {withBody:N}；單獨一封用 mail.read {messageId:<上面那個編號>}。' +
          '要在筆記裡指回某封信，把上面那一行的連結原樣抄過去：[主旨](aios-mail:<編號>)。' +
          '編號只有十個字，請照抄，不要自己組一個出來——編出來的連結看起來跟真的一樣，' +
          '但是點下去什麼都不會發生。'
      });
      var readBodies = hits.some(function (h) { return h.where === 'body' || h.text; });
      if (readBodies) {
        await K.refreshTaint();
        log('taint: 信件搜尋的內文進入 context，提權能力降級', 't-taint');
      }
      return {
        note: '找到 ' + hits.length + ' 封' + (what ? '（' + what + '）' : '') +
          '，掃過 ' + (res.data.scanned || 0) + ' 封' +
          (res.data.bodies ? '，帶回 ' + res.data.bodies + ' 封的內文' : ''),
        tainted: readBodies,
        undo: function () { K.drop(key); }
      };
    },

    'mail.send': async function (a) {
      var res = await window.aios.mail.send({ to: a.to, subject: a.subject, body: a.body });
      if (!res.ok) throw ipcFail(res, '寄信失敗');
      return { note: '已寄給 ' + (res.data.accepted || []).join('、') };
    },

    /* ------------------------------------------------------------ memory */

    'memory.remember': async function (a) {
      var res = await window.aios.memory.add({
        text: a.text,
        tags: Array.isArray(a.tags) ? a.tags : (a.tags ? String(a.tags).split(/[,、]/) : ['learned']),
        source: 'learned'
      });
      if (!res.ok) throw ipcFail(res, '寫入記憶失敗');
      if (AIOS.ui) AIOS.ui.renderMemory();
      var item = res.data.item;
      return {
        note: (res.data.deduped ? '併入既有記憶：' : '記住：') + item.text.slice(0, 40),
        undo: async function () {
          await window.aios.memory.remove(item.id);
          if (AIOS.ui) AIOS.ui.renderMemory();
        }
      };
    },

    'memory.recall': async function (a) {
      var res = await window.aios.memory.search(a.query, 5);
      if (!res.ok) throw ipcFail(res, '檢索失敗');
      var hits = res.data;
      if (AIOS.ui) AIOS.ui.renderMemory(hits);
      if (!hits.length) return { note: '檢索「' + a.query + '」：沒有命中' };

      hits.forEach(function (h) {
        K.page('mem/' + h.item.id, {
          kind: 'mem', label: 'mem/' + h.item.id, priority: 60, text: h.item.text
        });
      });
      await window.aios.memory.markUsed(hits.map(function (h) { return h.item.id; }));
      log('page-in: 檢索 ' + hits.length + ' 筆記憶 → context', 't-ok');
      return {
        note: '檢索「' + a.query + '」命中 ' + hits.length + ' 筆',
        undo: function () { hits.forEach(function (h) { K.drop('mem/' + h.item.id); }); }
      };
    },

    'memory.forget': async function (a) {
      var found = await window.aios.memory.search(a.query, 3);
      if (!found.ok) throw ipcFail(found, '檢索失敗');
      if (!found.data.length) return { note: '沒有符合「' + a.query + '」的記憶' };

      var removed = [];
      for (var i = 0; i < found.data.length; i++) {
        var item = found.data[i].item;
        var r = await window.aios.memory.remove(item.id);
        if (r.ok) removed.push(item);
      }
      if (AIOS.ui) AIOS.ui.renderMemory();
      return {
        note: '忘掉 ' + removed.length + ' 筆：' + removed.map(function (x) { return x.text.slice(0, 24); }).join('；'),
        undo: async function () {
          for (var j = 0; j < removed.length; j++) {
            await window.aios.memory.add({
              text: removed[j].text, tags: removed[j].tags, source: removed[j].source
            });
          }
          if (AIOS.ui) AIOS.ui.renderMemory();
        }
      };
    },

    /* -------------------------------------------------------------- misc */

    /* The machine's own clock. The jobs live in main (main/schedule.js);
       these set, list and cancel them, and open the scheduler window so the
       person sees what was set. */
    'schedule.set': async function (a) {
      var res = await window.aios.schedule.add({
        name: a.name, every: a.every, at: a.at, intent: a.intent, app: a.app, action: a.action, args: a.args
      });
      if (!res.ok) throw ipcFail(res, '設定排程失敗');
      var j = res.data;
      await AIOS.apps.launch('schedule');
      return {
        note: '已設定排程「' + j.name + '」：' + (j.at ? '每天 ' + j.at : '每 ' + AIOS.schedule.human(j.every)) +
          (j.kind === 'intent' ? ' 規劃「' + j.intent + '」' : ' 執行 ' + j.app + '.' + j.action) +
          '（只在 AI-OS 開著時執行）',
        undo: async function () { await window.aios.schedule.remove(j.id); }
      };
    },

    'schedule.list': async function () {
      var res = await window.aios.schedule.list();
      if (!res.ok) throw ipcFail(res, '讀不到排程');
      await AIOS.apps.launch('schedule');
      var jobs = res.data;
      return {
        note: jobs.length
          ? jobs.map(function (j) {
            return j.name + '（' + (j.at ? '每天 ' + j.at : '每 ' + AIOS.schedule.human(j.every)) + (j.enabled ? '' : '，已暫停') + '）';
          }).join('、')
          : '沒有排程'
      };
    },

    'schedule.cancel': async function (a) {
      var res = await window.aios.schedule.list();
      if (!res.ok) throw ipcFail(res, '讀不到排程');
      var key = String(a.id || a.name || '').trim();
      var jobs = res.data;
      var job = jobs.find(function (j) { return j.id === key; }) ||
        jobs.find(function (j) { return j.name === key; });
      if (!job && key) {
        var pre = jobs.filter(function (j) { return j.name.indexOf(key) === 0; });
        if (pre.length === 1) job = pre[0];
      }
      if (!job) {
        throw new Error('沒有這個排程：' + key + (jobs.length ? '。現有：' + jobs.map(function (j) { return j.name; }).join('、') : ''));
      }
      var r = await window.aios.schedule.remove(job.id);
      if (!r.ok) throw ipcFail(r, '取消排程失敗');
      return { note: '已取消排程「' + job.name + '」' };
    },

    'timer.set': async function (a) {
      var secs = Math.max(1, Math.min(3600, parseInt(a.seconds, 10) || 60));
      var label = a.label || '計時器';
      var w = AIOS.wm.open({
        kind: 'TIMER', title: label, w: 280, h: 180,
        render: function (b, win) { render.timer(b, secs, label, win); }
      });
      return { note: '設定計時器 ' + secs + ' 秒（' + label + '）', undo: function () { AIOS.wm.close(w); } };
    },

    'theme.set': async function (a) {
      var mode = String(a.mode || 'void').toLowerCase();
      /* Names work too. A custom theme's id is random and nobody would type
         it; 「換成我的藍」 is how a person asks for it, and the built-ins answer
         to their own names the same way. */
      if (!AIOS.themes.has(mode)) mode = AIOS.themes.byName(a.mode) || mode;
      /* Unknown falls back to the default, and the receipt says so and lists
         what exists: a model that asked for 「我的籃」 can correct itself only if
         it is told the name did not match and what the names are. */
      var missing = !AIOS.themes.has(mode) ? String(a.mode || '') : null;
      if (!AIOS.themes.has(mode)) mode = 'void';
      /* A draft the theme editor is trying on the desktop comes off first:
         otherwise closing the editor later would put back the theme from
         before the preview and quietly undo this call. */
      if (AIOS.themes.previewing && AIOS.themes.previewing()) AIOS.themes.preview(null);
      var before = AIOS.themes.persistable();
      /* apply() rather than setting the attribute here: it also keeps the
         light-page flag that the custom themes' overrides hang off. */
      AIOS.themes.apply(mode);
      AIOS.apps.requestSave();
      var ownNames = AIOS.themes.custom.map(function (t) { return t.name; });
      /* The name a person reads, not the id. 「主題切換為 FOREST」 was the one
         place the ids leaked into the interface -- the menu, the desktop menu
         and the syscall's own description all say 深林. The id stays in the
         argument, which is where it belongs. */
      return {
        note: '主題切換為「' + AIOS.themes.labelOf(mode) + '」' +
          (missing ? '（找不到「' + missing + '」，改用預設' +
            (ownNames.length ? '；自訂主題有：' + ownNames.join('、') : '') + '）' : ''),
        /* The theme from before may have been deleted since; the default is
           the honest answer then, not an id with no palette behind it. */
        undo: function () { AIOS.themes.apply(AIOS.themes.has(before) ? before : 'void'); }
      };
    },

    'reply': async function (a) {
      var text = String(a.text || '');
      AIOS.wm.open({
        id: 'reply',
        kind: 'REPLY',
        title: '核心回覆',
        w: 460, h: 200,
        render: function (b) { render.text(b, text); }
      });
      return { note: '回覆：' + text.slice(0, 44) };
    }
  };
})();
