/* The image viewer and the interface preferences, driven for real.

   A picture in the sandbox used to open in the text editor as bytes. And the
   language and text size are the two settings that have to survive a cleared
   session, so they are checked through the main process, not the DOM alone. */

import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { run } from '../lib/cdp.mjs';

export const name = '圖片檢視器與介面偏好';

/* A real PNG of any size, built here rather than pasted: a hand-copied
   base64 that is one byte off decodes as "the file may be damaged", which
   is a fine message and a useless test. Opaque grey RGB, no filter. */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGB
  const raw = Buffer.alloc((1 + w * 3) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (1 + w * 3)] = 0;                 // filter: none
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]).toString('base64');
}
const PNG_1x1 = png(1, 1);
const PNG_2x1 = png(2, 1);
const DIR = '/notes/e2e-pics';

export async function spec(t, app) {
  const { cdp } = app;

  await t.test('圖片用圖片檢視器開，不是編輯器；同資料夾能前後張、縮放、旋轉', async () => {
    const r = await run(cdp, `
      await window.aios.fs.writeBytes('${DIR}/a.png', '${PNG_1x1}');
      await window.aios.fs.writeBytes('${DIR}/b.png', '${PNG_2x1}');
      await AIOS.afterFsChange();
      var claims = AIOS.apps.forPath('${DIR}/a.png');
      AIOS.apps.instances().filter(function (i) { return i.def.id === 'photos'; })
        .forEach(function (i) { AIOS.wm.close(i.win); });
      await AIOS.apps.openPath('${DIR}/a.png');
      var inst = null;
      for (var i = 0; i < 60 && !inst; i++) {
        inst = AIOS.apps.instances().find(function (x) { return x.def.id === 'photos' && x.ctrl && x.ctrl.getState().path === '${DIR}/a.png'; }) || null;
        if (!inst) await new Promise(function (r2) { setTimeout(r2, 100); });
      }
      if (!inst) return { error: '圖片檢視器沒開起來' };
      // The status line settles after the image decodes.
      var status = inst.win.el.querySelector('.ph-status');
      for (var j = 0; j < 50 && !/1 × 1/.test(status.textContent); j++) await new Promise(function (r2) { setTimeout(r2, 100); });
      var out = { claims: claims && claims.id, first: status.textContent, title: inst.win.title };
      out.next = await inst.ctx.api.step(1);
      out.afterNext = inst.ctrl.getState().path;
      out.zoom = inst.ctx.api.zoomTo(2);
      out.zoomTag = inst.win.el.querySelector('.ph-zoom').textContent;
      out.rotate = inst.ctx.api.rotate(90);
      out.status = status.textContent;
      out.info = inst.ctx.api.info();
      // A second picture opened from the file manager lands in this window.
      await AIOS.apps.openPath('${DIR}/a.png');
      out.windows = AIOS.apps.instances().filter(function (x) { return x.def.id === 'photos'; }).length;
      out.back = inst.ctrl.getState().path;
      AIOS.wm.close(inst.win);
      await window.aios.fs.remove('${DIR}');
      await AIOS.afterFsChange();
      return out;
    `, { timeout: 60000 });
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.claims, 'photos', '.png 該由圖片檢視器認領');
    assert.match(r.first, /1 × 1/, '狀態列要有尺寸：' + r.first);
    assert.match(r.first, /第 1 \/ 2 張/, '要知道同資料夾有兩張：' + r.first);
    assert.equal(r.title, 'a.png', '視窗標題是檔名');
    assert.match(r.next, /已開啟 b\.png（2 × 1）/, '下一張：' + r.next);
    assert.equal(r.afterNext, DIR + '/b.png');
    assert.match(r.zoom, /200%/);
    assert.equal(r.zoomTag, '200%');
    assert.match(r.rotate, /90 度/);
    assert.match(r.status, /90°/, '旋轉要顯示在狀態列：' + r.status);
    assert.match(r.info, /b\.png：2 × 1 像素/, r.info);
    assert.equal(r.windows, 1, '第二張圖不該開第二個視窗');
    assert.equal(r.back, DIR + '/a.png');
  });

  await t.test('介面語言：選單切到英文會保存並立刻套用，切回來也一樣', async () => {
    const r = await run(cdp, `
      var out = {};
      var sys = document.querySelector('.mb-item[data-menu="system"]');
      out.before = sys.textContent;
      document.querySelector('#drop-system [data-act="lang-en"]').click();
      for (var i = 0; i < 50 && sys.textContent !== 'System'; i++) await new Promise(function (r2) { setTimeout(r2, 100); });
      out.menu = sys.textContent;
      out.item = document.querySelector('#drop-system [data-act="version"]').textContent;
      out.dock = document.querySelector('.dk[data-dock="files"]').title;
      out.placeholder = document.getElementById('intent-input').placeholder;
      out.chip = document.querySelector('#chips .chip') && document.querySelector('#chips .chip').textContent;
      out.saved = (await window.aios.prefs.get()).data.locale;
      out.lang = document.documentElement.getAttribute('lang');
      // The check mark follows the saved value when the menu opens.
      document.querySelector('.mb-item[data-menu="system"]').click();
      out.checked = document.querySelector('#drop-system [data-act="lang-en"]').getAttribute('aria-checked');
      document.body.click();
      out.prompt = AIOS.kernel.systemPrompt ? /介面語言是英文/.test(AIOS.kernel.systemPrompt()) : null;
      document.querySelector('#drop-system [data-act="lang-zh-TW"]').click();
      for (var j = 0; j < 50 && sys.textContent !== '系統'; j++) await new Promise(function (r2) { setTimeout(r2, 100); });
      out.restored = sys.textContent;
      out.restoredItem = document.querySelector('#drop-system [data-act="version"]').textContent;
      out.savedBack = (await window.aios.prefs.get()).data.locale;
      return out;
    `, { timeout: 30000 });
    assert.equal(r.before, '系統');
    assert.equal(r.menu, 'System', '選單列沒有變英文');
    assert.equal(r.item, 'Release notes…', '選單項目沒有變英文：' + r.item);
    assert.equal(r.dock, 'File manager (sandbox)', 'Dock 提示沒有變英文：' + r.dock);
    assert.match(r.placeholder, /Say what you want done/, '意圖列沒有變英文');
    assert.match(r.chip || '', /focus timer/, '建議詞沒有變英文：' + r.chip);
    assert.equal(r.saved, 'en', '主程序沒有保存');
    assert.equal(r.lang, 'en');
    assert.equal(r.checked, 'true', '選單沒有打勾');
    if (r.prompt !== null) assert.equal(r.prompt, true, '核心沒有被告知介面語言');
    assert.equal(r.restored, '系統', '切回來沒有還原');
    assert.equal(r.restoredItem, '版本說明…');
    assert.equal(r.savedBack, 'zh-TW');
  });

  await t.test('文字大小：預設 115%，選單可改，改了就保存，壞值會被拒', async () => {
    const r = await run(cdp, `
      var out = {};
      out.initial = (await window.aios.prefs.get()).data;
      var w0 = window.innerWidth;
      document.querySelector('#drop-view [data-act="zoom-1.3"]').click();
      var saved = null;
      for (var i = 0; i < 50; i++) {
        saved = (await window.aios.prefs.get()).data.zoom;
        if (saved === 1.3 && window.innerWidth < w0) break;
        await new Promise(function (r2) { setTimeout(r2, 100); });
      }
      out.saved = saved;
      out.shrank = window.innerWidth < w0;
      out.ratio = w0 / window.innerWidth;
      var bad = await window.aios.prefs.set({ zoom: 7 });
      out.bad = bad.ok ? 'accepted' : bad.error;
      var badLang = await window.aios.prefs.set({ locale: 'fr' });
      out.badLang = badLang.ok ? 'accepted' : badLang.error;
      var back = await window.aios.prefs.set({ zoom: 1.15 });
      out.back = back.data.zoom;
      return out;
    `, { timeout: 30000 });
    assert.equal(r.initial.zoom, 1.15, '出廠預設是 115%');
    assert.deepEqual(r.initial.locales, ['zh-TW', 'en']);
    assert.equal(r.saved, 1.3, '選單沒有保存 130%');
    assert.ok(r.shrank, '頁面縮放沒有套用（CSS 像素寬度沒變小）');
    assert.ok(Math.abs(r.ratio - 1.3 / 1.15) < 0.05, '縮放比例不對：' + r.ratio);
    assert.match(r.bad, /不支援的文字大小/, '壞的縮放值：' + r.bad);
    assert.match(r.badLang, /不支援的語言/, '壞的語言：' + r.badLang);
    assert.equal(r.back, 1.15);
  });
}
