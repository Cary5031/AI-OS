/* ===========================================================================
   End-to-end suite: start the machine, drive it, assert what it did.
   ---------------------------------------------------------------------------
   `npm test` reads source and asserts what it looks like. That catches a
   surprising amount, and it is why most of its assertions are string matches
   -- but it cannot catch a panel that answers correctly and does only the
   first third of what was asked, which is exactly the bug that survived until
   somebody drove it by hand.

   This runs the real application. One launch for the whole suite, because a
   cold boot is about fifteen seconds and paying that per file would make the
   suite something nobody runs.

     node e2e/run.mjs              against the source tree
     node e2e/run.mjs --packaged   against the newest dist/*-portable.exe,
                                   in a throwaway directory: the only way to
                                   exercise a genuine first run
   =========================================================================== */

import test from 'node:test';
import path from 'node:path';
import { launchClean, launchPortable, newestPortable, newerThanBuild, ROOT } from './lib/app.mjs';

import * as boot from './specs/boot.mjs';
import * as themes from './specs/themes.mjs';
import * as windows from './specs/windows.mjs';
import * as forge from './specs/forge.mjs';
import * as chatpane from './specs/chatpane.mjs';
import * as mail from './specs/mail.mjs';
import * as bookmarks from './specs/bookmarks.mjs';
import * as extensions from './specs/extensions.mjs';
import * as office from './specs/office.mjs';
import * as schedule from './specs/schedule.mjs';
import * as photos from './specs/photos.mjs';
import * as translate from './specs/translate.mjs';
import * as webexport from './specs/webexport.mjs';
import * as pdfpages from './specs/pdfpages.mjs';

const SPECS = [boot, themes, windows, forge, chatpane, mail, bookmarks, extensions, office, schedule, photos, translate, webexport, pdfpages];

/* An environment variable rather than a flag: `node --test file -- --packaged`
   does not reliably reach this process's argv through npm, and a switch that
   silently does nothing is worse than no switch -- the packaged run would look
   like it passed while testing the source tree. */
const packaged = process.env.AIOS_E2E_PACKAGED === '1' || process.argv.includes('--packaged');

/* The machine's confirmation dialogs are drawn inside its window by the main
   process (main/askbox.js) and are CDP targets like everything else, so the
   specs press them (lib/dialog.mjs). Nothing here scripts an answer: the one
   dialog that exists to stop a person is pressed by the test, not skipped. */

test('AI-OS 端對端', { timeout: 15 * 60 * 1000 }, async (t) => {
  let app;
  let label;

  if (packaged) {
    const exe = await newestPortable();
    if (!exe) {
      t.diagnostic('dist/ 裡沒有免安裝版，先跑 Build-AIOS.bat');
      return;
    }
    /* Refuse rather than run: a build from before a feature existed fails that
       feature's spec, and the message reads as "the feature is broken" instead
       of "this exe predates it". That wasted a debugging round the first time. */
    const stale = await newerThanBuild(exe);
    if (stale.length) {
      throw new Error(
        `${path.basename(exe)} 比原始碼舊，測它會得到誤導的失敗。\n` +
        `  先重新建置（Build-AIOS.bat）。建置後改過的檔案共 ${stale.length} 個，例如：\n` +
        stale.slice(0, 5).map((f) => '    ' + f).join('\n'));
    }
    label = '打包版首次啟動：' + path.basename(exe);
    app = await launchPortable(exe);
  } else {
    label = '原始碼（乾淨設定檔）：' + ROOT;
    app = await launchClean();
  }

  t.diagnostic(label);

  try {
    /* A packaged run lands in a directory of its own, so it is the only one that
       sees the machine as a new user does -- shipped defaults, nothing saved. */
    const ctx = { fresh: packaged };
    for (const s of SPECS) {
      await t.test(s.name, async (sub) => { await s.spec(sub, app, ctx); });
    }
  } finally {
    await app.close();
  }
});
