/* ===========================================================================
   Press a button on the machine's own confirmation dialog.
   ---------------------------------------------------------------------------
   The three questions AI-OS stops to ask (empty the trash, install with the
   switch on, import somebody's program) are drawn by main/askbox.js as a
   WebContentsView inside the window. A webContents is a CDP target, so a test
   finds the dialog by its document, reads what it says and clicks the button
   -- the way a person would. Before this the dialog was a native message box
   no test could reach, and the suite answered it from a launch argument.
   =========================================================================== */

import { connect, run, targets, until } from './cdp.mjs';

const DOC = /askbox\.html/;

/**
 * Wait for the dialog to appear, then press the button whose label starts with
 * `label`. Resolves with what the dialog said -- title, text, buttons -- so a
 * spec can assert on the question as well as answer it.
 */
export async function pressDialog(port, label, { timeout = 30000 } = {}) {
  const target = await until(async () => {
    const list = await targets(port);
    return list.find((t) => DOC.test(t.url) && t.webSocketDebuggerUrl) || null;
  }, { timeout, what: `確認視窗出現（要按「${label}」）` });

  const dlg = await connect(target.webSocketDebuggerUrl);
  try {
    /* The buttons are rendered once the payload has arrived, a moment after
       the document exists. The click is deferred so this evaluation's answer
       leaves the page before the main process takes the page down. */
    const r = await until(() => run(dlg, `
      var bs = [].slice.call(document.querySelectorAll('.dlg-actions button'));
      if (!bs.length) return null;
      var said = {
        title: document.getElementById('title').textContent,
        bar: document.getElementById('bar-title').textContent,
        text: document.getElementById('body').textContent,
        buttons: bs.map(function (b) { return b.textContent; }),
        theme: document.documentElement.getAttribute('data-theme')
      };
      var hit = bs.filter(function (b) { return b.textContent.indexOf(${JSON.stringify(label)}) === 0; })[0];
      if (!hit) return { error: '沒有這顆按鈕', said: said };
      said.pressed = hit.textContent;
      setTimeout(function () { hit.click(); }, 0);
      return said;
    `), { timeout, what: '確認視窗的按鈕' });
    if (r.error) {
      /* Not left on screen: the caller awaiting the answer would hang until
         its own timeout and the next spec would find a dialog it did not open.
         Escape is the cancel button, and the main process treats it as such. */
      await dlg.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
      throw new Error(`${r.error}「${label}」，視窗上有：${r.said.buttons.join(' / ')}（已用 Esc 取消）`);
    }
    return r;
  } finally {
    try { dlg.close(); } catch { /* the view is already gone */ }
  }
}

/** Whether a confirmation dialog is on screen right now. */
export async function dialogOpen(port) {
  const list = await targets(port).catch(() => []);
  return list.some((t) => DOC.test(t.url));
}
