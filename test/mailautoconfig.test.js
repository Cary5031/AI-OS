'use strict';

/* ===========================================================================
   Working out a mailbox's servers from its address
   ---------------------------------------------------------------------------
   No network here. What is worth checking about discovery is the part that
   would be wrong silently: which domains map to which provider, what the
   clientConfig parser does with a file that offers several servers, and -- the
   one that matters most -- that a provider offering only an unencrypted socket
   produces no answer rather than a cheerful one.

   The network paths themselves are two fetches and two DNS calls; a test with
   a mock for those would be checking the mock. What it would not catch is the
   table below drifting, which is why the table is what is tested.
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');

const ac = require('../app/main/mailautoconfig');

/** A clientConfig document, assembled from the parts a case cares about. */
function xml(servers, opts = {}) {
  return '<?xml version="1.0"?><clientConfig version="1.1"><emailProvider id="ex.com">' +
    '<domain>ex.com</domain>' +
    (opts.name ? '<displayShortName>' + opts.name + '</displayShortName>' : '') +
    servers +
    '</emailProvider></clientConfig>';
}

function incoming(type, host, port, socket, extra = '') {
  return '<incomingServer type="' + type + '"><hostname>' + host + '</hostname>' +
    '<port>' + port + '</port><socketType>' + socket + '</socketType>' + extra +
    '</incomingServer>';
}

function outgoing(host, port, socket, extra = '') {
  return '<outgoingServer type="smtp"><hostname>' + host + '</hostname>' +
    '<port>' + port + '</port><socketType>' + socket + '</socketType>' + extra +
    '</outgoingServer>';
}

const SMTP_SSL = outgoing('smtp.ex.com', 465, 'SSL');

/* ------------------------------------------------------------ the tables */

test('the known domains all name a preset that exists and has servers', () => {
  for (const [domain, key] of Object.entries(ac.KNOWN_DOMAINS)) {
    const preset = ac.PRESETS[key];
    assert.ok(preset, domain + ' 指向不存在的預設檔 ' + key);
    assert.ok(preset.imap && preset.imap.host, key + ' 沒有 IMAP 主機');
    assert.ok(preset.smtp && preset.smtp.host, key + ' 沒有 SMTP 主機');
  }
});

test('a domain is only Gmail if it is exactly Gmail', () => {
  /* A suffix rule here would send a stranger's password to Google: anyone can
     register gmail.com.tw, and `endsWith('gmail.com')` would call it Gmail. */
  assert.equal(ac.KNOWN_DOMAINS['gmail.com'], 'gmail');
  for (const impostor of ['gmail.com.tw', 'notgmail.com', 'gmail.co', 'mygmail.com']) {
    assert.equal(ac.KNOWN_DOMAINS[impostor], undefined, impostor + ' 被當成 Gmail 了');
  }
});

test("Microsoft's country domains are recognised, Yahoo's are not guessed at", () => {
  for (const d of ['hotmail.co.uk', 'live.fr', 'outlook.de', 'msn.co.jp']) {
    assert.ok(ac.MS_COUNTRY.test(d), d + ' 應該被認出是 Microsoft');
  }
  /* yahoo.co.jp is a different operator on different hosts, so it goes to the
     database like any other domain rather than being assumed. */
  for (const d of ['yahoo.co.jp', 'yahoo.fr', 'example.co.uk', 'hotmail.example.com']) {
    assert.ok(!ac.MS_COUNTRY.test(d), d + ' 不該被當成 Microsoft');
  }
});

test('the MX table recognises Workspace and Microsoft 365, and nothing else', () => {
  const hit = (host) => ac.MX_PROVIDERS.filter((p) => p.re.test(host)).map((p) => p.provider);
  assert.deepEqual(hit('aspmx.l.google.com'), ['gmail']);
  assert.deepEqual(hit('alt1.aspmx.l.google.com'), ['gmail']);
  assert.deepEqual(hit('acme-com.mail.protection.outlook.com'), ['outlook']);
  /* A domain running its own server, or behind an anti-spam gateway, is not a
     provider this can answer for -- and saying nothing is the right answer. */
  assert.deepEqual(hit('spam.tachen.com.tw'), []);
  assert.deepEqual(hit('mx.notgoogle.com.evil.net'), []);
});

/* ------------------------------------------------------- clientConfig XML */

test('the encrypted server wins when a provider offers both', () => {
  const conf = ac.parseClientConfig(xml(
    incoming('imap', 'imap.ex.com', 143, 'STARTTLS') +
    incoming('imap', 'imap.ex.com', 993, 'SSL') +
    SMTP_SSL, { name: 'Ex' }), 'ex.com');

  assert.equal(conf.imap.port, 993);
  assert.equal(conf.imap.secure, true);
  assert.equal(conf.label, 'Ex');
});

test('STARTTLS is kept as an unencrypted-until-upgraded connection', () => {
  /* `secure: false` is what imapflow and nodemailer both call "connect plain,
     then upgrade". Writing `true` here would try to speak TLS to a port that
     is not listening for it, and the failure reads as a broken server. */
  const conf = ac.parseClientConfig(xml(
    incoming('imap', 'imap.ex.com', 143, 'STARTTLS') +
    outgoing('smtp.ex.com', 587, 'STARTTLS')), 'ex.com');

  assert.equal(conf.imap.secure, false);
  assert.equal(conf.smtp.secure, false);
  assert.equal(conf.smtp.port, 587);
});

test('a provider offering only cleartext produces no settings at all', () => {
  /* The one result this must never return. Falling back to an unencrypted
     socket would put the password on the wire in exchange for saving the
     person a form. */
  assert.equal(ac.parseClientConfig(xml(
    incoming('imap', 'imap.ex.com', 143, 'plain') +
    outgoing('smtp.ex.com', 25, 'plain')), 'ex.com'), null);

  /* And a half-cleartext provider is no better than a whole one. */
  assert.equal(ac.parseClientConfig(xml(
    incoming('imap', 'imap.ex.com', 993, 'SSL') +
    outgoing('smtp.ex.com', 25, 'plain')), 'ex.com'), null);
});

test('POP3 is not mistaken for IMAP', () => {
  /* Same element name, different `type`. Reading the pop3 entry would give a
     hostname that answers on the wrong protocol. */
  assert.equal(ac.parseClientConfig(xml(
    incoming('pop3', 'pop.ex.com', 995, 'SSL') + SMTP_SSL), 'ex.com'), null);

  const conf = ac.parseClientConfig(xml(
    incoming('pop3', 'pop.ex.com', 995, 'SSL') +
    incoming('imap', 'imap.ex.com', 993, 'SSL') + SMTP_SSL), 'ex.com');
  assert.equal(conf.imap.host, 'imap.ex.com');
});

test('a server that wants only the local part of the address says so', () => {
  const local = ac.parseClientConfig(xml(
    incoming('imap', 'imap.ex.com', 993, 'SSL', '<username>%EMAILLOCALPART%</username>') +
    SMTP_SSL), 'ex.com');
  assert.equal(local.username, 'local');

  const full = ac.parseClientConfig(xml(
    incoming('imap', 'imap.ex.com', 993, 'SSL', '<username>%EMAILADDRESS%</username>') +
    SMTP_SSL), 'ex.com');
  assert.equal(full.username, 'full');

  /* Saying nothing means the address, which is what almost every host wants. */
  const quiet = ac.parseClientConfig(xml(
    incoming('imap', 'imap.ex.com', 993, 'SSL') + SMTP_SSL), 'ex.com');
  assert.equal(quiet.username, 'full');
});

test('an OAuth-only provider is reported as such rather than as a password login', () => {
  /* This is the company Microsoft 365 case, which used to fail as a rejected
     password after the account was saved. It is still not connectable -- but
     being told why beats being told the password is wrong. */
  const conf = ac.parseClientConfig(xml(
    incoming('imap', 'imap.ex.com', 993, 'SSL', '<authentication>OAuth2</authentication>') +
    outgoing('smtp.ex.com', 465, 'SSL', '<authentication>OAuth2</authentication>')), 'ex.com');

  assert.equal(conf.oauthOnly, true);
  assert.match(conf.note, /OAuth/);

  /* A provider that takes a password as well as OAuth is an ordinary one. */
  const both = ac.parseClientConfig(xml(
    incoming('imap', 'imap.ex.com', 993, 'SSL',
      '<authentication>password-cleartext</authentication><authentication>OAuth2</authentication>') +
    outgoing('smtp.ex.com', 465, 'SSL', '<authentication>OAuth2</authentication>')), 'ex.com');
  assert.equal(both.oauthOnly, false);
});

test('single-quoted attributes are read too', () => {
  /* The published files use double quotes; a hand-written autoconfig on
     someone's own domain is where the other kind turns up, and refusing it
     would look like "your provider published nothing". */
  const conf = ac.parseClientConfig(
    "<clientConfig><emailProvider id='ex.com'>" +
    "<incomingServer type='imap'><hostname>imap.ex.com</hostname><port>993</port>" +
    "<socketType>SSL</socketType></incomingServer>" +
    "<outgoingServer type='smtp'><hostname>smtp.ex.com</hostname><port>465</port>" +
    "<socketType>SSL</socketType></outgoingServer></emailProvider></clientConfig>", 'ex.com');
  assert.equal(conf.imap.host, 'imap.ex.com');
});

test('a document that is not a clientConfig is not read as one', () => {
  for (const junk of ['', '<html><body>404</body></html>', '<clientConfig></clientConfig>', 'not xml at all']) {
    assert.equal(ac.parseClientConfig(junk, 'ex.com'), null, JSON.stringify(junk) + ' 被當成設定檔了');
  }
});

/* -------------------------------------------------------------- discovery */

test('a known domain is answered without asking the network', async () => {
  /* If this ever reaches the network it will be slow rather than wrong, which
     is the kind of regression nobody notices. A built-in answer is immediate. */
  const t0 = Date.now();
  const r = await ac.discover('someone@gmail.com');
  assert.equal(r.found, true);
  assert.equal(r.source, 'builtin');
  assert.equal(r.provider, 'gmail');
  assert.equal(r.imap.host, 'imap.gmail.com');
  assert.ok(Date.now() - t0 < 250, '內建清單的答案不該花時間');
});

test('a malformed address is refused before anything is looked up', async () => {
  for (const bad of ['', 'not-an-address', 'a@b', '@example.com', 'a b@example.com']) {
    await assert.rejects(() => ac.discover(bad), /信箱格式不對/, JSON.stringify(bad) + ' 應該被擋下');
  }
});

test('the guess is offered as a guess, and only when nothing was found', async () => {
  /* An address whose domain cannot resolve: every source comes back empty, and
     what the form gets is the naming convention plus a record of the five
     things that were tried -- not a discovery. */
  const r = await ac.discover('someone@invalid-domain-that-does-not-exist.invalid');
  assert.equal(r.found, false);
  assert.equal(r.source, null);
  assert.equal(r.imap, undefined, '找不到的時候不該有 imap，那會被當成查到的');
  assert.equal(r.guess.imap.host, 'imap.invalid-domain-that-does-not-exist.invalid');
  assert.equal(r.guess.imap.port, 993);
  assert.equal(r.guess.smtp.port, 465);
  assert.equal(r.tried.length, 5, '五個來源都要試過才算沒有');

  /* And a found answer carries no guess to be confused with it. */
  const known = await ac.discover('someone@gmail.com');
  assert.equal(known.guess, undefined);
});

test('the guess is never encrypted-optional', () => {
  /* The prefilled ports are the implicit-TLS ones. Someone who accepts the
     form as it opens gets an encrypted connection or an error, never a
     password sent in the clear. */
  const g = ac.guessFor('example.com');
  assert.equal(g.imap.secure, true);
  assert.equal(g.smtp.secure, true);
});
