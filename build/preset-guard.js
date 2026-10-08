'use strict';

/* ===========================================================================
   electron-builder beforePack hook: no provider preset in a build by accident
   ---------------------------------------------------------------------------
   app/preset/provider-preset.enc holds API keys, and the `files` list in
   electron-builder.yml packs everything under app/. The preset is encrypted,
   but the program has to be able to open it on a machine it has never seen, so
   whoever has the build can recover the keys (app/main/preset.js explains why
   no cipher changes that).

   A build for the public must not carry one. A build for people you know may,
   but only on purpose -- so packing stops while the file exists, unless
   AIOS_SHIP_PRESET=1 says it is meant to be there. Build-AIOS.ps1 sets that for
   -WithPreset; `npm run dist` comes through here as well.
   =========================================================================== */

const fs = require('node:fs');
const path = require('node:path');

const PRESET = path.join(__dirname, '..', 'app', 'preset', 'provider-preset.enc');

exports.default = async function presetGuard() {
  if (!fs.existsSync(PRESET)) return;

  if (process.env.AIOS_SHIP_PRESET === '1') {
    console.log('  • 這一版帶著內建模型預設檔（AIOS_SHIP_PRESET=1）：拿到它的人都還原得出裡面的金鑰');
    return;
  }

  throw new Error(
    'app/preset/provider-preset.enc 存在，打包會把裡面的 API 金鑰一起帶進去。\n' +
    '要公開發佈：先把它移出 app/preset/。\n' +
    '只給信得過的人、確定要帶：Build-AIOS.bat -WithPreset，或設環境變數 AIOS_SHIP_PRESET=1。'
  );
};
