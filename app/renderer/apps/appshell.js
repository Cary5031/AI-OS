'use strict';

/* ===========================================================================
   AI-OS // runtime for generated applications
   ---------------------------------------------------------------------------
   Code written by a language model runs here, and the arrangement is the whole
   point of the feature being safe enough to use.

   A generated app never touches this document. It is served from aios-app:// and
   loaded into an iframe with sandbox="allow-scripts allow-forms" and no
   allow-same-origin, which puts it in a unique opaque origin: it cannot read the
   parent DOM, cannot see window.aios, cannot reach the sandbox, cannot read a
   cookie. Its own Content-Security-Policy is default-src 'none', so it cannot
   open a socket either -- not because we asked it not to, because the engine
   refuses.

   The one token that is not obvious is `allow-forms`, and it is there because it
   was measured missing: without it Chromium refuses a form submission *before*
   dispatching the event, so a generated app's submit handler never runs at all.
   It is a permission to dispatch an event, not to go anywhere -- allow-popups
   and allow-top-navigation are both absent. FRAME_SANDBOX below is the single
   definition, and a test pins every token in it.

   Everything it can do arrives through one postMessage channel, and this file is
   the broker on the other end. Each request is checked against the capabilities
   recorded for that app when a human approved it, and file access is confined to
   the app's own directory unless the app was granted more.

   The contract for generated code is one function:

       function render(root, os) { ... }

   `root` is a div inside the iframe. `os` is the async API described in the
   generation prompt. A syntax error in the generated code surfaces through
   window.onerror inside the iframe and comes back here as a report, which is
   what lets the forge repair its own output.

   Before a program is installed it is run in here off-screen (smokeTest): drawn,
   its own self-test action called, its fields filled, its buttons pressed, and
   whatever it throws collected. The forge's build loop treats that report the
   way it treats a static check, so a program that runs and does nothing is
   sent back to be fixed rather than shipped.
   =========================================================================== */

/* global window, document, AIOS */

(function () {
  var A = window.aios;
  var K = AIOS.kernel;

  /* Capability -> which broker calls it unlocks. */
  var GRANTS = {
    storage: ['storage.get', 'storage.set', 'storage.keys'],
    appdata: ['files.list', 'files.read', 'files.write'],
    'sandbox-read': ['sandbox.list', 'sandbox.read'],
    /* Writing the user's own files, anywhere in the sandbox. Separate from
       reading because it overwrites, and from appdata because it reaches
       beyond the program's folder -- a report generator wants /notes. */
    'sandbox-write': ['sandbox.write', 'sandbox.mkdir'],
    /* ask() answers in prose; json() answers in a shape the program gave. */
    ai: ['ai.ask', 'ai.json'],
    clipboard: ['clipboard.write'],
    /* The other programs on this machine, through the same app.do the
       intent bar uses: a program that can tell the spreadsheet to fill a
       range, or the document app to save a file, is a component, not a
       widget. The forge and the program itself are not targets. */
    apps: ['apps.list', 'apps.do', 'apps.open'],
    /* Browser extensions. `page.read` hands over the current tab's text nodes,
       numbered; `page.apply` takes back a list of replacements for those
       numbers. The program never runs in the page -- see browser.js for why the
       vocabulary is that narrow. */
    page: ['page.read', 'page.apply', 'page.pdf'],
    /* The network, through the main process and the net.egress gate. `net.json`
       is sugar the frame adds over `net.fetch`; it is listed so the validator
       maps `os.net.json(` to this capability too. */
    net: ['net.fetch', 'net.json']
  };

  /* Always available: they only affect the app's own window, or compute nothing
     but a number. */
  var ALWAYS = ['ui.title', 'ui.toast', 'ui.error', 'ui.ready', 'calc', 'ui.size'];

  /* The sandbox a generated app runs in. One constant because two things have to
     agree on it exactly: the window that ships the app, and the smoke test that
     decides whether to ship it. A smoke test in a more permissive frame than the
     real one is not a test -- which is how a missing allow-forms reached a user
     with every check green and the app's only button doing nothing. */
  var FRAME_SANDBOX = 'allow-scripts allow-forms';

  /**
   * Size a generated app's window to what its content asked for.
   *
   * A generated program has no way to know how big its window is, and 620x460 was
   * a guess applied to everything -- a calculator got a mostly empty rectangle, a
   * long list got a scrollbar. The frame measures its own content and this puts the
   * window around it.
   *
   * Three limits, in order: never smaller than usable, never larger than the free
   * desktop area, and never at all once the user has dragged the window's own
   * resize handle. That last one matters most: a program that keeps re-measuring
   * must not fight someone who has decided how big they want it.
   */
  function fitWindow(win, want, frame) {
    if (!win || !win.el || win.userSized || win.minimized) return false;

    /* Chrome is everything the frame is not, and it has to be measured against
       the frame itself. Measuring `.win-body` instead counted the body's other
       occupants as usable space: the version bar, the error strip, and -- the
       expensive one -- the 268px AI chat column, which is inside the body. So
       every report subtracted that column again. Open the chat panel on a
       generated app and the window ratcheted narrower on each measurement until
       it hit the 260px floor, which is what "the window got squeezed" was. */
    if (!frame || !frame.clientWidth || !frame.clientHeight) return false;

    var chromeH = win.el.offsetHeight - frame.clientHeight;
    var chromeW = win.el.offsetWidth - frame.clientWidth;

    /* want.w is now the content's natural width, so this is fit-content: as wide
       as the program would like, never wider than the desk it sits on. It used
       to be the width the window already had, which is why the clamp could only
       ever take the floor. */
    var free = AIOS.wm.freeRect();
    var w = Math.max(260, Math.min(Math.round(want.w) + chromeW, free.w));
    var h = Math.max(150, Math.min(Math.round(want.h) + chromeH, free.h));

    // Ignore noise: a pixel here or there is not worth a reflow.
    if (Math.abs(w - win.el.offsetWidth) < 8 && Math.abs(h - win.el.offsetHeight) < 8) return false;

    win.el.style.width = w + 'px';
    win.el.style.height = h + 'px';

    // Keep it on screen after growing.
    var deskW = free.x + free.w;
    var deskH = free.y + free.h;
    if (win.el.offsetLeft + w > deskW) win.el.style.left = Math.max(free.x, deskW - w) + 'px';
    if (win.el.offsetTop + h > deskH) win.el.style.top = Math.max(free.y, deskH - h) + 'px';

    return true;
  }

  /** The spreadsheet's error values, said in a way a user can act on. */
  function calcMessage(err) {
    var E = AIOS.formula.ERR;
    var code = typeof err === 'string' ? err : (err && err.message) || '';
    if (code === E.div0) return '不能除以零';
    if (code === E.ref) return '這裡不能用儲存格位址（像 A1），只能用數字';
    if (code === E.value) return '算式裡有不是數字的東西';
    if (code === E.name) return '不認得這個名稱或函式';
    if (code === E.num) return '數字超出範圍';
    if (code === E.na) return '算不出來';
    return '算式有問題：' + String(code).slice(0, 80);
  }

  function allowed(caps, call) {
    if (ALWAYS.indexOf(call) >= 0) return true;
    return (caps || []).some(function (c) { return (GRANTS[c] || []).indexOf(call) >= 0; });
  }

  /* The os.* surface a piece of generated code can reach, and the capability each
     part of it needs. Derived from GRANTS so the two cannot drift apart. */
  var NEEDS = (function () {
    var out = {};
    Object.keys(GRANTS).forEach(function (cap) {
      GRANTS[cap].forEach(function (call) { out['os.' + call] = cap; });
    });
    return out;
  })();

  /* --------------------------------------------------------------- runtime */

  /**
   * The bootstrap that runs inside the iframe. Kept as a string because it is
   * inlined into the HTML the frame is served, alongside the generated code --
   * the frame has no second file to load, and giving it one would mean a second
   * thing to hash before it may run.
   *
   * It said "inlined into srcdoc" until the frames moved to `aios-app://`, which
   * they did precisely because a srcdoc document inherits this document's CSP
   * and this document allows only `script-src 'self'` -- so the app's own
   * bootstrap was silently blocked and nothing rendered. See forge.js.
   */
  function bootstrapSource() {
    return [
      '(function(){',
      '  var seq = 0, pending = {};',
      '  function call(name, args) {',
      '    return new Promise(function (resolve, reject) {',
      '      var id = ++seq;',
      '      pending[id] = { resolve: resolve, reject: reject };',
      '      parent.postMessage({ aios: 1, id: id, call: name, args: args || {} }, "*");',
      '      setTimeout(function () {',
      '        if (pending[id]) { pending[id].reject(new Error("逾時：" + name)); delete pending[id]; }',
      '      }, 120000);',
      '    });',
      '  }',
      '  window.addEventListener("message", function (e) {',
      '    var m = e.data;',
      /* A smoke run, asked for before this code is ever installed. It has to
         happen in here: the frame is an opaque origin, so the shell cannot see
         this DOM, cannot click these buttons, and cannot tell whether the
         engine refused something. Only this side can. */
      '    if (m && m.aios === 3) {',
      '      var got;',
      '      try { got = smokeRun(m.phase); }',
      '      catch (err) { got = { fatal: "冒煙測試自己出錯：" + ((err && err.message) || err) }; }',
      '      parent.postMessage({ aios: 4, phase: m.phase, smoke: got }, "*");',
      '      return;',
      '    }',
      /* An action the program published, called from outside.
         This is what lets a generated program be a component the kernel can
         drive rather than only a window someone opens: `app.do` reaches it
         through here. The program declares them on `os.actions`; nothing else
         in the frame is callable. */
      '    if (m && m.aios === 5) {',
      '      (async function () {',
      '        var reply = { aios: 6, id: m.id };',
      '        try {',
      '          var table = (window.__aiosOS && window.__aiosOS.actions) || {};',
      /* A bare function is an action too. The documented shape is
         `{ desc, args, run }`, and every example says so -- but `os.actions.x =
         async function` is what a model writes when it is thinking about the
         behaviour and not the catalogue, and the first contribution written for
         a slot did exactly that. Refusing it with 「沒有這個動作」 names an action
         that is plainly there, which is the kind of message people stop
         believing. So the shorthand is read as `{ run }`, with nothing to say in
         the catalogue. */
      '          var entry = function (k) {',
      '            var e = table[k];',
      '            return typeof e === "function" ? { run: e } : e;',
      '          };',
      /* `__list` answers with the catalogue rather than running anything, so the
         shell can find out what a program offers without the program having to
         publish a describe-yourself action of its own. Reserved: a program that
         defines an action by that name does not get to shadow it. */
      '          if (m.action === "__list") {',
      '            var out = {};',
      '            Object.keys(table).forEach(function (k) {',
      '              if (k.indexOf("__") === 0) return;',
      '              var a = entry(k);',
      '              if (!a || typeof a.run !== "function") return;',
      '              out[k] = { desc: String(a.desc || ""), args: String(a.args || "") };',
      '            });',
      '            reply.result = out;',
      '          } else {',
      '            var fn = entry(m.action) && entry(m.action).run;',
      '            if (typeof fn !== "function") throw new Error("沒有這個動作：" + m.action);',
      '            reply.result = await fn(m.args || {});',
      '          }',
      '        } catch (err) { reply.error = String((err && err.message) || err); }',
      '        parent.postMessage(reply, "*");',
      '      })();',
      '      return;',
      '    }',
      '    if (!m || m.aios !== 2 || !pending[m.id]) return;',
      '    var p = pending[m.id];',
      '    delete pending[m.id];',
      '    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);',
      '  });',
      '  var os = {',
      '    storage: {',
      '      get: function (k) { return call("storage.get", { key: k }); },',
      '      set: function (k, v) { return call("storage.set", { key: k, value: v }); },',
      '      keys: function () { return call("storage.keys", {}); }',
      '    },',
      '    files: {',
      '      list: function (d) { return call("files.list", { dir: d }); },',
      '      read: function (p) { return call("files.read", { path: p }); },',
      '      write: function (p, c) { return call("files.write", { path: p, content: c }); }',
      '    },',
      '    sandbox: {',
      '      list: function (d) { return call("sandbox.list", { dir: d }); },',
      /* The text, not the record. The broker answers {content, untrusted,
         vpath} so it can label a hostile file on the way in; a program that
         was never told that did String(value) and sent "[object Object]" to
         the model as the meeting it was asked to summarise. The label is the
         toast's business, not the program's. */
      '      read: function (p) { return call("sandbox.read", { path: p }).then(function (r) {',
      '        return r && typeof r === "object" && "content" in r ? r.content : r; }); },',
      '      write: function (p, c) { return call("sandbox.write", { path: p, content: c }); },',
      '      mkdir: function (p) { return call("sandbox.mkdir", { path: p }); }',
      '    },',
      '    ai: {',
      '      ask: function (q) { return call("ai.ask", { prompt: q }); },',
      '      json: function (q, s) { return call("ai.json", { prompt: q, schema: s }); }',
      '    },',
      '    apps: {',
      '      list: function () { return call("apps.list", {}); },',
      '      do: function (a, n, g) { return call("apps.do", { app: a, action: n, args: g || {} }); },',
      '      open: function (p) { return call("apps.open", { path: p }); }',
      '    },',
      '    ui: {',
      '      title: function (t) { return call("ui.title", { text: t }); },',
      '      toast: function (t) { return call("ui.toast", { text: t }); }',
      '    },',
      '    clipboard: { write: function (t) { return call("clipboard.write", { text: t }); } },',
      /* Browser extensions. read() gives numbered text nodes; apply() takes
         [{node, text}] back. The program never runs inside the page. */
      '    page: {',
      '      read: function (limit) { return call("page.read", { limit: limit }); },',
      '      apply: function (ops) { return call("page.apply", { ops: ops }); },',
      '      pdf: function (p) { return call("page.pdf", { path: p }); }',
      '    },',
      '    calc: function (expr) { return call("calc", { expr: expr }); },',
      /* The network. fetch() answers { url, status, ok, headers, text }; json()
         is the common case -- an API that answers in JSON -- and throws on a
         non-2xx status or a body that does not parse, so a program can write
         `var data = await os.net.json(url)` and catch once. */
      '    net: {',
      '      fetch: function (u, o) { return call("net.fetch", { url: u, opts: o || {} }); },',
      '      json: async function (u, o) {',
      '        var r = await call("net.fetch", { url: u, opts: o || {} });',
      '        if (!r || !r.ok) throw new Error("HTTP " + (r && r.status) + "：" + String((r && r.text) || "").slice(0, 200));',
      '        try { return JSON.parse(r.text); }',
      '        catch (e) { throw new Error("回應不是 JSON：" + String(r.text || "").slice(0, 120)); }',
      '      }',
      '    },',
      /* What this program can be asked to do from outside. A program fills this
         in to become something the kernel can drive:
             os.actions.addEntry = { desc: "…", args: "{name, email}",
                                     run: function (a) { … } };
         Without it the program is still a window someone opens; with it, it is
         a component a plan can name. */
      '    actions: {}',
      '  };',
      '  window.__aiosOS = os;',
      '  window.onerror = function (msg, src, line, col) {',
      '    call("ui.error", { message: String(msg), line: line, col: col });',
      '    return true;',
      '  };',
      '  window.addEventListener("unhandledrejection", function (e) {',
      '    call("ui.error", { message: "未處理的 Promise 錯誤：" + (e.reason && e.reason.message || e.reason) });',
      '  });',
      /* Report how much room the content actually wants, so the window can be
         sized to the program instead of to a guess.
         The children are measured rather than documentElement.scrollHeight,
         because the frame's own CSS stretches html, body and #root to full height
         -- so scrollHeight reports the window it is already in and never reveals
         that the content is smaller. A child that stretches itself to 100% will
         report the frame height too, which is the right answer for something that
         asked to fill. */
      '  function measure() {',
      '    var root = document.getElementById("root");',
      '    if (!root) return null;',
      '    var kids = root.children;',
      '    if (!kids.length) return null;',
      /* Measured with the frame's own width taken out of the answer.
         A fluid layout fits whatever width it is handed, so measuring it as it
         stands reports the width it already has -- which makes the reported
         size a function of the window it is sizing. The window could then only
         ever shrink: a ledger opened at 620 reported a little less each time
         and ratcheted down to the 260 floor, where it stayed, because at 260 it
         still fitted. max-content asks what the content would take if nothing
         pushed back, and that does not move when the window does.
         Height is read in the same pass, so it is the height at the width we
         are about to ask for rather than at the width being replaced. */
      '    var prevW = root.style.width;',
      '    root.style.width = "max-content";',
      '    var top = Infinity, left = Infinity, bottom = -Infinity, right = -Infinity;',
      '    for (var i = 0; i < kids.length; i++) {',
      '      var kid = kids[i];',
      '      var r = kid.getBoundingClientRect();',
      '      if (!r.width && !r.height) continue;',
      '      if (r.top < top) top = r.top;',
      '      if (r.left < left) left = r.left;',
      /* The scroll extent as well as the rect. A container that caps itself with
         max-width still overflows when its own contents will not fit inside that
         cap, and a border box says nothing about the overflow -- so a window that
         had been squeezed reported a size that agreed with the squeeze, and could
         never grow back. scrollWidth is where the too-narrow keypad shows up. */
      '      var ow = Math.max(r.width, kid.scrollWidth || 0);',
      '      var oh = Math.max(r.height, kid.scrollHeight || 0);',
      '      if (r.left + ow > right) right = r.left + ow;',
      '      if (r.top + oh > bottom) bottom = r.top + oh;',
      '    }',
      '    root.style.width = prevW;',
      '    if (bottom < 0 || right < 0) return null;',
      '    var pad = 12;',   // #root's padding, doubled below
      '    return { w: Math.ceil(right - left) + pad * 2, h: Math.ceil(bottom - top) + pad * 2 };',
      '  }',
      '  var lastFit = "";',
      '  var fitTimer = 0;',
      '  var quietUntil = 0;',
      '  function reportFit() {',
      /* measure() changes #root's width for a moment to read the content's
         natural size, and both observers see that reflow. Without a quiet
         window they re-trigger the measurement that caused them, forever --
         silently, because the reported size never changes and nothing is ever
         sent. The window is short enough that a real change still lands. */
      '    if (Date.now() < quietUntil) return;',
      '    clearTimeout(fitTimer);',
      '    fitTimer = setTimeout(function () {',
      '      var m = measure();',
      '      quietUntil = Date.now() + 200;',
      '      if (!m) return;',
      '      var key = m.w + "x" + m.h;',
      '      if (key === lastFit) return;',   // nothing to say
      '      lastFit = key;',
      '      call("ui.size", m);',
      '    }, 60);',
      '  }',
      /* Does this program actually do anything when you use it?
         Passing the static checks and then not working is the worst shape a
         failure takes, and it is invisible from outside the frame. So: did it
         draw, does the engine let its form submit at all, and does pressing its
         buttons throw or trip the policy. */
      /* Every step is synchronous and returns at once. None of the waiting
         happens in here on purpose: the smoke frame is off to one side and is
         not painted, so Chromium throttles its timers to roughly one a second.
         A thirty-step poll that should have taken 1.5s took thirty, and the run
         timed out reporting the wrong thing. The shell is the visible page, its
         timers are not clamped, and it does the waiting. */
      '  var smokeState = null;',
      '  function smokeRun(phase) {',
      '    var root = document.getElementById("root");',
      '    if (!root) return { fatal: "找不到 #root" };',
      '    if (!smokeState) {',
      '      smokeState = { errors: [], violations: [], prevErr: window.onerror, onRej: null };',
      '      document.addEventListener("securitypolicyviolation", function (e) {',
      '        smokeState.violations.push(String(e.violatedDirective || "policy") +',
      '          " 擋下了 " + String(e.blockedURI || "inline"));',
      '      });',
      '      smokeState.onRej = function (ev) {',
      '        smokeState.errors.push("未處理的 Promise 錯誤：" +',
      '          String((ev.reason && ev.reason.message) || ev.reason));',
      '      };',
      '      window.onerror = function (m2) { smokeState.errors.push(String(m2)); return true; };',
      '      window.addEventListener("unhandledrejection", smokeState.onRej);',
      '    }',
      '    function drawn() {',
      '      for (var i = 0; i < root.children.length; i++) {',
      '        var r = root.children[i].getBoundingClientRect();',
      '        if (r.width > 4 && r.height > 4) return true;',
      '      }',
      '      return false;',
      '    }',
      '    if (phase === "probe") {',
      '      return { drawn: drawn(), forms: root.querySelectorAll("form").length };',
      '    }',
      /* A form the engine will not submit is the exact failure that shipped: the
         handler is never reached, so the button is inert and nothing is logged
         anywhere the shell can see. Probe the capability with a throwaway form
         rather than reading console text. */
      '    if (phase === "form") {',
      '      var probe = document.createElement("form");',
      '      probe.setAttribute("style", "position:absolute;left:-9999px;top:0");',
      '      var fired = false;',
      '      probe.addEventListener("submit", function (ev) { ev.preventDefault(); fired = true; });',
      '      var sb = document.createElement("button");',
      '      sb.type = "submit";',
      '      probe.appendChild(sb);',
      '      document.body.appendChild(probe);',
      '      try { sb.click(); } catch (e) {}',
      '      document.body.removeChild(probe);',
      '      return { formOk: fired };',
      '    }',
      /* Press the buttons of an empty form and the handler takes its "nothing to
         do" branch: it returns before it can reach the arithmetic, the parsing
         or the write that is the actual program. The ledger that shipped broken
         failed only once a number was in the box. So fill first, then click.
         Values are per type on purpose -- a date input handed "測試" stays empty
         and a Date built from it is NaN, which tests nothing. */
      '    if (phase === "fill") {',
      '      var ins = [].slice.call(root.querySelectorAll("input, textarea, select"));',
      '      var filled = 0;',
      '      for (var k = 0; k < ins.length && k < 40; k++) {',
      '        var el = ins[k];',
      '        if (el.disabled || el.readOnly || el.type === "hidden") continue;',
      '        if (el.tagName === "SELECT") {',
      '          var opt = [].slice.call(el.options).filter(function (o) { return o.value; })[0];',
      '          if (!opt) continue;',
      '          el.value = opt.value;',
      '        } else if (el.type === "checkbox" || el.type === "radio") {',
      '          el.checked = true;',
      '        } else {',
      '          var v = el.type === "number" || el.type === "range" ? "12"',
      '                : el.type === "date" ? new Date().toISOString().slice(0, 10)',
      '                : el.type === "time" ? "09:00"',
      '                : el.type === "email" ? "a@example.com"',
      '                : "測試";',
      /* Assigning to .value on the element shadows the prototype accessor, and a
         framework listening for input sees nothing. Go through the setter. */
      '          var proto = Object.getPrototypeOf(el);',
      '          var desc = Object.getOwnPropertyDescriptor(proto, "value");',
      '          if (desc && desc.set) desc.set.call(el, v); else el.value = v;',
      '        }',
      '        el.dispatchEvent(new Event("input", { bubbles: true }));',
      '        el.dispatchEvent(new Event("change", { bubbles: true }));',
      '        filled++;',
      '      }',
      '      return { filled: filled };',
      '    }',
      '    if (phase === "click") {',
      '      var btns = [].slice.call(root.querySelectorAll("button, input[type=submit]"));',
      '      var hit = 0;',
      '      for (var j = 0; j < btns.length && j < 24; j++) {',
      '        if (btns[j].disabled) continue;',
      '        hit++;',
      '        try { btns[j].click(); } catch (err) {',
      '          smokeState.errors.push(String((err && err.message) || err)); }',
      '      }',
      '      return { buttons: hit };',
      '    }',
      '    if (phase === "collect") {',
      '      window.onerror = smokeState.prevErr;',
      '      window.removeEventListener("unhandledrejection", smokeState.onRej);',
      '      return { errors: smokeState.errors, violations: smokeState.violations,',
      '        drawn: drawn() };',
      '    }',
      '    return {};',
      '  }',
      '  window.__aiosStart = function () {',
      '    if (typeof render !== "function") {',
      '      call("ui.error", { message: "程式沒有定義 render(root, os) 函式" });',
      '      return;',
      '    }',
      '    try {',
      /* An async render is legal and common -- the contract is one function, not
         a synchronous one, and reading storage before the first paint needs an
         await. Its promise has to be waited for, or "ready" is announced while
         the screen is still blank and anything downstream of ready (the smoke
         gate, the first size report) judges an empty frame. */
      '      var done = render(document.getElementById("root"), os);',
      '      if (done && typeof done.then === "function") {',
      '        done.then(function () { call("ui.ready", {}); reportFit(); },',
      '          function (err) {',
      '            call("ui.error", { message: "render 執行失敗：" + ((err && err.message) || err) });',
      '          });',
      '      } else {',
      '        call("ui.ready", {});',
      '        reportFit();',
      '      }',
      /* Content arriving later -- an awaited storage read, a revealed panel -- has
         to move the window too, or the app is sized to its first paint only. */
      '      if (window.ResizeObserver) {',
      '        var ro = new ResizeObserver(reportFit);',
      '        var root = document.getElementById("root");',
      '        ro.observe(root);',
      '        for (var i = 0; i < root.children.length; i++) ro.observe(root.children[i]);',
      '      }',
      '      new MutationObserver(reportFit).observe(document.getElementById("root"),',
      '        { childList: true, subtree: true });',
      '    } catch (err) {',
      '      call("ui.error", { message: "render 執行失敗：" + (err && err.message || err) });',
      '    }',
      '  };',
      '})();'
    ].join('\n');
  }

  /** Theme variables the app can use, copied from the live palette. */
  function themeVars() {
    var cs = window.getComputedStyle(document.documentElement);
    /* --on-fill matters as much as the colours themselves: it is the foreground
       that stays legible on top of any of them, and its value depends on the
       theme rather than on the fill. Without it a generated program has no way to
       pair a coloured button with readable text except by guessing. */
    return ['--bg-0', '--bg-1', '--glass', '--glass-2', '--hair', '--hair-2', '--fg',
      '--fg-dim', '--fg-faint', '--accent', '--accent-2', '--warn', '--danger', '--taint',
      '--on-fill', '--mono', '--sans']
      .map(function (v) { return '  ' + v + ':' + cs.getPropertyValue(v) + ';'; })
      .join('\n');
  }

  /**
   * The frame document: policy, theme, base styles, bootstrap, the libraries
   * the program asked for, then the program.
   *
   * `libs` is [{global, source}]. Each library is inlined as its own script
   * ahead of the program's, inside the same sandbox and the same CSP, so a
   * library can reach exactly what the program can reach. It is the only way
   * to load one: the policy allows no external script, by design.
   */
  function frameHtml(code, libs) {
    var libScripts = [];
    (libs || []).forEach(function (l) {
      if (!l || !l.source) return;
      libScripts.push('<script>/* ' + String(l.global || '').replace(/[^\w$.]/g, '') + ' */');
      libScripts.push(String(l.source).replace(/<\/script/gi, '<\\/script'));
      libScripts.push('</scr' + 'ipt>');
    });
    // default-src 'none' is what makes "no network" a guarantee rather than a
    // request. Inline script and style are needed because there is no origin to
    // load assets from.
    return [
      '<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">',
      // form-action is named explicitly because it does not fall back to
      // default-src. The frame carries allow-forms so that submit handlers run
      // at all (see forge.js), and this is what keeps that from ever becoming a
      // navigation: the event fires, nothing can be posted anywhere.
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
        'style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; img-src data:; ' +
        'form-action \'none\'; base-uri \'none\';">',
      '<style>',
      ':root{', themeVars(), '}',
      /* The same pair every scrolling surface in os.css carries. Without it the
         frame keeps the platform default -- a bright bar down the side of a dark
         window, which is where a generated app stops looking like part of the
         machine.

         On `*` rather than on the root, because only one of the two inherits.
         `scrollbar-color` does; `scrollbar-width` does not, so setting the pair
         on html left every inner scroll region with the right colour at the
         default width -- measured, after doing exactly that. os.css names each
         surface it styles; in here we do not know which element the program
         decided to scroll, so the selector has to cover all of them. */
      '*{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:var(--hair-2) transparent}',
      'html,body{margin:0;height:100%;background:transparent;color:var(--fg);',
      '  font-family:var(--sans);font-size:13px;line-height:1.55}',
      '#root{padding:12px;min-height:100%}',
      // nowrap: a keypad label that breaks in half makes the button two lines
      // tall and the whole grid ragged. Buttons are labels, not paragraphs.
      'button{font:inherit;white-space:nowrap;padding:5px 11px;border-radius:7px;border:1px solid var(--hair-2);',
      '  background:var(--hair);color:var(--fg-dim);cursor:pointer}',
      'button:hover{color:var(--fg);border-color:var(--fg-faint)}',
      'input,textarea,select{font:inherit;padding:6px 8px;border-radius:6px;',
      '  border:1px solid var(--hair-2);background:var(--hair);color:var(--fg)}',
      'input:focus,textarea:focus{outline:none;border-color:var(--accent)}',
      'h1,h2,h3{margin:0 0 8px;color:var(--fg)}h1{font-size:17px}h2{font-size:15px}h3{font-size:13px}',
      'table{border-collapse:collapse;width:100%}th,td{padding:4px 7px;border-bottom:1px solid var(--hair);text-align:left}',
      'th{color:var(--fg-faint);font-weight:500;font-size:11px}',
      'ul,ol{padding-left:1.3em;margin:6px 0}li{margin:3px 0}',
      'a{color:var(--accent)}',
      '.muted{color:var(--fg-faint);font-size:11.5px}',
      '</style></head><body><div id="root"></div>',
      '<script>', bootstrapSource(), '</scr' + 'ipt>',
      libScripts.join('\n'),
      '<script>', code, '</scr' + 'ipt>',
      '<script>window.__aiosStart();</scr' + 'ipt>',
      '</body></html>'
    ].join('\n');
  }

  /* ---------------------------------------------------------------- broker */

  /**
   * Wire one iframe to the machine. Returns a detach function.
   * Every message is matched to this exact frame by source identity: the iframe
   * has an opaque origin, so origin checking is not available and would be
   * meaningless anyway.
   */
  function broker(frame, meta, ctx) {
    var caps = meta.capabilities || [];
    var storeKey = 'aios.app.' + meta.id;
    var calls = 0;
    var lastAsk = 0;
    var netTimes = [];

    function reply(id, result, error) {
      if (!frame.contentWindow) return;
      frame.contentWindow.postMessage({ aios: 2, id: id, result: result, error: error }, '*');
    }

    /* Every call that reaches past this window goes to main on the program's
       behalf, answered against the manifest recorded at install rather than
       against the policy. A program that was allowed to exist is not stopped
       afterwards -- no dialog when it fetches, no taint downgrade turning its
       own appdata write into a question. `allowed()` above is the fast local
       check; main's forge.assertGrant is the one that counts. */
    async function grant(call, args) {
      var r = await A.forge.appCall(meta.id, call, args || {});
      if (!r.ok) throw new Error(r.error);
      return r.data;
    }

    async function handle(call, args) {
      switch (call) {
        /* --------------------------------------------------------- ui --- */
        /* The bar keeps the program's own name whatever the program passes, so a
           window stays identifiable as the thing that opened it -- the same
           shape as 「編輯器 — 檔名」. What arrives here is only the part after the
           dash.

           A generated program passes its own name, because that is the obvious
           argument for something called `title` and nothing told it otherwise:
           four of the installed apps rendered as 「購物清單 — 購物清單」. A subtitle
           that only repeats the name is not a subtitle, so there is nothing to
           append -- and the same is true of one that spells out the whole bar. */
        case 'ui.title': {
          var sub = String(args.text || '').slice(0, 60).trim();
          if (sub.indexOf(meta.name) === 0) {
            sub = sub.slice(meta.name.length).replace(/^[\s—-]+/, '');
          }
          ctx.setTitle(sub ? meta.name + ' — ' + sub : meta.name);
          return true;
        }
        case 'ui.toast':
          ctx.toast(String(args.text || '').slice(0, 300));
          return true;
        case 'ui.ready':
          ctx.api.markReady();
          return true;
        case 'ui.error':
          ctx.api.reportError(String(args.message || '').slice(0, 600), args.line);
          return true;

        case 'ui.size': {
          var w = Number(args.w);
          var h = Number(args.h);
          if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return false;
          // Bounded before it reaches the window: a program reporting 10 million
          // pixels should be ignored, not obeyed.
          if (w > 20000 || h > 20000) return false;
          return fitWindow(ctx.win, { w: w, h: h }, frame);
        }

        /* ------------------------------------------------------- calc --- */
        /* Arithmetic, without eval.
           Generated code is forbidden eval and new Function, and a calculator is
           the most obvious thing anyone asks for -- so the model reached for eval,
           got refused, and reached for new Function on the retry. There was no
           legal way to evaluate an expression, which made the prohibition a dead
           end rather than a rule.
           The spreadsheet's engine is that legal way: a real tokenizer and parser
           that yields numbers and strings, never code. It is here rather than
           behind a capability because it computes and touches nothing. */
        case 'calc': {
          var src = String(args.expr == null ? '' : args.expr).trim();
          if (!src) throw new Error('沒有算式');
          if (src.length > 2000) throw new Error('算式太長');

          var ast;
          try {
            ast = AIOS.formula.parse(src.charAt(0) === '=' ? src.slice(1) : src);
          } catch (e) {
            throw new Error('算式看不懂：' + (e && e.message ? e.message : e));
          }

          var value;
          try {
            // No cells exist out here, so a reference is a mistake rather than an
            // empty value. evaluate() throws its error strings.
            value = AIOS.formula.evaluate(ast, function () { return AIOS.formula.ERR.ref; });
          } catch (err) {
            throw new Error(calcMessage(err));
          }
          if (AIOS.formula.isErr(value)) throw new Error(calcMessage(value));
          return value;
        }

        /* ---------------------------------------------------- storage --- */
        case 'storage.get': {
          var all = readStore();
          return all[String(args.key)];
        }
        case 'storage.set': {
          var s = readStore();
          if (args.value === undefined || args.value === null) delete s[String(args.key)];
          else s[String(args.key)] = args.value;
          var body = JSON.stringify(s);
          if (body.length > 512 * 1024) throw new Error('這個程式的儲存空間上限 512 KB');
          window.localStorage.setItem(storeKey, body);
          return true;
        }
        case 'storage.keys':
          return Object.keys(readStore());

        /* ------------------------------------------------------- page --- */
        /* The browser tab an extension acts on is the one on screen, chosen
           here rather than passed in: a program that could name a tab could act
           on a window the user is not looking at. */
        case 'page.read': {
          var tab = AIOS.browserTab && AIOS.browserTab();
          if (!tab) throw new Error('沒有開著的瀏覽器分頁');
          return grant('page.read', { tab: tab, limit: Math.min(4000, Number(args.limit) || 1200) });
        }
        case 'page.apply': {
          var tab2 = AIOS.browserTab && AIOS.browserTab();
          if (!tab2) throw new Error('沒有開著的瀏覽器分頁');
          return grant('page.apply', { tab: tab2, ops: args.ops || [] });
        }
        case 'page.pdf': {
          var tab3 = AIOS.browserTab && AIOS.browserTab();
          if (!tab3) throw new Error('沒有開著的瀏覽器分頁');
          return grant('page.pdf', { tab: tab3, path: String(args.path || '') });
        }

        /* ------------------------------------------------------ files --- */
        case 'files.list':
          return grant('files.list', { dir: args.dir || '' });
        case 'files.read':
          return grant('files.read', { path: args.path });
        case 'files.write': {
          var rw = await grant('files.write', { path: args.path, content: String(args.content == null ? '' : args.content) });
          await AIOS.afterFsChange();
          return rw;
        }

        /* -------------------------------------------- wider sandbox --- */
        case 'sandbox.write': {
          var sw = await grant('sandbox.write', { path: args.path, content: String(args.content == null ? '' : args.content) });
          await AIOS.afterFsChange();
          return sw;
        }
        case 'sandbox.mkdir': {
          var sm = await grant('sandbox.mkdir', { path: args.path });
          await AIOS.afterFsChange();
          return sm;
        }
        case 'sandbox.list':
          return grant('sandbox.list', { dir: args.dir || '/' });
        case 'sandbox.read': {
          var sr = await grant('sandbox.read', { path: args.path });
          // A generated app reading a file the user imported is exactly the
          // path a hostile document would use, so it is labelled on the way in.
          if (sr.untrusted) {
            ctx.toast('程式讀了不可信檔案 ' + sr.vpath, 't-taint');
          }
          return sr;
        }

        /* --------------------------------------------------------- ai --- */
        case 'ai.ask': {
          var now = Date.now();
          if (now - lastAsk < 1200) throw new Error('問太快了，請間隔至少 1.2 秒');
          lastAsk = now;
          if (!AIOS.state.connected) throw new Error('模型沒有連線');
          var prompt = String(args.prompt || '').slice(0, 4000);
          var res = await K.complete({
            // A program's own question; the intent bar's stop button is not
            // about it, and neither is the Forge's.
            owner: 'app',
            messages: [
              {
                role: 'system',
                content: '你在協助 AI-OS 上一個叫「' + meta.name + '」的小程式。' +
                  '用途：' + (meta.purpose || '未說明') + '。回答要簡短、直接、用繁體中文，不要加開場白。'
              },
              { role: 'user', content: prompt }
            ],
            temperature: 0.4,
            maxTokens: 900
          });
          return res.text;
        }
        case 'ai.json': {
          var nowJ = Date.now();
          if (nowJ - lastAsk < 1200) throw new Error('問太快了，請間隔至少 1.2 秒');
          lastAsk = nowJ;
          if (!AIOS.state.connected) throw new Error('模型沒有連線');
          var schema = args.schema && typeof args.schema === 'object' ? args.schema : { type: 'object' };
          var resJ = await K.complete({
            owner: 'app',
            messages: [
              {
                role: 'system',
                content: '你在協助 AI-OS 上一個叫「' + meta.name + '」的小程式。' +
                  '用途：' + (meta.purpose || '未說明') + '。只輸出符合要求的 JSON，不要其他文字。'
              },
              { role: 'user', content: String(args.prompt || '').slice(0, 6000) }
            ],
            schema: schema,
            schemaName: 'app',
            temperature: 0.3,
            maxTokens: 1400
          });
          K.addSpend(resJ.spend);
          return resJ.data;
        }

        /* ------------------------------------------------------- apps --- */
        /* Other programs on this machine, through the same executor the
           intent bar's app.do uses. What that executor does is what a person
           clicking the target program's buttons does; the parts of it that
           are gated (a document's save) answer to the policy as they always
           did. The forge is not a target -- a program building programs is
           a loop nobody asked for -- and neither is the program itself. */
        case 'apps.list':
          return AIOS.apps.list().filter(function (d) {
            return d.id !== 'forge' && d.id !== 'gen:' + meta.id && d.actions && Object.keys(d.actions).length;
          }).map(function (d) {
            return {
              id: d.id, name: d.name,
              /* `returns` is what a program needs and the chat panel does not:
                 without it the only way to find out what an action answers is to
                 call it and look, and an action that answers a sentence looks
                 exactly like one that has nothing to give. Absent means the
                 action only speaks -- see the contract in apps/registry.js. */
              actions: Object.keys(d.actions).map(function (k) {
                return {
                  name: k,
                  args: d.actions[k].args || '{}',
                  returns: d.actions[k].returns || '',
                  desc: d.actions[k].desc || ''
                };
              })
            };
          });
        case 'apps.do': {
          var target = String(args.app || '').trim().toLowerCase();
          if (!target || target === 'forge' || target === 'gen:' + meta.id || target === meta.id) {
            throw new Error('不能叫這個程式做事：' + (target || '（沒有指定）'));
          }
          var done = await AIOS.exec['app.do']({ app: target, action: String(args.action || ''), args: args.args || {} });
          return done && done.data !== undefined ? done.data : done;
        }
        /* Opening a file is the fs.open syscall, not an action of the program
           that shows it -- a generated organiser guessed `docs.open` and got
           「文件」沒有 open 這個動作. The file goes to whatever the machine would
           open it with. */
        case 'apps.open': {
          var opened = await AIOS.exec['fs.open']({ path: String(args.path || '') });
          return (opened && opened.note) || true;
        }

        /* -------------------------------------------------- clipboard --- */
        case 'clipboard.write':
          return grant('clipboard.write', { text: String(args.text || '') });

        /* -------------------------------------------------------- net --- */
        /* Rate-limited here as well as counted: a program polling an API in a
           tight loop would otherwise spend the 4000-call allowance in seconds. */
        case 'net.fetch': {
          var nowNet = Date.now();
          netTimes = netTimes.filter(function (t) { return nowNet - t < 60000; });
          if (netTimes.length >= 60) throw new Error('連線太頻繁：每分鐘最多 60 次');
          netTimes.push(nowNet);
          return grant('net.fetch', { url: String(args.url || ''), opts: args.opts || {} });
        }

        default:
          throw new Error('未知的呼叫：' + call);
      }
    }

    function readStore() {
      try { return JSON.parse(window.localStorage.getItem(storeKey) || '{}'); } catch (e) { return {}; }
    }

    async function onMessage(e) {
      if (!frame.contentWindow || e.source !== frame.contentWindow) return;
      var m = e.data;
      if (!m || m.aios !== 1 || typeof m.id !== 'number' || typeof m.call !== 'string') return;

      // A runaway loop in generated code should not be able to saturate the
      // machine through the broker.
      if (++calls > 4000) {
        reply(m.id, null, '這個程式的呼叫次數超過上限，已停止服務');
        return;
      }

      if (!allowed(caps, m.call)) {
        reply(m.id, null, '這個程式沒有取得「' + m.call + '」所需的能力');
        ctx.toast('拒絕 ' + m.call + '（未授權的能力）', 't-warn');
        return;
      }

      try {
        var result = await handle(m.call, m.args || {});
        reply(m.id, result === undefined ? null : result, null);
      } catch (err) {
        reply(m.id, null, String(err && err.message || err));
      }
    }

    window.addEventListener('message', onMessage);
    return function detach() { window.removeEventListener('message', onMessage); };
  }

  function wait(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /**
   * Answer the app's capability calls without performing any of them.
   *
   * The smoke test presses every button in a program nobody has approved yet, so
   * the calls behind those buttons must not land: os.ai.ask would spend money,
   * os.files.write would raise a consent dialog in the middle of a build, and
   * os.clipboard.write would take the clipboard. Storage is kept in memory
   * because a program that writes and reads back should see its own value --
   * that path is exercised, it just does not persist.
   *
   * What this deliberately does not test is whether the real broker would grant
   * the call. It does not have to: `validate` already fails code that uses a
   * capability its manifest never declared, and it does so before this runs.
   */
  function stubBroker(frame, meta, ctx) {
    var caps = meta.capabilities || [];
    var store = {};
    var files = {};

    function onMessage(e) {
      if (e.source !== frame.contentWindow) return;
      var m = e.data;
      if (!m || m.aios !== 1) return;
      var result, error = null;
      try {
        if (!allowed(caps, m.call)) throw new Error('這個程式沒有宣告 ' + m.call + ' 需要的能力');
        result = answer(m.call, m.args || {});
      } catch (err) { error = String((err && err.message) || err); }
      if (frame.contentWindow) {
        frame.contentWindow.postMessage(
          { aios: 2, id: m.id, result: result, error: error }, '*');
      }
    }

    function answer(call, args) {
      switch (call) {
        case 'ui.ready': ctx.api.markReady(); return true;
        case 'ui.error': ctx.api.reportError(String(args.message || ''), args.line); return true;
        case 'ui.title': case 'ui.toast': case 'ui.size': case 'clipboard.write': return true;
        // Real, because it is pure arithmetic and a wrong answer here is a bug
        // in the program worth catching.
        case 'calc': return brokerCalc(String(args.expr == null ? '' : args.expr));
        case 'storage.get': return store[String(args.key)];
        case 'storage.set':
          if (args.value == null) delete store[String(args.key)];
          else store[String(args.key)] = args.value;
          return true;
        case 'storage.keys': return Object.keys(store);
        case 'files.list': return Object.keys(files);
        case 'files.read': return files[String(args.path)] == null ? null : files[String(args.path)];
        case 'files.write': files[String(args.path)] = String(args.content || ''); return true;
        case 'sandbox.list': return [];
        case 'sandbox.read': return '';
        // Nothing is written to the user's files by a program nobody approved.
        case 'sandbox.write': return { vpath: String(args.path || ''), bytes: String(args.content || '').length };
        case 'sandbox.mkdir': return true;
        case 'ai.json': return {};
        case 'apps.list': return [];
        case 'apps.do': return { note: '冒煙測試：沒有真的叫其他程式做事' };
        case 'apps.open': return true;
        /* The smoke test runs before a program is trusted, so the page it is
           handed is a fixture: pressing the buttons of an unapproved extension
           must not reach a real tab, and must not rewrite one. */
        case 'page.read': return {
          url: 'https://example.com/', title: '冒煙測試頁',
          nodes: [{ node: 0, tag: 'h1', text: '標題' }, { node: 1, tag: 'p', text: '一段內文。' }]
        };
        case 'page.apply': return { applied: 0, skipped: 0, note: '冒煙測試：沒有真的改頁面' };
        case 'page.pdf': return { vpath: '/downloads/冒煙測試.pdf', bytes: 0 };
        case 'ai.ask': return '（冒煙測試：這裡不會真的問模型）';
        /* No socket is opened for a program nobody has approved. The fixture is
           a 200 with a JSON body, so os.net.json resolves and the program's
           own parsing runs; a program that needs a particular shape is told to
           test that shape with sample data in its selfTest. */
        case 'net.fetch': return {
          url: String(args.url || ''), status: 200, ok: true,
          headers: { 'content-type': 'application/json' }, bytes: 14, text: '{"smoke":true}'
        };
        default: throw new Error('不支援的呼叫：' + call);
      }
    }

    window.addEventListener('message', onMessage);
    return function () { window.removeEventListener('message', onMessage); };
  }

  /** calc, shared with the real broker so both give the same answer. */
  function brokerCalc(src) {
    var text = src.trim();
    if (!text) throw new Error('沒有算式');
    if (text.length > 2000) throw new Error('算式太長');
    var ast;
    try {
      ast = AIOS.formula.parse(text.charAt(0) === '=' ? text.slice(1) : text);
    } catch (e) { throw new Error('算式看不懂：' + ((e && e.message) || e)); }
    var value = AIOS.formula.evaluate(ast, function () { return AIOS.formula.ERR.ref; });
    if (AIOS.formula.isErr(value)) throw new Error(calcMessage(value));
    return value;
  }

  /**
   * Call an action a generated program published, and wait for its answer.
   *
   * The frame is an opaque origin, so this is a message round trip rather than a
   * function call. Budgeted generously: an action may be doing real work (a
   * hundred rows, a model call), and the frame's own `call()` already has its
   * own timeout for anything it asks the machine for.
   */
  function askAction(frame, action, args, budget) {
    return new Promise(function (resolve, reject) {
      if (!frame || !frame.contentWindow) { reject(new Error('程式視窗不在了')); return; }
      var id = 'act-' + Math.random().toString(36).slice(2, 10);
      var settled = false;
      function finish(fn, v) {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMsg);
        fn(v);
      }
      function onMsg(e) {
        if (e.source !== frame.contentWindow) return;
        var m = e.data;
        if (!m || m.aios !== 6 || m.id !== id) return;
        if (m.error) finish(reject, new Error(m.error));
        else finish(resolve, m.result);
      }
      window.addEventListener('message', onMsg);
      setTimeout(function () {
        finish(reject, new Error('動作 ' + action + ' 沒有在時限內回應'));
      }, budget || 120000);
      frame.contentWindow.postMessage({ aios: 5, id: id, action: action, args: args || {} }, '*');
    });
  }

  /** One round trip to the frame's probe. Resolves null if it does not answer. */
  function askSmoke(frame, phase, budget) {
    return new Promise(function (resolve) {
      var settled = false;
      function finish(v) {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMsg);
        resolve(v);
      }
      function onMsg(e) {
        if (e.source !== frame.contentWindow) return;
        var m = e.data;
        if (!m || m.aios !== 4 || m.phase !== phase) return;
        finish(m.smoke || {});
      }
      window.addEventListener('message', onMsg);
      setTimeout(function () { finish(null); }, budget || 4000);
      frame.contentWindow.postMessage({ aios: 3, phase: phase }, '*');
    });
  }

  /**
   * Run the candidate for real, off-screen, before anything is written to disk.
   *
   * The static checks read the source; this one uses the program. Both are
   * needed, and this one exists because the gap between them shipped: a ledger
   * whose every check passed rendered perfectly and did nothing at all, because
   * its <form> could not submit inside the frame it was given.
   *
   * Returns a list of problems in the same shape as `validate`, so the caller
   * treats a program that does not work exactly like one that does not comply.
   */
  async function smokeTest(code, capabilities, libs) {
    var id = 'smoke-' + Math.random().toString(36).slice(2, 10);
    var frame = document.createElement('iframe');
    // The same sandbox as the real thing, from the same constant. Anything more
    // permissive here would test a frame that never ships.
    frame.setAttribute('sandbox', FRAME_SANDBOX);
    frame.setAttribute('title', '冒煙測試');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:900px;height:700px;' +
      'border:0;visibility:hidden;pointer-events:none';

    var ready = false;
    var failure = null;
    var token = null;
    var detach = null;
    var ctx = {
      win: null,
      setTitle: function () {},
      toast: function () {},
      api: {
        markReady: function () { ready = true; },
        reportError: function (msg) { if (!failure) failure = String(msg); }
      }
    };

    try {
      // The same libraries the installed program will load, or the test is of
      // a different program.
      var pub = await A.forge.frame(id, frameHtml(code, libs));
      if (!pub || !pub.ok) {
        return ['無法建立測試用的頁面：' + ((pub && pub.error) || '未知原因')];
      }
      token = pub.data.token;
      document.body.appendChild(frame);
      detach = stubBroker(frame, { id: id, capabilities: capabilities || [] }, ctx);

      var loaded = new Promise(function (res) {
        frame.addEventListener('load', res, { once: true });
      });
      frame.src = pub.data.url;
      await Promise.race([loaded, wait(8000)]);

      // render() runs from the frame's own bootstrap; ui.ready comes back here.
      for (var i = 0; i < 100 && !ready && !failure; i++) await wait(80);
      if (failure) return ['程式一跑起來就出錯：' + failure];
      if (!ready) return ['程式在 8 秒內沒有完成 render()，畫面不會出現'];

      var problems = [];

      /* Wait for the first paint out here, not in the frame. An async render
         draws after an await and a timer-driven one draws later still, so the
         check has to be given time -- and the frame's own timers are throttled
         because it is not painted, which is why the pacing lives on this side. */
      var probe = null;
      for (var t = 0; t < 24; t++) {
        probe = await askSmoke(frame, 'probe');
        if (!probe) return ['冒煙測試無法取得畫面狀態，程式可能卡住了'];
        if (probe.fatal) return [probe.fatal];
        if (probe.drawn) break;
        await wait(80);
      }
      if (!probe.drawn) problems.push('render() 跑完了，但畫面上沒有任何看得見的東西');

      if (probe.forms) {
        var form = await askSmoke(frame, 'form');
        if (form && !form.formOk) {
          problems.push('這個程式用 <form> 收輸入，但視窗的 sandbox 不允許送出表單，' +
            '所以 submit 處理器永遠不會執行，按鈕會完全沒有反應');
        }
      }

      /* One rejection reaches here twice -- the frame reports it through ui.error
         and the probe catches it as well -- so the key is the message itself,
         not the sentence wrapped around it. Two prefixes for one fault reads as
         two faults, and the model is asked to fix both. */
      var seen = {};
      function add(prefix, msg) {
        var key = String(msg);
        if (seen[key]) return;
        seen[key] = 1;
        problems.push(prefix + key);
      }

      /* The program's own test of itself, run before anything is pressed so it
         sees the state it was written against. The clicks below prove the
         program does not crash; only this proves it does what it claims -- a
         ledger that adds a row and then shows the wrong total throws nothing.
         The forge requires the action to exist; here it is run if it does, so a
         program without one (the hand-written ones in the e2e suite) is judged
         on the rest. A test that never answers is a failed test: the frame is
         not painted and its timers are throttled, which is why the rules tell
         the program not to wait in here. */
      var actions = await askAction(frame, '__list', {}, 4000).catch(function () { return null; });
      if (actions && actions.selfTest) {
        try {
          await askAction(frame, 'selfTest', {}, 20000);
        } catch (err) {
          add('自我測試失敗：', String((err && err.message) || err));
        }
      }

      /* Order matters: the values have to be in the fields before the buttons
         are pressed, or the submit handler reads an empty form. */
      await askSmoke(frame, 'fill');

      var clicked = await askSmoke(frame, 'click', 8000);
      if (!clicked) return ['按下按鈕之後程式沒有回應，可能卡在某個處理器裡'];

      // Handlers are async by contract, so their errors land after the click.
      await wait(1200);
      var report = await askSmoke(frame, 'collect');
      if (!report) return ['冒煙測試逾時：按下按鈕之後沒有任何回報，程式可能卡住了'];

      if (failure) add('操作時程式回報錯誤：', failure);
      (report.violations || []).slice(0, 3).forEach(function (v) {
        add('操作時被內容安全政策擋下：', v);
      });
      (report.errors || []).slice(0, 3).forEach(function (e) {
        add('按下按鈕時發生錯誤：', e);
      });
      return problems;
    } catch (e) {
      return ['冒煙測試無法進行：' + ((e && e.message) || e)];
    } finally {
      if (detach) { try { detach(); } catch (e) { /* already gone */ } }
      if (frame.parentNode) frame.parentNode.removeChild(frame);
      // Revoke last: the token is what makes the page reachable at all.
      if (token) { try { await A.forge.frameRevoke(token); } catch (e) { /* nothing to revoke */ } }
    }
  }

  /**
   * The sources of a program's pinned libraries, from main, which refuses a
   * file whose hash no longer matches the record. Returns [{global, source}]
   * in manifest order; a library that cannot be read is reported, not skipped
   * silently -- the program would fail on the first call into it anyway.
   */
  async function loadLibs(libs) {
    var out = [];
    for (var i = 0; i < (libs || []).length; i++) {
      var l = libs[i];
      // eslint-disable-next-line no-await-in-loop
      var r = await A.forge.libSource(l.key);
      if (!r || !r.ok) throw new Error('套件 ' + (l.name || l.key) + ' 讀不到：' + ((r && r.error) || '未知原因'));
      out.push({ global: l.global, name: l.name, version: l.version, source: r.data.source });
    }
    return out;
  }

  AIOS.appshell = {
    frameHtml: frameHtml,
    loadLibs: loadLibs,
    broker: broker,
    askAction: askAction,
    smokeTest: smokeTest,
    FRAME_SANDBOX: FRAME_SANDBOX,
    GRANTS: GRANTS,
    capsOf: function (list) { return (list || []).filter(function (c) { return GRANTS[c]; }); },

    /**
     * Static checks run before code is ever installed.
     *
     * `caps` is what the manifest declares. Passing it catches the mismatch that
     * broke the first generated calculator: the plan said 「能力：無」, the code called
     * os.storage.set anyway, and nothing noticed until the broker refused it in
     * the middle of a calculation. Declaring nothing and then calling something is
     * a fault in the program, and it is visible in the source, so it belongs here
     * rather than in a toast at runtime.
     */
    validate: function (code, caps) {
      var problems = [];
      var src = String(code || '');

      if (arguments.length > 1) {
        var declared = (caps || []).filter(function (c) { return GRANTS[c]; });
        var wanted = {};
        Object.keys(NEEDS).forEach(function (call) {
          // os.storage.set( -- the call as it appears in generated code.
          var re = new RegExp(call.replace(/\./g, '\\.') + '\\s*\\(');
          if (re.test(src)) wanted[NEEDS[call]] = true;
        });
        Object.keys(wanted).forEach(function (cap) {
          if (declared.indexOf(cap) < 0) {
            problems.push('程式用了 os.' + GRANTS[cap][0].split('.')[0] +
              '.*，但 capabilities 沒有宣告「' + cap + '」');
          }
        });
      }
      if (!/function\s+render\s*\(/.test(src) && !/render\s*=\s*function/.test(src)) {
        problems.push('沒有定義 render(root, os) 函式');
      }
      var banned = [
        [/\bfetch\s*\(/, '不能用 fetch'],
        [/XMLHttpRequest/, '不能用 XMLHttpRequest'],
        [/\beval\s*\(/, '不能用 eval'],
        [/new\s+Function\s*\(/, '不能用 new Function'],
        [/\bimport\s*\(/, '不能用動態 import'],
        [/\brequire\s*\(/, '不能用 require'],
        [/\bWebSocket\b/, '不能用 WebSocket'],
        [/\bdocument\s*\.\s*cookie/, '不能存取 cookie'],
        [/\blocalStorage\b/, '請用 os.storage 而不是 localStorage']
      ];
      banned.forEach(function (b) { if (b[0].test(src)) problems.push(b[1]); });

      /* `parent` and `top` are the host window, and the frame cannot reach them
         anyway -- the rule is here so the model is told before the engine
         refuses. But a program that names a local `parent` (the obvious name
         for the element it is appending into) is not reaching for the window,
         and `\bparent\s*\.` flagged exactly that: a ledger build failed the
         same way twice running, the message named nothing the model could act
         on, and the whole spec went back for re-planning over a variable name.
         So: a bare reference (nothing but whitespace or an operator before it)
         to a name the program never declared. */
      ['parent', 'top'].forEach(function (name) {
        var declared = new RegExp('\\b(?:var|let|const)\\s+' + name + '\\b|' +
          '\\b(?:var|let|const)\\s+[^;]*[,{]\\s*' + name + '\\b|' +
          '\\bfunction\\b[^(]*\\([^)]*\\b' + name + '\\b|' +
          '\\(([^()]*,\\s*)?' + name + '\\s*(,[^()]*)?\\)\\s*=>|' +
          '\\b' + name + '\\s*=>').test(src);
        if (declared) return;
        var bare = new RegExp('(?:^|[^\\w$.])' + name + '\\s*\\.').test(src);
        if (bare) problems.push('不能存取 ' + name);
      });
      if (src.length > 200000) problems.push('程式碼太長');
      return problems;
    }
  };
})();
