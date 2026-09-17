'use strict';

/* ===========================================================================
   AI-OS // 貢獻點
   ---------------------------------------------------------------------------
   The third layer of "a program that is not limited to the features it shipped
   with" (TODO.md item 4). The first two let an extension *read* what a built-in
   program knows -- actions hand back data now, and say what shape it is. This
   one lets an extension change what a built-in window *shows* and *offers*.

   THE PROBLEM WITH THE OBVIOUS ANSWER

   The obvious answer is to let the forge edit apps/mail.js. That is refused, and
   not on taste: renderer code is trusted code. A generated program runs in a
   sandboxed frame with no `allow-same-origin`, brokered capabilities and a hash
   that has to be approved; a patch to apps/mail.js runs in this document, with
   the shell's own authority, next to the capability gate it would be bypassing.
   The isolation is the product. And a patch would collide with every update,
   with the conflict landing on the person least equipped to resolve it.

   WHAT A CONTRIBUTION IS INSTEAD

   A host declares a slot: a named place in its window, what it will hand over,
   and what it wants back. An installed program declares that it contributes to
   that slot. Two kinds, because "add a line of text" and "add a thing to do"
   have different safety properties and must not be one mechanism:

     annotate   The host hands over the units it is drawing (rows, pages,
                entries) and gets one line of text per unit back. Answered from
                a frame this module owns, built with NO capabilities, under a
                deadline. The host draws the text itself.
     act        The host offers a labelled item in its right-click menu. Chosen,
                the unit under the cursor is handed to the extension's own
                `slotAct` action -- in the extension's own window, with its own
                declared capabilities, through the same app.do path a plan uses.
                Nothing runs until a person picks it.

   And one line neither kind may cross: a contribution ADDS. It never hides,
   replaces or reorders what the host shows. An extension able to hide a message
   or swap a link's target inside the mail window would be a phishing tool, and
   text-only rendering would not stop it. Hosts that filter on a contribution
   mark rows; they do not drop them.

   PROVENANCE

   Every contributed line and every contributed menu item carries the
   extension's icon and, on hover, its name. A line under a mail row that reads
   「寄件人已驗證」 with nothing to say who wrote it is the mail program
   appearing to say it, and an extension must not be able to borrow that voice.

   WHO IS ALLOWED TO CONTRIBUTE, AND WHEN

   A program built by the forge on this machine contributes as soon as it is
   installed: the person asked for it three seconds ago. A program that arrived
   as a package (.aiosapp) has its contributions OFF until the person turns them
   on -- the same distinction the import flow already draws for capabilities,
   and for the same reason: a manifest somebody else wrote is not a request the
   person made. Either way the switch is in the host window's own menu, next to
   the thing it affects, and a contribution that stops answering is switched off
   for the session with the reason on the switch.

   AND THE BUDGET

   Annotation runs while a list is being drawn, so it is on a path where being
   slow is the same as being broken. One render has a hard deadline; a
   contributor that misses it is dropped for the rest of the session and said
   so once. The host's own list is never allowed to fail because somebody's
   extension did.
   =========================================================================== */

/* global window, document, AIOS */

(function () {
  var A = window.aios;

  /* How long one contributor has to answer while a list waits. 1.2 seconds is
     already beyond what anybody would call responsive; it is the line past
     which something is wrong, not a target. */
  var DEADLINE_MS = 1200;

  /* How long one contributed string may be, and how many a single render may
     carry back. Here rather than in the host: a host that forgot would hand a
     whole mailbox to a frame, or paint an unbounded string into a row. */
  var MAX_TEXT = 200;
  var MAX_ITEMS = 200;

  /* name -> { name, host, kind, desc, gives, wants, unitAt } */
  var slots = {};
  /* appId -> { frame, detach, ready, dead, why, name, starting } */
  var runners = {};
  /* The installed programs that contribute anywhere, as forge.list() last said.
     Cached because a menu is built synchronously; refreshed on every render and
     every toggle, so it is at most one draw stale. */
  var catalog = [];
  /* slot -> { rows, into } : the last annotate() call, kept so a toggle can
     repaint the slot without the host redrawing. */
  var last = {};
  var tokens = {};
  /* slot -> [elements this module put on screen], for removal on repaint. */
  var drawn = {};

  /* Written as a loop rather than a character-class regex, because the class
     would need \u escapes and this file is edited through tools that eat them.
     Same set as mailask.text(): control characters, the zero-width family, the
     line separators and the bidi overrides. */
  function clean(v, max) {
    var s = String(v == null ? '' : v);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      var bad = c < 32 || c === 127 || (c >= 0x200b && c <= 0x200f) ||
        c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e);
      out += bad ? ' ' : s.charAt(i);
    }
    return out.replace(/\s+/g, ' ').trim().slice(0, max || MAX_TEXT);
  }

  /* A slot name is `<host>:<place>`, lower case. Two halves because a bare name
     would eventually collide across programs, and because a contribution that
     names its host is a contribution somebody can reason about. */
  var SLOT_NAME = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

  /**
   * A host declares a place in its window that extensions may write into.
   *
   * `gives` and `wants` are one-line shapes, exactly like an action's `args` and
   * `returns` -- for the same reason: a contribution written against a guess is
   * a contribution that silently renders nothing. `unitAt(ev)` is for `act`
   * slots: given the right-click event, the unit under the cursor, or null.
   */
  function declare(name, spec) {
    var id = String(name || '').toLowerCase();
    if (!SLOT_NAME.test(id)) throw new Error('貢獻點的名字要寫成 host:place：' + name);
    var kind = spec && spec.kind === 'act' ? 'act' : 'annotate';
    slots[id] = {
      name: id,
      host: id.split(':')[0],
      kind: kind,
      desc: clean((spec && spec.desc) || '', 200),
      gives: clean((spec && spec.gives) || '', 300),
      wants: clean((spec && spec.wants) || '', 300),
      unitAt: kind === 'act' && spec && typeof spec.unitAt === 'function' ? spec.unitAt : null
    };
    return slots[id];
  }

  /** Every declared slot, without the resolver (that is DOM-bound and private). */
  function declared() {
    return Object.keys(slots).map(function (k) {
      var s = slots[k];
      return { name: s.name, host: s.host, kind: s.kind, desc: s.desc, gives: s.gives, wants: s.wants };
    });
  }

  /* ------------------------------------------------------------ catalogue */

  async function refresh() {
    var res;
    try { res = await A.forge.list(); } catch (e) { return catalog; }
    if (!res || !res.ok) return catalog;
    var all = Array.isArray(res.data) ? res.data : (res.data && res.data.apps) || [];
    catalog = all.filter(function (app) {
      return app && (app.id || app.slug) && Array.isArray(app.contributes) && app.contributes.length;
    }).map(function (app) {
      return {
        id: app.id || app.slug,
        name: app.name || app.id || app.slug,
        icon: app.icon || '◈',
        purpose: app.purpose || '',
        imported: !!app.imported,
        contributes: app.contributes.slice(),
        slotsOff: Array.isArray(app.slotsOff) ? app.slotsOff.slice() : [],
        slotLabels: app.slotLabels && typeof app.slotLabels === 'object' ? app.slotLabels : {}
      };
    });
    return catalog;
  }

  function enabledFor(app, slot) {
    return app.contributes.indexOf(slot) >= 0 && app.slotsOff.indexOf(slot) < 0;
  }

  /** Every installed program that names this slot, on or off, from the cache. */
  function allFor(slot) {
    return catalog.filter(function (app) { return app.contributes.indexOf(slot) >= 0; });
  }

  /** Installed programs that write into this slot right now. Refreshes first. */
  async function contributorsOf(name) {
    var id = String(name || '').toLowerCase();
    if (!slots[id]) return [];
    await refresh();
    return allFor(id).filter(function (app) {
      return enabledFor(app, id) && !(runners[app.id] && runners[app.id].dead);
    });
  }

  /** The label an extension gave its item for this slot, or its own name. */
  function labelFor(app, slot) {
    return clean(app.slotLabels[slot] || app.name, 40);
  }

  /* ---------------------------------------------------------------- frames */

  /**
   * The frame one contributor answers annotations from, built once and kept.
   *
   * `capabilities: []` is the whole security argument in one argument: the
   * broker is the same brokered surface the program's own window uses, and with
   * nothing declared it refuses everything but the calls that cannot leave the
   * frame. The program was granted more than this when it was installed; an
   * annotation runs with less, because it is answering a question about a row
   * somebody already handed it.
   */
  async function runnerFor(appId) {
    var held = runners[appId];
    if (held && held.dead) return null;
    if (held && held.ready) return held;
    if (held && held.starting) return held.starting;

    var starting = (async function () {
      var loaded = await A.forge.load(appId);
      /* Two `ok`s, and both matter. The outer one is the IPC's; the inner one is
         forge.load's own, and it is false when app.js on disk no longer hashes
         to what was approved -- in which case `data.code` is the string
         'EINTEGRITY', not source. A contribution is exactly where that would go
         unnoticed, because nobody opened a window to see the warning. */
      if (!loaded || !loaded.ok || !loaded.data || loaded.data.ok !== true || !loaded.data.code) {
        return kill(appId, (loaded && loaded.data && loaded.data.error) || '讀不到這個程式的程式碼');
      }
      var app = loaded.data;
      var appName = (app.manifest && app.manifest.name) || appId;
      var html = AIOS.appshell.frameHtml(app.code, app.libs || []);
      /* A slug of its own: publishing revokes the app's previous frame URL, so
         sharing one with the program's real window would knock that window out
         the moment a list drew. */
      var pub = await A.forge.frame('slot-' + appId, html);
      if (!pub || !pub.ok) return kill(appId, '建不出貢獻點要用的頁面');

      var frame = document.createElement('iframe');
      frame.setAttribute('sandbox', AIOS.appshell.FRAME_SANDBOX);
      frame.setAttribute('title', appName + '（貢獻點）');
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:600px;height:400px;' +
        'border:0;visibility:hidden;pointer-events:none';

      var ready = false;
      var ctx = {
        win: null,
        setTitle: function () {},
        toast: function () {},
        api: { markReady: function () { ready = true; }, reportError: function () {} }
      };

      document.body.appendChild(frame);
      var detach = AIOS.appshell.broker(frame, { id: 'slot-' + appId, capabilities: [] }, ctx);
      var landed = new Promise(function (res) {
        frame.addEventListener('load', res, { once: true });
      });
      frame.src = pub.data.url;
      await Promise.race([landed, wait(6000)]);
      for (var i = 0; i < 60 && !ready; i++) await wait(50);

      var rec = runners[appId];
      if (!rec) return null;
      if (!ready) {
        try { detach(); frame.remove(); } catch (e) { /* it was never there */ }
        return kill(appId, '程式沒有在時限內完成 render()');
      }
      rec.frame = frame;
      rec.detach = detach;
      rec.ready = true;
      rec.starting = null;
      rec.name = appName;
      return rec;
    })();

    runners[appId] = { starting: starting, ready: false, dead: false, name: appId };
    return starting;
  }

  /**
   * Stop asking this program, and say why once.
   *
   * A contributor that cannot answer is dropped for the session rather than
   * retried: the caller is a list being drawn, and a retry on every draw turns
   * one broken extension into a window that stutters. The reason is kept, and
   * the host's menu shows it on the switch, where turning it back on retries.
   */
  function kill(appId, why) {
    var rec = runners[appId] || (runners[appId] = {});
    if (!rec.dead) {
      rec.dead = true;
      rec.why = clean(why, 120);
      if (AIOS.ui) {
        AIOS.ui.trace('貢獻點：「' + (rec.name || appId) + '」停用了（' + rec.why + '）', 't-warn');
      }
    }
    if (rec.frame) {
      try { if (rec.detach) rec.detach(); rec.frame.remove(); } catch (e) { /* gone already */ }
      rec.frame = null;
    }
    return null;
  }

  /** Drop a program's frame and its session state: uninstalled, rebuilt, retried. */
  function forget(appId) {
    var rec = runners[appId];
    if (!rec) return;
    if (rec.frame) {
      try { if (rec.detach) rec.detach(); rec.frame.remove(); } catch (e) { /* gone already */ }
    }
    delete runners[appId];
  }

  /** Why a program is not being asked this session, or null. */
  function status(appId) {
    var rec = runners[appId];
    return rec && rec.dead ? { dead: true, why: rec.why || '' } : null;
  }

  function wait(ms) {
    return new Promise(function (r) { window.setTimeout(r, ms); });
  }

  /* -------------------------------------------------------------- annotate */

  /**
   * Ask every enabled contributor what to write into this slot.
   *
   * Answers are `{ appId, name, icon, items }`, where `items` is a list of
   * strings as long as whatever the host handed over -- one per unit, empty
   * where the contribution had nothing to say. A contributor that fails is
   * dropped and simply absent; the host draws what came back and nothing about
   * its own window depends on any of it.
   */
  async function render(name, payload) {
    var id = String(name || '').toLowerCase();
    if (!slots[id]) return [];
    var apps;
    try {
      apps = await contributorsOf(id);
    } catch (e) {
      return [];
    }
    if (!apps.length) return [];

    var out = [];
    for (var i = 0; i < apps.length; i++) {
      /* Serial, not parallel. Two contributors are already unusual; the cost of
         getting this wrong is a list that waits on the slowest of N frames, and
         the deadline below is per contributor. */
      // eslint-disable-next-line no-await-in-loop
      var got = await askOne(apps[i], id, payload);
      if (got) out.push(got);
    }
    return out;
  }

  async function askOne(app, slot, payload) {
    var appId = app.id;
    var rec;
    try {
      rec = await runnerFor(appId);
    } catch (e) {
      kill(appId, '啟動失敗：' + (e.message || e));
      return null;
    }
    if (!rec || !rec.ready || !rec.frame) return null;

    var answer;
    try {
      answer = await AIOS.appshell.askAction(rec.frame, 'slotRender',
        { slot: slot, rows: (payload && payload.rows) || [] }, DEADLINE_MS);
    } catch (e) {
      /* A contribution that is slow is a contribution that is broken, as far as
         a list being drawn is concerned. The message tells the two apart even
         though the treatment is the same. */
      kill(appId, e.message || String(e));
      return null;
    }

    var items = answer && Array.isArray(answer.items) ? answer.items : null;
    if (!items) {
      kill(appId, 'slotRender 沒有回 { items: [...] }');
      return null;
    }
    return {
      appId: appId,
      name: app.name,
      icon: app.icon,
      items: items.slice(0, MAX_ITEMS).map(function (t) { return clean(t, MAX_TEXT); })
    };
  }

  /**
   * One contributed line, as every host draws it.
   *
   * textContent only, into elements this module makes, with the extension's
   * icon in front and its name on hover. One function so the provenance
   * marking cannot drift between hosts -- the host that forgot the icon would
   * be the host whose extensions can speak in its voice.
   */
  function element(c, text) {
    var line = document.createElement('div');
    line.className = 'slot-ext';
    var ico = document.createElement('span');
    ico.className = 'slot-ext-icon';
    ico.textContent = c.icon || '◈';
    ico.setAttribute('aria-hidden', 'true');
    line.appendChild(ico);
    line.appendChild(document.createTextNode(clean(text, MAX_TEXT)));
    line.title = '由擴充程式「' + clean(c.name, 60) + '」加上的';
    return line;
  }

  /**
   * Draw this slot's contributions under the host's units.
   *
   * `rows` is what the slot promised to give, one per unit; `into(i)` is the
   * element the i-th unit's line goes under, or null. Painting happens after
   * the host's own draw, never before it, and a late answer from a previous
   * draw is thrown away: the list redraws on every open, search and sync, and
   * a contributor answering late would otherwise write last search's lines
   * onto this search's rows -- which reads as the extension being wrong rather
   * than as the answer being stale.
   */
  function annotate(name, rows, into) {
    var id = String(name || '').toLowerCase();
    if (!slots[id] || typeof into !== 'function') return;
    var list = Array.isArray(rows) ? rows.slice(0, MAX_ITEMS) : [];
    var token = (tokens[id] || 0) + 1;
    tokens[id] = token;
    last[id] = { rows: list, into: into };
    unpaint(id);
    if (!list.length) return;
    render(id, { rows: list }).then(function (got) {
      if (tokens[id] !== token || !got || !got.length) return;
      var made = drawn[id] = [];
      for (var i = 0; i < list.length; i++) {
        var under = into(i);
        if (!under) continue;
        for (var k = 0; k < got.length; k++) {
          var text = got[k].items[i];
          if (!text) continue;
          var line = element(got[k], text);
          under.appendChild(line);
          made.push(line);
        }
      }
    }, function () { /* render never rejects; belt and braces */ });
  }

  function unpaint(id) {
    (drawn[id] || []).forEach(function (n) { try { n.remove(); } catch (e) { /* already gone */ } });
    drawn[id] = [];
  }

  /** Redraw one slot from the host's last call, after a switch was flipped. */
  function repaint(id) {
    var l = last[id];
    if (!l) return;
    annotate(id, l.rows, l.into);
  }

  /* ------------------------------------------------------------------- act */

  /**
   * Hand the unit under the cursor to an extension.
   *
   * Through app.do, on purpose: that opens the extension's own window if it is
   * not open, runs its `slotAct` in its own frame with its own declared
   * capabilities, and passes the same gate a plan would. There is no second
   * execution path here to audit. The person chose the item; the extension
   * does what it was already allowed to do.
   */
  async function act(name, appId, unit) {
    var id = String(name || '').toLowerCase();
    if (!slots[id] || slots[id].kind !== 'act') throw new Error('不是一個動作型的貢獻點：' + name);
    /* app.do finds programs by what the registry knows, and an installed
       program is registered there at boot and by the forge's own flows -- not
       by an install that arrived over IPC while the shell was running. A
       contribution that exists in the index but not in the registry would
       otherwise fail with 「沒有這個程式」 about a program the menu just
       offered, so it is registered here from the same catalogue the menu read. */
    if (!AIOS.apps.get('gen:' + appId) && AIOS.forge && AIOS.forge.registerGenerated) {
      var meta = catalog.filter(function (a) { return a.id === appId; })[0];
      if (meta) AIOS.forge.registerGenerated({ id: appId, name: meta.name, icon: meta.icon, purpose: meta.purpose });
    }
    return AIOS.exec['app.do']({
      app: appId,
      action: 'run',
      args: { action: 'slotAct', args: { slot: id, unit: unit } }
    });
  }

  /* ------------------------------------------------- document-shaped hosts */

  /**
   * The resolver for a window whose unit is "the open document": the host
   * leaves the unit on its body element whenever it repaints its status, and
   * the menu reads it back from the window the click landed in. Per window,
   * so two Markdown viewers do not answer for each other.
   */
  function bodyUnit(ev, instance) {
    var body = instance && instance.ctx && instance.ctx.body;
    return body && body.__slotUnit ? body.__slotUnit : null;
  }

  /**
   * A strip for contributed lines, right after an element (a status bar). Made
   * once and reused: a host that annotates on every status repaint must not
   * grow a new strip each time.
   */
  function barAfter(anchor) {
    if (!anchor || !anchor.parentNode) return null;
    var next = anchor.nextSibling;
    if (next && next.nodeType === 1 && next.classList && next.classList.contains('slot-bar')) return next;
    var bar = document.createElement('div');
    bar.className = 'slot-bar';
    anchor.parentNode.insertBefore(bar, anchor.nextSibling);
    return bar;
  }

  /* ---------------------------------------------------------------- switch */

  /**
   * Turn one program's contribution to one slot on or off, and keep it.
   *
   * Turning one on also forgets a session's "dead" verdict, so the switch is
   * how a person retries a contribution that timed out. The host's slot is
   * repainted from its last draw, so the change is visible without touching
   * the host.
   */
  async function setEnabled(appId, slot, on) {
    var id = String(slot || '').toLowerCase();
    if (on) forget(appId);
    try {
      await A.forge.setSlot(appId, id, !!on);
    } catch (e) {
      if (AIOS.ui) AIOS.ui.trace('擴充開關存不進去：' + (e.message || e), 't-err');
    }
    await refresh();
    repaint(id);
  }

  /* ------------------------------------------------------------------ menu */

  /**
   * What a host window's right-click menu gets from this module.
   *
   * Two groups, in this order: the act items for the unit under the cursor
   * (each carrying its extension's icon), then one switch per contribution to
   * any of this host's slots -- on, off, or off-for-the-session with the reason
   * as the hint. Built synchronously from the cache; the refresh kicked off
   * here is for the next menu, not this one.
   */
  function menuItems(def, ev, instance) {
    var host = def && def.id;
    if (!host) return [];
    var mine = Object.keys(slots).filter(function (k) { return slots[k].host === host; });
    if (!mine.length) return [];
    refresh();

    var items = [];
    mine.forEach(function (k) {
      var s = slots[k];
      if (s.kind !== 'act' || !s.unitAt) return;
      var unit = null;
      try { unit = s.unitAt(ev, instance); } catch (e) { unit = null; }
      if (!unit) return;
      allFor(k).forEach(function (app) {
        if (!enabledFor(app, k)) return;
        items.push({
          label: app.icon + ' ' + labelFor(app, k),
          hint: '擴充',
          run: function () {
            act(k, app.id, unit).then(function (r) {
              if (AIOS.ui && r && r.note) AIOS.ui.trace(r.note, 't-ok');
            }, function (e) {
              if (AIOS.ui) AIOS.ui.trace('擴充「' + app.name + '」：' + (e.message || e), 't-err');
            });
          }
        });
      });
    });

    var switches = [];
    mine.forEach(function (k) {
      var s = slots[k];
      allFor(k).forEach(function (app) {
        var on = enabledFor(app, k);
        var dead = status(app.id);
        var hint = '';
        if (dead) hint = '停用：' + dead.why + '，點一下重試';
        else if (!on && app.imported) hint = '匯入的，預設關';
        else if (!on) hint = '已關';
        switches.push({
          label: (on && !dead ? '☑' : '☐') + ' ' + app.icon + ' ' + app.name + '（' + s.desc + '）',
          hint: hint,
          run: function () { setEnabled(app.id, k, dead ? true : !on); }
        });
      });
    });

    var out = [];
    if (items.length) out = out.concat([{ sep: true }], items);
    if (switches.length) out = out.concat([{ sep: true }], switches);
    return out;
  }

  AIOS.slots = {
    declare: declare,
    declared: declared,
    refresh: refresh,
    contributorsOf: contributorsOf,
    render: render,
    annotate: annotate,
    element: element,
    act: act,
    setEnabled: setEnabled,
    menuItems: menuItems,
    bodyUnit: bodyUnit,
    barAfter: barAfter,
    status: status,
    forget: forget,
    SLOT_NAME: SLOT_NAME,
    DEADLINE_MS: DEADLINE_MS
  };
}());
