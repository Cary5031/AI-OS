'use strict';

/* ===========================================================================
   AI-OS // askBox view
   ---------------------------------------------------------------------------
   The document inside the confirmation layer (main/askbox.js). It renders the
   one question it was opened for and reports exactly one answer: the index of
   the button pressed. Escape answers with the cancel button, and so does the
   main process on its own if this document goes away unanswered.

   It runs in a WebContentsView the main process owns, over the shell, and
   wears the shell's theme: the payload carries the colour variables the shell
   is painting with, and they are set on the root here so os.css draws the card
   exactly as the shell would have.
   =========================================================================== */

/* global document, window, askbox */

(function () {
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const root = document.documentElement;
  const card = document.getElementById('card');
  const kind = document.getElementById('kind');
  const barTitle = document.getElementById('bar-title');
  const title = document.getElementById('title');
  const body = document.getElementById('body');
  const actions = document.getElementById('actions');

  const KIND = { question: 'CONFIRM', warning: 'WARNING', info: 'NOTICE' };

  let answered = false;
  /* Until the question arrives there is no cancel button to name; -1 is not
     an index, and the main process treats anything that is not one as the
     cancel it knows. So an Escape before the payload cannot pick button 0. */
  let cancelId = -1;
  let buttons = [];
  let lastFocused = null;

  function answer(index) {
    if (answered) return;
    answered = true;
    buttons.forEach((b) => { b.disabled = true; });
    askbox.respond(index);
  }

  /* The shell's colours, as custom properties on the root. os.css derives
     everything else from these, so nothing here knows what a theme is. */
  function wear(theme) {
    if (!theme) return;
    root.setAttribute('data-theme', theme.id || 'void');
    const vars = theme.vars || {};
    Object.keys(vars).forEach((k) => root.style.setProperty('--' + k, vars[k]));
    if (theme.light) root.setAttribute('data-light', '');
    else root.removeAttribute('data-light');
  }

  function render(p) {
    cancelId = p.cancelId;
    wear(p.theme);
    card.classList.add('dlg-' + p.type);
    kind.textContent = KIND[p.type] || KIND.question;
    barTitle.textContent = p.title;
    title.textContent = p.message;

    /* Blank lines separate paragraphs; single line breaks and leading spaces
       inside a paragraph are kept (the capability list is indented). */
    String(p.detail || '').split(/\n{2,}/).forEach((para) => {
      if (para.trim()) body.appendChild(el('p', 'dlg-para', para));
    });

    /* One affirmative answer is the primary button; a warning's is drawn in
       the warning colour. Several (取代 / 另外安裝) are equal choices and none
       is the default, so they are outlined rather than one being filled. A
       lone button is the only way out and is drawn as such, whatever its id. */
    const affirmative = p.buttons.filter((_, i) => i !== p.cancelId).length;
    p.buttons.forEach((label, i) => {
      let cls = 'btn';
      if (i !== p.cancelId || p.buttons.length === 1) {
        if (affirmative > 1) cls += ' btn-choice';
        else cls += p.type === 'warning' ? ' btn-warn' : ' btn-primary';
      }
      const b = el('button', cls, label);
      b.type = 'button';
      b.dataset.index = String(i);
      b.addEventListener('click', () => answer(i));
      b.addEventListener('focus', () => { lastFocused = b; });
      actions.appendChild(b);
      buttons.push(b);
    });
    (buttons[p.defaultId] || buttons[0]).focus();
  }

  /* A click that is not on a button is not an answer and must not take the
     keyboard with it: Enter and the arrows keep working on the button that
     had the focus. The dim area cannot take focus at all; the card's text can
     still be selected and copied, and gets the focus back once the mouse is
     up. */
  document.addEventListener('mousedown', (e) => {
    if (!card.contains(e.target)) e.preventDefault();
  });
  document.addEventListener('mouseup', () => {
    if (document.activeElement === document.body && lastFocused && !answered) lastFocused.focus();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); answer(cancelId); return; }
    /* Arrows walk the buttons; Tab does the same through the browser, because
       nothing else in this document can take focus. */
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const at = buttons.indexOf(document.activeElement);
      if (at < 0 || !buttons.length) return;
      e.preventDefault();
      const n = buttons.length;
      buttons[(at + (e.key === 'ArrowRight' ? 1 : n - 1)) % n].focus();
    }
  });

  askbox.payload().then((p) => {
    if (!p) { askbox.respond(-1); return; }   // not our question: refuse to show anything
    render(p);
  }).catch(() => askbox.respond(-1));

  window.addEventListener('beforeunload', () => {
    if (!answered) askbox.respond(cancelId);
  });
})();
