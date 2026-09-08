'use strict';

/* ===========================================================================
   AI-OS // shipped provider preset
   ---------------------------------------------------------------------------
   A model configuration that travels with the build, so somebody who installs
   this can use the machine without first going and getting an API key.

   ---------------------------------------------------------------------------
   WHAT THIS ENCRYPTION DOES AND DOES NOT DO. Read this before shipping a key.

   The preset has to decrypt on a machine this build has never seen, so it
   cannot use the OS keychain the way `llama.js` does for the user's own
   credentials -- a keychain blob is bound to one user on one machine, which is
   exactly the property that makes it safe and exactly the property that makes it
   useless here. The key therefore ships inside the application.

   That is not a weakness of AES-256-GCM, and no cipher fixes it: whoever holds
   the program holds everything the program needs to decrypt, because it has to
   decrypt without asking anyone. So:

     - This stops the key being readable by opening the file, by `strings` on the
       binary, or by anyone who copies the preset out of the install directory.
     - It does NOT stop somebody who is willing to read the source or step
       through the program. Treat a shipped key as recoverable by any determined
       recipient.

   Ship a key you are willing to have recovered: one with a spending cap, scoped
   to what this application does, and rotatable. If the audience is the public
   rather than people you know, put a server you control between them and the
   provider instead, and ship its address rather than a key.

   `AIOS_PRESET_SECRET` in the environment overrides the passphrase below, so a
   build can use one that was never committed. Losing it only means old presets
   stop opening -- make a new one.
   =========================================================================== */

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

/* Bundled with the app, so `files: app/**` in electron-builder.yml carries it
   into the asar without a second rule to remember. */
const PRESET_FILE = path.join(__dirname, '..', 'preset', 'provider-preset.enc');

/* The default passphrase. Deriving a key from it rather than embedding one is
   worth the few lines -- it keeps a usable key out of the binary's string table
   -- but see the header: this raises the bar, it is not a wall. */
const DEFAULT_SECRET = 'AI-OS/provider-preset/v1';

function secret() {
  return process.env.AIOS_PRESET_SECRET || DEFAULT_SECRET;
}

/* scrypt over a per-file random salt. The salt is stored in the file, which is
   normal: it exists so two presets encrypted with one passphrase do not share a
   key, not to be secret. */
function keyFrom(salt) {
  return crypto.scryptSync(secret(), salt, 32, { N: 16384, r: 8, p: 1 });
}

/** Encrypt a JSON-serialisable value into the on-disk envelope. */
function seal(value) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(salt), iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final()
  ]);
  return {
    v: 1,
    alg: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: body.toString('base64')
  };
}

/** The inverse. Throws if the file was tampered with or the passphrase differs. */
function open(envelope) {
  if (!envelope || envelope.v !== 1 || envelope.alg !== 'aes-256-gcm') {
    throw new Error('預設檔格式不認得');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    keyFrom(Buffer.from(envelope.salt, 'base64')),
    Buffer.from(envelope.iv, 'base64')
  );
  // GCM verifies on final(): a wrong passphrase and a modified file both fail
  // here rather than yielding plausible-looking rubbish.
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const out = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final()
  ]);
  return JSON.parse(out.toString('utf8'));
}

/**
 * Read the bundled preset, if this build has one.
 *
 * Returns null rather than throwing when there is no preset: a build without one
 * is the ordinary case, not an error. A preset that exists and will not open is
 * different -- that is a broken build or a changed passphrase, and the caller
 * says so rather than starting up as though nothing were configured.
 */
async function load() {
  let raw;
  try {
    raw = await fs.readFile(PRESET_FILE, 'utf8');
  } catch (e) {
    return null;
  }
  const value = open(JSON.parse(raw));
  if (!value || typeof value !== 'object') throw new Error('預設檔內容不是設定');
  return value;
}

/**
 * Write a preset next to the source, for the next build to pick up.
 *
 * Only from a source checkout: inside a packaged application the path above is
 * in a read-only asar, and a user of a build has no reason to be authoring one.
 */
async function write(value, { packaged } = {}) {
  if (packaged) {
    throw new Error('打包後的程式不能產生預設檔 — 請在原始碼環境執行後重新建置');
  }
  await fs.mkdir(path.dirname(PRESET_FILE), { recursive: true });
  await fs.writeFile(PRESET_FILE, JSON.stringify(seal(value), null, 2), 'utf8');
  return PRESET_FILE;
}

async function exists() {
  try {
    await fs.access(PRESET_FILE);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { load, write, exists, seal, open, PRESET_FILE };
