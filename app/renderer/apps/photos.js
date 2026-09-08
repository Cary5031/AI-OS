'use strict';

/* ===========================================================================
   AI-OS // image viewer
   ---------------------------------------------------------------------------
   The one application the machine had no answer for: a picture in the
   sandbox double-clicked in the file manager fell through to the text editor
   and showed bytes. This is the default for every raster format the shared
   image pipeline (AIOS.images) knows -- PNG, JPEG, GIF, WebP, BMP, AVIF --
   and deliberately not SVG, for the pipeline's own reason: SVG is a document,
   not a bitmap, and it arrives from untrusted files.

   Viewing, not editing. Fit-to-window or any zoom, pan by dragging, rotate,
   the previous and next picture in the same folder, and a background that
   can be switched for pictures with transparency. One window that moves from
   picture to picture (`tabs: true`), so a folder of forty photos is one
   window and the arrow keys, not forty windows.

   The bytes come through AIOS.images.dataUrl, which is the only route a
   file:// document has to a sandbox picture, and is cached and coalesced
   there. Reading a picture from /inbox arms the taint set like every other
   read of untrusted content; that is the existing rule, not this viewer's.
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
  function T(key, zh, vars) { return AIOS.i18n ? AIOS.i18n.t(key, zh, vars) : zh; }

  /* Zoom stops, so + and - land on round numbers instead of drifting. */
  var STOPS = [0.05, 0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16];
  var MAX_ZOOM = 16;
  var MIN_ZOOM = 0.05;
  var BACKGROUNDS = ['checker', 'dark', 'light'];

  function baseName(p) { return String(p || '').slice(String(p || '').lastIndexOf('/') + 1); }
  function dirName(p) { var s = String(p || ''); var i = s.lastIndexOf('/'); return i <= 0 ? '/' : s.slice(0, i); }

  /** Every picture in the same folder, sorted, from the cached tree. */
  function siblings(vpath) {
    var dir = dirName(vpath);
    return (AIOS.fs.cache.files || [])
      .map(function (f) { return f.vpath; })
      .filter(function (p) { return dirName(p) === dir && AIOS.images.EXT.test(p); })
      .sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); });
  }

  AIOS.apps.register({
    id: 'photos',
    name: '圖片檢視器',
    purpose: '看沙箱裡的圖片：縮放、旋轉、同一個資料夾裡前後張',
    icon: '◪',
    kind: 'IMAGE',
    width: 860,
    height: 620,
    singleton: false,
    /* One window that moves between pictures: a second image opened from
       the file manager lands in the viewer that is already up. */
    tabs: true,
    chatHint: '可以說「下一張」、「放大到 200%」、「轉 90 度」、「這張多大」。',

    accepts: function (p) { return AIOS.images.EXT.test(p || ''); },

    actions: {
      open: {
        args: '{path}', desc: '開啟一張圖片',
        run: async function (a, ctx) { return { note: await ctx.api.open(a.path) }; }
      },
      next: {
        args: '{}', desc: '同一個資料夾的下一張',
        run: async function (_a, ctx) { return { note: await ctx.api.step(1) }; }
      },
      prev: {
        args: '{}', desc: '同一個資料夾的上一張',
        run: async function (_a, ctx) { return { note: await ctx.api.step(-1) }; }
      },
      zoom: {
        args: '{percent}', desc: '縮放到指定百分比（例如 100、200、50）',
        run: async function (a, ctx) { return { note: ctx.api.zoomTo(Number(a.percent || a.level || 100) / 100) }; }
      },
      fit: {
        args: '{}', desc: '縮放到符合視窗',
        run: async function (_a, ctx) { return { note: ctx.api.fit() }; }
      },
      rotate: {
        args: '{degrees}', desc: '順時針旋轉（90、180、270；不給就是 90）',
        run: async function (a, ctx) { return { note: ctx.api.rotate(Number(a.degrees || 90)) }; }
      },
      info: {
        args: '{}', desc: '目前這張圖的檔名、尺寸、大小',
        run: async function (_a, ctx) { return { note: ctx.api.info() }; }
      }
    },

    mount: function (ctx) {
      ctx.body.classList.add('flush');

      var path = null;
      var natural = { w: 0, h: 0 };
      var bytes = 0;
      var zoom = 1;
      var fitted = true;
      var rotation = 0;
      var pan = { x: 0, y: 0 };
      var bgIndex = 0;
      var list = [];

      /* ---------------------------------------------------------- chrome */

      var bar = el('div', 'ph-bar');
      var nameTag = el('span', 'ph-name', T('ph.none', '（沒有開啟圖片）'));
      var btnOpen = el('button', 'fbtn', T('ph.open', '開啟…'));
      btnOpen.type = 'button';
      var btnPrev = el('button', 'fbtn', '◀');
      btnPrev.type = 'button';
      btnPrev.title = T('ph.prev', '上一張（←）');
      var btnNext = el('button', 'fbtn', '▶');
      btnNext.type = 'button';
      btnNext.title = T('ph.next', '下一張（→）');
      var counter = el('span', 'ph-counter', '');
      var btnOut = el('button', 'fbtn', '−');
      btnOut.type = 'button';
      btnOut.title = T('ph.zoomOut', '縮小（-）');
      var zoomTag = el('button', 'fbtn ph-zoom', '100%');
      zoomTag.type = 'button';
      zoomTag.title = T('ph.zoomToggle', '在「符合視窗」和「100%」之間切換（雙擊圖片也可以）');
      var btnIn = el('button', 'fbtn', '+');
      btnIn.type = 'button';
      btnIn.title = T('ph.zoomIn', '放大（+）');
      var btnFit = el('button', 'fbtn', T('ph.fit', '符合視窗'));
      btnFit.type = 'button';
      btnFit.title = T('ph.fitTitle', '縮放到整張看得到（0）');
      var btnOne = el('button', 'fbtn', '1:1');
      btnOne.type = 'button';
      btnOne.title = T('ph.oneTitle', '實際大小（1）');
      var btnRotate = el('button', 'fbtn', '↻');
      btnRotate.type = 'button';
      btnRotate.title = T('ph.rotate', '順時針轉 90 度（r）');
      var btnBg = el('button', 'fbtn', '▨');
      btnBg.type = 'button';
      btnBg.title = T('ph.bg', '切換背景：棋盤／深色／淺色（透明圖片用）');
      var btnReveal = el('button', 'fbtn', T('ph.reveal', '在作業系統顯示'));
      btnReveal.type = 'button';
      [nameTag, btnOpen, btnPrev, counter, btnNext, btnOut, zoomTag, btnIn, btnFit, btnOne, btnRotate, btnBg, btnReveal]
        .forEach(function (n) { bar.appendChild(n); });
      ctx.body.appendChild(bar);

      var stage = el('div', 'ph-stage ph-bg-checker');
      stage.tabIndex = 0;
      stage.setAttribute('role', 'img');
      var img = el('img', 'ph-img');
      img.alt = '';
      img.draggable = false;
      img.hidden = true;
      stage.appendChild(img);
      var empty = el('div', 'ph-empty');
      empty.appendChild(el('p', null, T('ph.emptyText', '還沒有開啟圖片。從檔案總管點開一張，或按「開啟…」從沙箱挑。')));
      stage.appendChild(empty);
      var errBox = el('p', 'ph-error');
      errBox.hidden = true;
      stage.appendChild(errBox);
      ctx.body.appendChild(stage);

      var status = el('div', 'ph-status', '');
      ctx.body.appendChild(status);

      /* --------------------------------------------------------- geometry */

      /** The picture's box after rotation, in natural pixels. */
      function turned() {
        var q = ((rotation % 360) + 360) % 360;
        return q === 90 || q === 270 ? { w: natural.h, h: natural.w } : { w: natural.w, h: natural.h };
      }

      /** The zoom that shows the whole picture, never above 100%. */
      function fitZoom() {
        var t = turned();
        if (!t.w || !t.h) return 1;
        var r = stage.getBoundingClientRect();
        var pad = 16;
        return Math.max(MIN_ZOOM, Math.min(1, (r.width - pad) / t.w, (r.height - pad) / t.h));
      }

      function clampPan() {
        var t = turned();
        var r = stage.getBoundingClientRect();
        var w = t.w * zoom;
        var h = t.h * zoom;
        /* A picture smaller than the stage sits centred; one larger can be
           dragged until its edge meets the stage's edge, no further. */
        var maxX = Math.max(0, (w - r.width) / 2);
        var maxY = Math.max(0, (h - r.height) / 2);
        pan.x = Math.max(-maxX, Math.min(maxX, pan.x));
        pan.y = Math.max(-maxY, Math.min(maxY, pan.y));
      }

      function paint() {
        if (!path || !natural.w) return;
        clampPan();
        img.style.transform = 'translate(' + pan.x + 'px, ' + pan.y + 'px) scale(' + zoom + ') rotate(' + rotation + 'deg)';
        zoomTag.textContent = Math.round(zoom * 100) + '%';
        stage.classList.toggle('ph-pannable', canPan());
        renderStatus();
      }

      function canPan() {
        var t = turned();
        var r = stage.getBoundingClientRect();
        return t.w * zoom > r.width + 1 || t.h * zoom > r.height + 1;
      }

      function setZoom(z, keepFit) {
        zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
        fitted = !!keepFit;
        paint();
      }

      function fit() {
        pan = { x: 0, y: 0 };
        setZoom(fitZoom(), true);
        return T('ph.fitted', '已縮放到符合視窗（{pct}%）', { pct: Math.round(zoom * 100) });
      }

      function zoomTo(z) {
        if (!path) return T('ph.noneOpen', '還沒開啟圖片');
        if (!(z > 0)) return T('ph.badZoom', '縮放比例要是正數');
        setZoom(z, false);
        return T('ph.zoomed', '縮放到 {pct}%', { pct: Math.round(zoom * 100) });
      }

      function zoomStep(dir) {
        var next = zoom;
        if (dir > 0) {
          for (var i = 0; i < STOPS.length; i++) if (STOPS[i] > zoom + 1e-6) { next = STOPS[i]; break; }
          if (next === zoom) next = Math.min(MAX_ZOOM, zoom * 1.5);
        } else {
          for (var j = STOPS.length - 1; j >= 0; j--) if (STOPS[j] < zoom - 1e-6) { next = STOPS[j]; break; }
          if (next === zoom) next = Math.max(MIN_ZOOM, zoom / 1.5);
        }
        setZoom(next, false);
      }

      function rotate(deg) {
        if (!path) return T('ph.noneOpen', '還沒開啟圖片');
        var d = Number(deg);
        if (!(d === 90 || d === 180 || d === 270 || d === -90)) d = 90;
        rotation = ((rotation + d) % 360 + 360) % 360;
        if (fitted) fit(); else paint();
        return T('ph.rotated', '已旋轉，現在是 {deg} 度', { deg: rotation });
      }

      function cycleBg() {
        BACKGROUNDS.forEach(function (b) { stage.classList.remove('ph-bg-' + b); });
        bgIndex = (bgIndex + 1) % BACKGROUNDS.length;
        stage.classList.add('ph-bg-' + BACKGROUNDS[bgIndex]);
      }

      /* ------------------------------------------------------------ files */

      function index() { return list.indexOf(path); }

      function renderStatus() {
        if (!path) { status.textContent = T('ph.noneOpen', '還沒開啟圖片'); return; }
        var i = index();
        status.textContent = path +
          (natural.w ? '　' + natural.w + ' × ' + natural.h : '') +
          (bytes ? '　' + AIOS.bytes(bytes) : '') +
          (list.length > 1 && i >= 0 ? '　' + T('ph.of', '第 {i} / {n} 張', { i: i + 1, n: list.length }) : '') +
          '　' + Math.round(zoom * 100) + '%' +
          (rotation ? '　' + rotation + '°' : '');
        counter.textContent = list.length > 1 && i >= 0 ? (i + 1) + '/' + list.length : '';
        btnPrev.disabled = !(list.length > 1);
        btnNext.disabled = !(list.length > 1);
      }

      function info() {
        if (!path) return T('ph.noneOpen', '還沒開啟圖片');
        var i = index();
        return T('ph.infoText', '{name}：{w} × {h} 像素，{bytes}，{type}{pos}', {
          name: baseName(path), w: natural.w, h: natural.h, bytes: AIOS.bytes(bytes),
          type: (AIOS.images.mimeFor(path) || '').replace('image/', '').toUpperCase(),
          pos: list.length > 1 && i >= 0 ? T('ph.infoPos', '，資料夾裡第 {i}／{n} 張', { i: i + 1, n: list.length }) : ''
        });
      }

      function publish() {
        if (!path) { ctx.publish(null); return; }
        ctx.publish([
          T('ph.pubHead', '圖片：{path}', { path: path }),
          info(),
          T('ph.pubView', '縮放 {pct}%，旋轉 {deg} 度', { pct: Math.round(zoom * 100), deg: rotation }),
          list.length > 1 ? T('ph.pubList', '同資料夾的圖片：{list}', { list: list.map(baseName).join('、').slice(0, 600) }) : ''
        ].filter(Boolean).join('\n'), 'app/photos');
      }

      function showError(msg) {
        img.hidden = true;
        empty.hidden = true;
        errBox.hidden = false;
        errBox.textContent = msg;
        status.textContent = msg;
      }

      async function open(vpath) {
        var p = String(vpath || '').trim();
        if (!p) return T('ph.noPath', '沒有給路徑');
        if (!AIOS.images.EXT.test(p)) {
          return T('ph.notImage', '{name} 不是這個檢視器認得的圖片格式（png、jpg、gif、webp、bmp、avif）', { name: baseName(p) });
        }
        nameTag.textContent = baseName(p);
        var r = await AIOS.images.dataUrl(p);
        if (!r.ok) {
          path = p;
          natural = { w: 0, h: 0 };
          bytes = 0;
          showError(T('ph.readFail', '讀不到 {name}：{err}', { name: baseName(p), err: r.error }));
          return T('ph.readFail', '讀不到 {name}：{err}', { name: baseName(p), err: r.error });
        }
        path = p;
        bytes = r.bytes;
        rotation = 0;
        pan = { x: 0, y: 0 };
        list = siblings(p);
        if (list.indexOf(p) < 0) list.push(p);

        await new Promise(function (resolve) {
          img.onload = function () { resolve(true); };
          img.onerror = function () { resolve(false); };
          img.src = r.url;
        });
        if (!img.naturalWidth) {
          natural = { w: 0, h: 0 };
          showError(T('ph.decodeFail', '{name} 無法解碼，檔案可能壞了', { name: baseName(p) }));
          return T('ph.decodeFail', '{name} 無法解碼，檔案可能壞了', { name: baseName(p) });
        }
        natural = { w: img.naturalWidth, h: img.naturalHeight };
        errBox.hidden = true;
        empty.hidden = true;
        img.hidden = false;
        ctx.setTitle(baseName(p));
        fit();
        publish();
        stage.focus({ preventScroll: true });
        return T('ph.opened', '已開啟 {name}（{w} × {h}）', { name: baseName(p), w: natural.w, h: natural.h });
      }

      async function step(dir) {
        if (!path) return T('ph.noneOpen', '還沒開啟圖片');
        list = siblings(path);
        if (list.length < 2) return T('ph.alone', '這個資料夾只有這一張');
        var i = list.indexOf(path);
        var next = list[((i + dir) % list.length + list.length) % list.length];
        return open(next);
      }

      async function pick() {
        var chosen = await AIOS.openPath({
          host: ctx.win && ctx.win.el,
          label: T('ph.pickLabel', '開啟圖片'),
          filter: AIOS.images.EXT,
          importInto: '/inbox'
        });
        if (chosen) await open(chosen);
      }

      /* -------------------------------------------------------- pointing */

      var drag = null;
      stage.addEventListener('pointerdown', function (e) {
        if (e.button !== 0 || !path || !canPan()) return;
        drag = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
        stage.setPointerCapture(e.pointerId);
        stage.classList.add('ph-dragging');
      });
      stage.addEventListener('pointermove', function (e) {
        if (!drag) return;
        pan.x = drag.px + (e.clientX - drag.x);
        pan.y = drag.py + (e.clientY - drag.y);
        paint();
      });
      function endDrag(e) {
        if (!drag) return;
        drag = null;
        stage.classList.remove('ph-dragging');
        try { stage.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
      }
      stage.addEventListener('pointerup', endDrag);
      stage.addEventListener('pointercancel', endDrag);

      stage.addEventListener('dblclick', function () {
        if (!path) return;
        if (fitted && fitZoom() < 1) setZoom(1, false); else fit();
      });

      stage.addEventListener('wheel', function (e) {
        if (!path) return;
        e.preventDefault();
        zoomStep(e.deltaY < 0 ? 1 : -1);
      }, { passive: false });

      stage.addEventListener('keydown', function (e) {
        if (!path) return;
        var k = e.key;
        if (k === 'ArrowRight' || k === 'PageDown') { e.preventDefault(); step(1); }
        else if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); step(-1); }
        else if (k === '+' || k === '=') { e.preventDefault(); zoomStep(1); }
        else if (k === '-' || k === '_') { e.preventDefault(); zoomStep(-1); }
        else if (k === '0') { e.preventDefault(); fit(); }
        else if (k === '1') { e.preventDefault(); setZoom(1, false); }
        else if (k === 'r' || k === 'R') { e.preventDefault(); rotate(90); }
        else if (k === 'Home') { e.preventDefault(); if (list.length) open(list[0]); }
        else if (k === 'End') { e.preventDefault(); if (list.length) open(list[list.length - 1]); }
      });

      btnOpen.addEventListener('click', pick);
      btnPrev.addEventListener('click', function () { step(-1); });
      btnNext.addEventListener('click', function () { step(1); });
      btnOut.addEventListener('click', function () { zoomStep(-1); });
      btnIn.addEventListener('click', function () { zoomStep(1); });
      zoomTag.addEventListener('click', function () {
        if (!path) return;
        if (fitted && fitZoom() < 1) setZoom(1, false); else fit();
      });
      btnFit.addEventListener('click', function () { if (path) fit(); });
      btnOne.addEventListener('click', function () { if (path) setZoom(1, false); });
      btnRotate.addEventListener('click', function () { rotate(90); });
      btnBg.addEventListener('click', cycleBg);
      btnReveal.addEventListener('click', function () {
        if (!path) { ctx.toast(T('ph.noneOpen', '還沒開啟圖片'), 't-warn'); return; }
        A.user.reveal(path);
      });

      /* A fitted picture follows the window; a zoomed one keeps its zoom and
         only has its pan re-clamped. */
      var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(function () {
        if (!path) return;
        if (fitted) fit(); else paint();
      }) : null;
      if (ro) ro.observe(stage);

      ctx.setMenu(function () {
        return [
          { label: T('ph.open', '開啟…'), run: pick },
          { label: T('ph.prevMenu', '上一張'), hint: '←', disabled: list.length < 2, run: function () { step(-1); } },
          { label: T('ph.nextMenu', '下一張'), hint: '→', disabled: list.length < 2, run: function () { step(1); } },
          { sep: true },
          { label: T('ph.fit', '符合視窗'), hint: '0', disabled: !path, run: fit },
          { label: T('ph.actual', '實際大小'), hint: '1', disabled: !path, run: function () { setZoom(1, false); } },
          { label: T('ph.rotateMenu', '順時針轉 90°'), hint: 'r', disabled: !path, run: function () { rotate(90); } },
          { label: T('ph.bgMenu', '切換背景'), run: cycleBg },
          { sep: true },
          { label: T('ph.copyPath', '複製路徑'), disabled: !path,
            run: function () { A.clipboard.write(path); ctx.toast(T('ph.copied', '已複製 {path}', { path: path })); } },
          { label: T('ph.reveal', '在作業系統顯示'), disabled: !path, run: function () { A.user.reveal(path); } },
          { label: T('ph.showInFiles', '在檔案總管顯示'), disabled: !path,
            run: function () { AIOS.apps.launch('files', dirName(path)); } },
          { label: T('ph.reload', '重新讀取'), disabled: !path,
            run: function () { AIOS.images.forget(path); open(path); } }
        ];
      });

      ctx.describe(function () {
        if (!path) return T('ph.descNone', '還沒有開啟任何圖片。可以用 open {path} 開一張沙箱裡的圖片。');
        return [info(), T('ph.pubView', '縮放 {pct}%，旋轉 {deg} 度', { pct: Math.round(zoom * 100), deg: rotation }),
          list.length > 1 ? T('ph.pubList', '同資料夾的圖片：{list}', { list: list.map(baseName).join('、').slice(0, 600) }) : '']
          .filter(Boolean).join('\n');
      });

      ctx.api = {
        open: open,
        step: step,
        zoomTo: zoomTo,
        fit: function () { return path ? fit() : T('ph.noneOpen', '還沒開啟圖片'); },
        rotate: rotate,
        info: info,
        current: function () { return path; },
        zoom: function () { return zoom; }
      };

      if (typeof ctx.arg === 'string') open(ctx.arg);
      else if (ctx.state && ctx.state.path) open(ctx.state.path);
      else renderStatus();

      return {
        getState: function () { return { path: path }; },
        reopen: function (vpath) { if (typeof vpath === 'string') open(vpath); },
        onClose: function () { if (ro) ro.disconnect(); ctx.publish(null); }
      };
    }
  });
})();
