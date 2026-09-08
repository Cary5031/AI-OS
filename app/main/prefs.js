'use strict';

/* ===========================================================================
   AI-OS // interface preferences
   ---------------------------------------------------------------------------
   The two settings that have to be known before the first paint and have to
   outlive a cleared session: the interface language and the text size.

   Not in session.json, on purpose. The session is the desktop -- windows,
   context pages, the journal -- and 「清空工作階段」 throws it away; a person
   who chose English and a larger type did not choose them for one session.
   Not in policy.json either: that file is the capability gate's and is
   audited as such. One small file of its own, read at boot and written on
   every change.
   =========================================================================== */

const fs = require('node:fs/promises');
const path = require('node:path');

const LOCALES = ['zh-TW', 'en'];
/* The steps a person can pick. 1 is what the machine shipped with for its
   first ten versions; 1.15 is the default now, because the person using it
   said the type was too small to read, and one step is what "one step" means. */
const ZOOMS = [1, 1.15, 1.3, 1.5];
const DEFAULTS = { locale: 'zh-TW', zoom: 1.15 };

let file = null;
let prefs = { ...DEFAULTS };

async function init(userDataDir) {
  file = path.join(userDataDir, 'ui-prefs.json');
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    prefs = { ...DEFAULTS, ...sanitise(raw) };
  } catch {
    prefs = { ...DEFAULTS };
  }
  return get();
}

function sanitise(patch) {
  const out = {};
  if (patch && LOCALES.includes(patch.locale)) out.locale = patch.locale;
  if (patch && ZOOMS.includes(Number(patch.zoom))) out.zoom = Number(patch.zoom);
  return out;
}

function get() {
  return { ...prefs, locales: LOCALES, zooms: ZOOMS };
}

async function set(patch) {
  const clean = sanitise(patch);
  if (patch && patch.locale !== undefined && clean.locale === undefined) {
    throw Object.assign(new Error('不支援的語言：' + patch.locale + '（可用：' + LOCALES.join('、') + '）'), { code: 'EINVAL' });
  }
  if (patch && patch.zoom !== undefined && clean.zoom === undefined) {
    throw Object.assign(new Error('不支援的文字大小：' + patch.zoom + '（可用：' + ZOOMS.join('、') + '）'), { code: 'EINVAL' });
  }
  prefs = { ...prefs, ...clean };
  if (file) {
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(prefs, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }
  return get();
}

module.exports = { init, get, set, LOCALES, ZOOMS, DEFAULTS };
