'use strict';

/* ===========================================================================
   AI-OS // consent window view
   ---------------------------------------------------------------------------
   Renders the pending request and reports exactly one answer. Escape and the
   window's close button both count as a refusal, which the main process also
   enforces independently.
   =========================================================================== */

/* global document, window, consent */

(function () {
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const body = document.getElementById('body');
  const allow = document.getElementById('allow');
  const deny = document.getElementById('deny');

  let answered = false;
  function answer(granted) {
    if (answered) return;
    answered = true;
    allow.disabled = true;
    deny.disabled = true;
    consent.respond(granted);
  }

  allow.addEventListener('click', () => answer(true));
  deny.addEventListener('click', () => answer(false));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); answer(false); }
    if (e.key === 'Enter' && document.activeElement === allow) { e.preventDefault(); answer(true); }
    if (e.key === 'Tab') {
      e.preventDefault();
      (document.activeElement === deny ? allow : deny).focus();
    }
  });

  /**
   * A batch: one question about many operations, with all of them listed.
   *
   * Rendered here rather than in the shell because this window is the one the
   * gate is entitled to believe. A hundred separate prompts would be the same
   * information at a hundredth of the attention.
   */
  function renderBatch(p) {
    const b = p.batch;
    body.appendChild(el('p', null,
      `核心要一次做 ${b.count} 次「${p.desc || p.op}」。`));
    body.appendChild(el('p', 'dlg-why',
      `這個能力（${p.cap}）做了收不回來，所以整批只問這一次 —— 下面是完整清單，` +
      '不想做的可以逐列取消勾選。'));

    const keep = b.rows.map(() => true);
    const count = el('p', 'dlg-count');
    const list = el('ul', 'dlg-list');

    function sync() {
      const n = keep.filter(Boolean).length;
      count.textContent = `已勾選 ${n} / ${b.count}`;
      allow.textContent = n ? `執行 ${n} 次` : '沒有勾選任何一列';
      allow.disabled = !n;
      consent.keep(keep.map((v, i) => (v ? i : -1)).filter((i) => i >= 0));
    }

    b.rows.forEach((row, i) => {
      const li = el('li', 'dlg-row');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.addEventListener('change', () => { keep[i] = cb.checked; sync(); });
      li.appendChild(cb);
      li.appendChild(el('span', 'dlg-row-main', `${i + 1}.　${row.main || '(未命名)'}`));
      if (row.extra) li.appendChild(el('span', 'dlg-row-extra', row.extra));
      list.appendChild(li);
    });

    body.appendChild(count);
    body.appendChild(list);

    if (b.sample) {
      const det = el('details', 'dlg-sample');
      det.appendChild(el('summary', null, '看第一列實際的內容'));
      det.appendChild(el('pre', 'dlg-pre', b.sample));
      body.appendChild(det);
    }

    if (p.taint) {
      body.appendChild(el('p', 'dlg-alert',
        '⚠ ' + p.reason + '。這批動作可能是被那份內容促成的，請自己確認一次再放行。'));
    }
    sync();
  }

  consent.payload().then((p) => {
    if (!p) { answer(false); return; }

    if (p.batch) {
      renderBatch(p);
      deny.focus();
      return;
    }

    body.appendChild(el('p', null, p.desc ? `核心想要${p.desc}。` : '核心要求一個需要授權的動作。'));

    const dl = el('dl');
    const row = (k, v) => {
      dl.appendChild(el('dt', null, k));
      dl.appendChild(el('dd', null, String(v)));
    };
    row('SYSCALL', p.op);
    row('CAPABILITY', p.cap || '—');
    Object.keys(p.args || {}).forEach((k) => {
      if (k.startsWith('__')) return;
      const v = p.args[k];
      /* Anything, drawn as text. JSON.stringify(undefined) is undefined, and a
         throw here used to land in the catch below, which refused the request
         as if the person had. */
      const s = typeof v === 'string' ? v : (v === undefined ? '（空）' : String(JSON.stringify(v)));
      row(k.toUpperCase(), s.length > 260 ? s.slice(0, 260) + '…' : s);
    });
    body.appendChild(dl);

    if (p.why) body.appendChild(el('p', 'dlg-why', '理由：' + p.why));

    if (p.taint) {
      body.appendChild(el('p', 'dlg-alert',
        '⚠ ' + p.reason + '。這份計畫可能是被那份內容寫出來的，請自己確認一次再放行。'));
    } else {
      body.appendChild(el('p', 'dlg-why', p.reason));
    }

    deny.focus();
  }).catch((e) => {
    /* A request this window cannot draw is still a request, and the person is
       still the one to answer it. Refusing here on their behalf is how a
       rendering bug became months of silent refusals that the journal blamed
       on the user; say what happened and leave both buttons where they are. */
    body.appendChild(el('p', 'dlg-alert',
      '⚠ 這個視窗畫不出請求的內容（' + ((e && e.message) || e) + '）。看不清楚就按拒絕。'));
    deny.focus();
  });

  window.addEventListener('beforeunload', () => {
    if (!answered) consent.respond(false);
  });
})();
