'use strict';

/* ===========================================================================
   The mail password at rest, and the encryption the connections insist on.
   ---------------------------------------------------------------------------
   mail-account.json used to hold the password as plain JSON. In the portable
   build that file sits beside the exe -- on a USB stick, in a synced folder --
   and whoever copied the folder had the mailbox. It is now sealed by the OS
   keychain the way the model keys are, and a port-587 server has to upgrade
   to TLS before it is given the login.

   Its own file because it replaces three modules before mail.js is loaded:
   `electron` (for a keychain that exists outside Electron), `mailstore` (so
   nothing touches the real sandbox) and `imapflow` (to see the options a
   connection is opened with). node --test runs each file in its own process,
   so none of that reaches another suite.
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function stub(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

/* A keychain whose output can be told apart from the password, and which only
   opens what it sealed itself -- the way a blob from another machine fails. */
const SEAL = 'sealed:';
const keychain = {
  available: true,
  isEncryptionAvailable() { return this.available; },
  encryptString(s) { return Buffer.from(SEAL + Buffer.from(s, 'utf8').toString('hex'), 'utf8'); },
  decryptString(buf) {
    const s = buf.toString('utf8');
    if (!s.startsWith(SEAL)) throw new Error('sealed somewhere else');
    return Buffer.from(s.slice(SEAL.length), 'hex').toString('utf8');
  }
};
stub('electron', { safeStorage: keychain });
stub('../app/main/mailstore', {
  init: async () => ({}), ready: () => false, stats: () => null, purge: async () => {}
});

/* The options each IMAP connection was opened with. connect() fails at once,
   which is all a connection test needs to have been attempted. */
const imapOpened = [];
require('imapflow').ImapFlow = class {
  constructor(opts) { imapOpened.push(opts); }
  async connect() { throw new Error('not in a test'); }
  async logout() {}
  close() {}
};

const nodemailer = require('nodemailer');
const mail = require('../app/main/mail');

function freshDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-mailcred-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const credFile = (dir) => path.join(dir, 'mail-account.json');

test('the password is written sealed, never in the clear, and read back after a restart', async (t) => {
  const dir = freshDir(t);
  keychain.available = true;
  await mail.init(dir);
  await mail.configure({ provider: 'gmail', email: 'someone@gmail.com', password: 'hunter2-not-on-disk' });

  const raw = fs.readFileSync(credFile(dir), 'utf8');
  assert.ok(!raw.includes('hunter2-not-on-disk'), 'the password must not appear in the file in any form');
  const saved = JSON.parse(raw);
  assert.equal(saved.password, undefined);
  assert.ok(saved.passwordSealed, 'it is there, sealed');

  const st = await mail.init(dir);
  assert.equal(st.configured, true, 'a restart opens it again');
});

test('a password an older version left in the clear is sealed at the next start', async (t) => {
  const dir = freshDir(t);
  keychain.available = true;
  fs.writeFileSync(credFile(dir), JSON.stringify({
    kind: 'imap', provider: 'gmail', email: 'old@gmail.com',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    password: 'left-in-the-clear'
  }));

  const st = await mail.init(dir);
  assert.equal(st.configured, true, 'the account keeps working');
  const raw = fs.readFileSync(credFile(dir), 'utf8');
  assert.ok(!raw.includes('left-in-the-clear'), 'and the plaintext does not outlive the launch');
  assert.ok(JSON.parse(raw).passwordSealed);
});

test('with no keychain the password is kept for this run only, not written in the clear', async (t) => {
  const dir = freshDir(t);
  keychain.available = false;
  try {
    await mail.init(dir);
    const st = await mail.configure({ provider: 'gmail', email: 'nokeychain@gmail.com', password: 'only-in-memory' });
    assert.equal(st.configured, true, 'usable now');

    const saved = JSON.parse(fs.readFileSync(credFile(dir), 'utf8'));
    assert.equal(saved.password, undefined);
    assert.equal(saved.passwordSealed, undefined);
    assert.ok(saved.passwordRefused, 'and the file says why it is missing');

    assert.equal((await mail.init(dir)).configured, false, 'gone after a restart, which is the honest outcome');
  } finally {
    keychain.available = true;
  }
});

test('a password sealed somewhere else is asked for again rather than guessed', async (t) => {
  const dir = freshDir(t);
  keychain.available = true;
  fs.writeFileSync(credFile(dir), JSON.stringify({
    kind: 'imap', provider: 'gmail', email: 'moved@gmail.com',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    passwordSealed: Buffer.from('another machine').toString('base64')
  }));
  const st = await mail.init(dir);
  assert.equal(st.configured, false);
  assert.equal(st.email, 'moved@gmail.com', 'the account itself is still known');
});

test('a server reached without TLS has to upgrade before it is given the login', async (t) => {
  const dir = freshDir(t);
  keychain.available = true;
  const smtpOpened = [];
  const real = nodemailer.createTransport;
  nodemailer.createTransport = (opts) => {
    smtpOpened.push(opts);
    return { verify: async () => { throw new Error('not in a test'); }, close() {} };
  };
  t.after(() => { nodemailer.createTransport = real; });

  await mail.init(dir);
  /* Outlook: IMAP on 993 is TLS from the first byte, SMTP on 587 is STARTTLS. */
  await mail.configure({ provider: 'outlook', email: 'someone@outlook.com', password: 'x' });
  imapOpened.length = 0;
  await mail.verify();
  assert.equal(imapOpened[0].secure, true);
  assert.equal(imapOpened[0].doSTARTTLS, undefined, 'implicit TLS needs no upgrade, and imapflow refuses both at once');
  assert.equal(smtpOpened[0].secure, false);
  assert.equal(smtpOpened[0].requireTLS, true, 'SMTP on 587 refuses to log in over a connection that did not upgrade');

  /* A custom host on a STARTTLS port, both ways. */
  await mail.configure({
    provider: 'custom', email: 'me@example.org', password: 'x',
    imap: { host: 'imap.example.org', port: 143, secure: false },
    smtp: { host: 'smtp.example.org', port: 465, secure: true }
  });
  imapOpened.length = 0;
  smtpOpened.length = 0;
  await mail.verify();
  assert.equal(imapOpened[0].doSTARTTLS, true, 'IMAP on 143 has to upgrade too');
  assert.equal(smtpOpened[0].requireTLS, false, 'implicit TLS on 465 is already encrypted');
});
