'use strict';

/* ===========================================================================
   AI-OS // mail autoconfig
   ---------------------------------------------------------------------------
   An email address is enough.

   The account form used to ask for four hostnames and two port numbers. That
   is a question most people cannot answer about their own mailbox, and getting
   it wrong fails in the worst available way: an authentication error that
   looks exactly like a wrong password, so the person spends the next ten
   minutes retyping a password that was right all along.

   Five sources, cheapest and most trustworthy first:

     builtin     domains this program already knows, answered offline
     autoconfig  the domain's own config file -- the operator's own answer
     ispdb       Thunderbird's public database, asked with the domain alone
     mx          where the domain's mail actually goes, which is how a company
                 on Google Workspace or Microsoft 365 gets recognised
     srv         RFC 6186 service records

   Three rules the rest of the file is built around:

     1. A discovered setting is a suggestion, never a commitment. Everything
        here goes back to the form and is shown before a password is typed into
        it. That display is the real check: an autoconfig file redirected to an
        attacker's server becomes a visibly wrong hostname rather than a silent
        credential handover.

     2. Cleartext is not a fallback. A source offering only an unencrypted
        socket is discarded, not downgraded to. No discovery is a better
        outcome than a password sent in the clear.

     3. The third party is told the least that still works.
        autoconfig.thunderbird.net is asked about a domain; it is never told
        whose mailbox this is. The domain's own server is asked with the full
        address, because that is the server the mail is going to anyway.

   Nothing here authenticates, connects to a mailbox, or touches the account
   file. It reads DNS and two public config endpoints and returns a suggestion.
   =========================================================================== */

const dns = require('node:dns').promises;
const web = require('./web');

const TIMEOUT_MS = 6000;
/* A ceiling on the whole lookup, not just on each request. Online, every
   source answers in a second or two; the case this exists for is a network
   that accepts a connection and then says nothing, where three requests at six
   seconds each would leave someone watching a spinner for the better part of a
   minute. Past the budget the remaining network sources are skipped and the
   form falls back to the manual fields, which is where it was going anyway. */
const BUDGET_MS = 9000;
const MAX_BYTES = 256 * 1024;
const UA = 'AI-OS/1.0 (mail autoconfig)';

/* Providers people actually use, so the account form is two fields not six.
   These live here rather than in mail.js because discovery is what turns a
   domain into one of them; mail.js re-exports the table it uses. */
const PRESETS = {
  gmail: {
    label: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    note: '需要開啟兩步驗證後產生「應用程式密碼」，一般帳號密碼會被拒絕。'
  },
  outlook: {
    label: 'Outlook / Hotmail',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    note: '個人帳號通常要應用程式密碼；公司帳號多半只接受 OAuth，此時這裡會連不上。'
  },
  yahoo: {
    label: 'Yahoo',
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    note: '需要產生應用程式密碼。'
  },
  icloud: {
    label: 'iCloud',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    note: '需要 App 專用密碼。'
  },
  custom: { label: '自訂 (IMAP/SMTP)', imap: null, smtp: null, note: '自行填入主機與埠號。' }
};

/* Exact matches only. `gmail.com.tw` is not Gmail, and a suffix rule that
   thought otherwise would point a stranger's password at Google. */
const KNOWN_DOMAINS = {
  'gmail.com': 'gmail',
  'googlemail.com': 'gmail',
  'outlook.com': 'outlook',
  'hotmail.com': 'outlook',
  'live.com': 'outlook',
  'msn.com': 'outlook',
  'yahoo.com': 'yahoo',
  'yahoo.com.tw': 'yahoo',
  'ymail.com': 'yahoo',
  'rocketmail.com': 'yahoo',
  'icloud.com': 'icloud',
  'me.com': 'icloud',
  'mac.com': 'icloud'
};

/* Microsoft's consumer service under its country domains -- hotmail.co.uk,
   live.fr, outlook.de -- is the same service on the same servers. Yahoo's
   country domains are deliberately not here: yahoo.co.jp is a different
   operator on different hosts, so those go to the database like anyone else. */
const MS_COUNTRY = /^(hotmail|live|outlook|msn)\.[a-z]{2}(\.[a-z]{2,3})?$/;

/* A domain whose mail is delivered to one of these is that provider's, whatever
   the domain is called. This is the step that recognises a company mailbox on
   Google Workspace or Microsoft 365 -- where the address is @yourcompany.com
   but the IMAP server is still Google's or Microsoft's. */
const MX_PROVIDERS = [
  { re: /(^|\.)(aspmx\.l\.google\.com|googlemail\.com|google\.com)$/i, provider: 'gmail' },
  { re: /(^|\.)(mail\.protection\.outlook\.com|outlook\.com|office365\.com)$/i, provider: 'outlook' }
];

/* ------------------------------------------------------------------ fetch */

/**
 * One config file over HTTPS. Bounded twice -- by a short timeout and by a size
 * cap -- because both endpoints are outside this program's control and a config
 * lookup that hangs is a form that never comes back. It goes through
 * web.request for the same reason web.read does: the response is a stranger's,
 * and Chromium decodes it rather than this process.
 */
async function getXml(url, deadline) {
  const left = deadline ? deadline - Date.now() : TIMEOUT_MS;
  if (left <= 0) throw new Error('逾時');

  const res = await web.request(url, {
    timeoutMs: Math.min(TIMEOUT_MS, left),
    maxBytes: MAX_BYTES,
    what: '設定檔',
    headers: { 'User-Agent': UA, Accept: 'application/xml, text/xml' }
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.body.toString('utf8');
}

/* ------------------------------------------------------------- tiny XML */

/* A whole XML parser for a document with six elements in it would be a
   dependency; these three functions are what that document needs. They are
   deliberately shallow -- the config format is flat, and anything that needs
   real nesting is not a config file this should be trusting. */

function blocks(xml, tag) {
  const out = [];
  const re = new RegExp('<' + tag + '\\b([^>]*)>([\\s\\S]*?)<\\/' + tag + '>', 'gi');
  let m;
  while ((m = re.exec(xml))) out.push({ attrs: m[1] || '', body: m[2] || '' });
  return out;
}

function text(body, tag) {
  const m = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i').exec(body);
  if (!m) return '';
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .trim();
}

/* Both quote styles: the published files use double quotes, but a hand-written
   autoconfig on someone's own domain is exactly where a single quote turns up,
   and refusing to read it would look like "your provider has no settings". */
function attr(attrs, name) {
  const m = new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i').exec(attrs);
  if (!m) return '';
  return m[2] !== undefined ? m[2] : (m[3] || '');
}

/* ------------------------------------------------------- clientConfig XML */

/**
 * One `<incomingServer>` or `<outgoingServer>` reduced to what this client
 * needs, or null if it is not usable.
 *
 * socketType is the whole decision. SSL means connect encrypted; STARTTLS means
 * connect plain and upgrade, which both imapflow and nodemailer express as
 * `secure: false`; `plain` means send the password in the clear, which this
 * refuses rather than offers.
 */
function server(block, wantType, fallbackPort) {
  if (attr(block.attrs, 'type').toLowerCase() !== wantType) return null;

  const host = text(block.body, 'hostname');
  if (!host) return null;

  const socket = (text(block.body, 'socketType') || '').toUpperCase();
  if (socket !== 'SSL' && socket !== 'STARTTLS') return null;

  const port = Number(text(block.body, 'port')) || fallbackPort;

  /* Every <authentication> the file offers. A server that lists only OAuth2 is
     not misconfigured and not unreachable -- it is a server this program cannot
     talk to yet, and saying so is more use than a login that fails later. */
  const auths = blocks(block.body, 'authentication').map((b) => b.body.trim().toLowerCase());
  const oauthOnly = auths.length > 0 && auths.every((a) => a === 'oauth2');

  /* %EMAILADDRESS% is the full address, %EMAILLOCALPART% is the part before the
     @. Hosts that want the local part are a minority but they exist, and
     sending the full address to one of them fails as a wrong password. */
  const username = /%EMAILLOCALPART%/i.test(text(block.body, 'username')) ? 'local' : 'full';

  return { host, port, secure: socket === 'SSL', oauthOnly, username, socket };
}

/**
 * Thunderbird's clientConfig format, which both the ISPDB and a domain's own
 * autoconfig file speak.
 */
function parseClientConfig(xml, domain) {
  const provider = blocks(xml, 'emailProvider')[0];
  if (!provider) return null;

  const pick = (tag, type, port) => blocks(provider.body, tag)
    .map((b) => server(b, type, port))
    .filter(Boolean)
    /* SSL ahead of STARTTLS when a provider offers both: fewer round trips
       before the connection is private. */
    .sort((a, b) => Number(b.secure) - Number(a.secure))[0] || null;

  const imap = pick('incomingServer', 'imap', 993);
  const smtp = pick('outgoingServer', 'smtp', 465);
  if (!imap || !smtp) return null;

  const label = text(provider.body, 'displayShortName') ||
                text(provider.body, 'displayName') || domain;
  const oauthOnly = imap.oauthOnly && smtp.oauthOnly;

  return {
    provider: 'custom',
    label,
    imap: { host: imap.host, port: imap.port, secure: imap.secure },
    smtp: { host: smtp.host, port: smtp.port, secure: smtp.secure },
    username: imap.username,
    oauthOnly,
    note: oauthOnly
      ? '這個服務只接受 OAuth 登入，AI-OS 目前只做密碼／應用程式密碼，因此連不上。'
      : ''
  };
}

/* ------------------------------------------------------------- one preset */

function fromPreset(key, label) {
  const p = PRESETS[key];
  if (!p || !p.imap) return null;
  return {
    provider: key,
    label: label || p.label,
    imap: { ...p.imap },
    smtp: { ...p.smtp },
    username: 'full',
    oauthOnly: false,
    note: p.note
  };
}

/* ------------------------------------------------------------- the sources */

/** Domains this program knows without asking anyone. */
async function builtin(domain) {
  const key = KNOWN_DOMAINS[domain] || (MS_COUNTRY.test(domain) ? 'outlook' : null);
  return key ? fromPreset(key) : null;
}

/**
 * The domain's own answer, from the two places a mail operator publishes it.
 * Asked first over the network because nobody knows a domain's mail servers
 * better than the people running them, and asked with the full address because
 * this is the server that address belongs to.
 */
async function autoconfig(domain, email, deadline) {
  const q = encodeURIComponent(email);
  const urls = [
    'https://autoconfig.' + domain + '/mail/config-v1.1.xml?emailaddress=' + q,
    'https://' + domain + '/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=' + q
  ];
  for (const url of urls) {
    let xml;
    try { xml = await getXml(url, deadline); } catch { continue; }
    const conf = parseClientConfig(xml, domain);
    if (conf) return conf;
  }
  return null;
}

/**
 * Thunderbird's public database. The domain goes over the wire; the address
 * does not, because this endpoint has no need to know which mailbox at that
 * domain is being set up.
 */
async function ispdb(domain, _email, deadline) {
  let xml;
  try {
    xml = await getXml('https://autoconfig.thunderbird.net/v1.1/' + encodeURIComponent(domain), deadline);
  } catch {
    return null;
  }
  return parseClientConfig(xml, domain);
}

/**
 * Where this domain's mail is actually delivered. A company address on Google
 * Workspace or Microsoft 365 looks like an unknown domain to every step above
 * and is the single most common case they miss.
 */
async function mx(domain) {
  let records;
  try { records = await dns.resolveMx(domain); } catch { return null; }
  if (!Array.isArray(records) || !records.length) return null;

  records.sort((a, b) => a.priority - b.priority);
  for (const r of records) {
    const host = String(r.exchange || '').replace(/\.$/, '');
    for (const p of MX_PROVIDERS) {
      if (!p.re.test(host)) continue;
      const conf = fromPreset(p.provider);
      /* The address stays on the company domain -- only the servers are the
         provider's -- so say which provider was recognised and why. */
      return conf && { ...conf, label: conf.label + '（' + domain + ' 的信寄到這裡）' };
    }
  }
  return null;
}

/**
 * RFC 6186 service records. The last automatic source: authoritative when it is
 * there, but few domains publish it.
 */
async function srv(domain) {
  const imap = await srvLookup('_imaps._tcp.' + domain, true) ||
               await srvLookup('_imap._tcp.' + domain, false);
  const smtp = await srvLookup('_submissions._tcp.' + domain, true) ||
               await srvLookup('_submission._tcp.' + domain, false);
  if (!imap || !smtp) return null;

  return {
    provider: 'custom',
    label: domain,
    imap: { host: imap.host, port: imap.port, secure: imap.secure },
    smtp: { host: smtp.host, port: smtp.port, secure: smtp.secure },
    username: 'full',
    oauthOnly: false,
    note: ''
  };
}

async function srvLookup(name, secure) {
  let records;
  try { records = await dns.resolveSrv(name); } catch { return null; }
  if (!Array.isArray(records)) return null;

  /* A single record with target "." is the domain saying this service is not
     offered here, which is not the same as no record at all. */
  const usable = records.filter((r) => r && r.name && r.name !== '.');
  if (!usable.length) return null;

  usable.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
  const top = usable[0];
  return {
    host: String(top.name).replace(/\.$/, ''),
    port: Number(top.port) || (secure ? 993 : 143),
    secure
  };
}

/* ------------------------------------------------------------- the guess */

/**
 * What the fields should say when all five sources came back empty.
 *
 * Not a discovery and never returned as one: `imap.example.com` is a naming
 * convention, not a fact, and a self-hosted domain that publishes nothing is
 * exactly where the convention is most likely to be wrong. It is here so the
 * manual form opens with something to correct rather than six empty boxes --
 * the same reason the discovered settings are shown rather than applied.
 *
 * The alternative was to probe the guesses over TCP, which is what Thunderbird
 * does. It was tried and dropped: a mail server that is only reachable from
 * inside its own network -- which is the common shape of the self-hosted case
 * this would serve -- answers a probe with four seconds of silence, so the
 * cost is paid on exactly the domains that cannot be helped.
 */
function guessFor(domain) {
  return {
    imap: { host: 'imap.' + domain, port: 993, secure: true },
    smtp: { host: 'smtp.' + domain, port: 465, secure: true }
  };
}

/* ---------------------------------------------------------------- discover */

const SOURCES = [
  { id: 'builtin', label: '內建清單', run: builtin },
  { id: 'autoconfig', label: '網域自己的設定檔', run: autoconfig },
  { id: 'ispdb', label: 'Thunderbird 資料庫', run: ispdb },
  { id: 'mx', label: 'MX 紀錄', run: mx },
  { id: 'srv', label: 'SRV 紀錄', run: srv }
];

/**
 * An address in, a suggestion out.
 *
 * Always resolves for a well-formed address. A domain nobody has heard of is
 * not an error -- it is the answer "you will have to fill this in yourself",
 * and the form has a place to do that. `tried` carries what was attempted, so
 * the form can name the step that produced the answer, or say that all five
 * came back empty.
 */
async function discover(rawEmail) {
  const email = String(rawEmail || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Object.assign(new Error('信箱格式不對'), { code: 'EINVAL' });
  }
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  const deadline = Date.now() + BUDGET_MS;
  const tried = [];

  for (const s of SOURCES) {
    let conf = null;
    try {
      conf = await s.run(domain, email, deadline);
    } catch (e) {
      tried.push({ source: s.id, label: s.label, ok: false, error: String(e.message || e) });
      continue;
    }
    if (conf) {
      tried.push({ source: s.id, label: s.label, ok: true });
      return { ...conf, email, domain, found: true, source: s.id, sourceLabel: s.label, tried };
    }
    tried.push({ source: s.id, label: s.label, ok: false });
  }

  return { email, domain, found: false, source: null, sourceLabel: null, tried, guess: guessFor(domain) };
}

module.exports = {
  discover, PRESETS, guessFor,
  /* Exported for the tests, which check the parsing and the tables without a
     network: these are where a wrong answer would be silent. */
  parseClientConfig, srvLookup, KNOWN_DOMAINS, MS_COUNTRY, MX_PROVIDERS
};
