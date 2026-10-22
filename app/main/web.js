'use strict';

/* ===========================================================================
   AI-OS // web reading
   ---------------------------------------------------------------------------
   Reader mode: fetch a page and hand back its prose. This is the form of web
   access the model can actually use -- a screenshot of a site is worthless in
   a prompt, and raw HTML is mostly navigation, tracking and CSS.

   Extraction is done here rather than with a headless DOM on purpose. jsdom
   plus Readability is better at pathological pages, but it is a 50 MB
   dependency and a second JavaScript engine to feed on a machine whose VRAM is
   already committed to a 24 GB model. This is heuristic and says so.

   Everything fetched here is untrusted by construction, and the caller is
   expected to fence it before it reaches the model.
   =========================================================================== */

const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 AI-OS/0.9';

/* Blocks that are never the article. */
const STRIP_BLOCKS = /<(script|style|noscript|template|svg|canvas|iframe|form|nav|aside|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi;
const STRIP_SELF = /<(input|button|img|source|link|meta|br|hr)\b[^>]*\/?>/gi;

/**
 * Reject anything that is not an ordinary remote web address before a socket is
 * opened. Without this, "read this page for me" becomes a way to probe the
 * loopback interface and the private network from inside the application.
 */
function validateUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw Object.assign(new Error('網址格式不對'), { code: 'EINVAL' });
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw Object.assign(new Error('只接受 http 或 https'), { code: 'EPROTO' });
  }
  const host = u.hostname.toLowerCase();
  const blocked =
    host === 'localhost' || host === '::1' || host.endsWith('.localhost') ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) || /^0\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith('.internal') || host.endsWith('.local');
  if (blocked) {
    throw Object.assign(new Error('拒絕連線到本機或內網位址：' + host), { code: 'EPRIVATE' });
  }
  return u;
}

/* ------------------------------------------------------------------ transport

   Every response this module fetches comes from a stranger, and it is decoded
   -- gzip, Brotli, zstd -- before anything here gets to look at it. Node's own
   fetch does that decoding inside this process, which holds the sandbox, the
   gate and the mail password, so a flaw in a decoder has all of that within
   reach. October 2026 brought one: CVE-2026-111497, an out-of-bounds write in
   the Brotli decoder Node bundles, triggered by a response body. The same
   release fixed six undici bugs, one of which crashed the process on a header
   that listed too many encodings.

   So requests go through Chromium's network service instead, the stack the
   built-in browser already uses. It runs in a process of its own, its Brotli
   already had that fix, and a malformed stream comes back as
   ERR_CONTENT_DECODING_FAILED instead of a crash. The partition has no
   "persist:" prefix, so it lives in memory and is gone at quit; credentials are
   omitted, so a page read here never sees the browser's logins and leaves no
   cookie behind.

   Redirects are followed by hand so that each hop passes the caller's screen.
   Checking only the first address let a public page bounce the request to the
   loopback interface or the router. */
const PARTITION = 'aios-fetch';

function netError(message) {
  return Object.assign(new Error(message), { code: 'ENET' });
}

/**
 * One HTTP request through Chromium's network service. Resolves with the
 * decoded body and the address it finally came from. Rejects with ENET for the
 * network or the clock, EFBIG past `maxBytes`, or whatever `screen` throws for
 * a redirect hop.
 */
function request(url, opts = {}) {
  const { net } = require('electron');
  const max = opts.maxBytes || MAX_BYTES;
  return new Promise((resolve, reject) => {
    let finalUrl = String(url);
    let done = false;
    const req = net.request({
      url: finalUrl,
      method: opts.method || 'GET',
      partition: PARTITION,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'manual'
    });
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!err) return resolve(value);
      req.abort();
      reject(err);
    };
    // The whole exchange, body included: a server that sends headers and then
    // trickles the body must not hold the caller forever.
    const timer = setTimeout(() => finish(netError('連線逾時')), opts.timeoutMs || TIMEOUT_MS);

    req.on('redirect', (_status, _method, location) => {
      try {
        if (opts.screen) opts.screen(location);
      } catch (e) {
        return finish(e);
      }
      finalUrl = location;
      req.followRedirect();
    });
    req.on('response', (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > max) {
          return finish(Object.assign(
            new Error((opts.what || '回應') + '太大（超過 ' + Math.round(max / 1024) + ' KiB）'),
            { code: 'EFBIG' }));
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish(null, {
        url: finalUrl,
        status: res.statusCode,
        statusText: res.statusMessage,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        header: (name) => [].concat(res.headers[name.toLowerCase()] || []).join(', '),
        body: Buffer.concat(chunks)
      }));
      res.on('aborted', () => finish(netError('連線中斷')));
      res.on('error', (e) => finish(netError('連線失敗：' + e.message)));
    });
    req.on('error', (e) => finish(netError('連線失敗：' + e.message)));

    try {
      for (const [k, v] of Object.entries(opts.headers || {})) req.setHeader(k, v);
      if (opts.body != null) req.write(opts.body);
      req.end();
    } catch (e) {
      finish(Object.assign(new Error('請求無法送出：' + e.message), { code: 'EINVAL' }));
    }
  });
}

function decodeEntities(s) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '\u2014',
    ndash: '\u2013', hellip: '\u2026', rsquo: '\u2019', lsquo: '\u2018',
    ldquo: '\u201c', rdquo: '\u201d', middot: '\u00b7', bull: '\u2022'
  };
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (named[n.toLowerCase()] !== undefined ? named[n.toLowerCase()] : m));
}

function pickTitle(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i);
  if (og) return decodeEntities(og[1]).trim();
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t ? decodeEntities(t[1]).replace(/\s+/g, ' ').trim() : '';
}

/**
 * Prefer an explicit article container. Sites that mark one up are telling us
 * where the content is, and guessing when we have been told is silly.
 */
function narrow(html) {
  const patterns = [
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<div\b[^>]*(?:id|class)=["'][^"']*(?:article|post-content|entry-content|markdown-body|content-body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1] && m[1].length > 400) return m[1];
  }
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return body ? body[1] : html;
}

/** Block-level tags become paragraph breaks; everything else is dropped. */
function toText(fragment) {
  return fragment
    .replace(STRIP_BLOCKS, ' ')
    .replace(STRIP_SELF, ' ')
    .replace(/<\/(p|div|section|li|h[1-6]|tr|blockquote|pre)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<h([1-6])\b[^>]*>/gi, (_, n) => '\n\n' + '#'.repeat(Number(n)) + ' ')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((line) => decodeEntities(line).replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function collectLinks(html, base) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 40) {
    let href;
    try { href = new URL(m[1], base).toString(); } catch { continue; }
    if (!/^https?:/i.test(href) || seen.has(href)) continue;
    const label = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!label) continue;
    seen.add(href);
    out.push({ href, label: label.slice(0, 90) });
  }
  return out;
}

/**
 * Fetch and extract. Returns prose plus enough metadata for the UI to show
 * where it came from and how much was thrown away.
 */
async function read(rawUrl, opts = {}) {
  const url = validateUrl(rawUrl);
  const res = await request(url.href, {
    screen: validateUrl,
    timeoutMs: opts.timeoutMs,
    what: '頁面',
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
    }
  });

  const finalUrl = res.url;
  const type = res.header('content-type').toLowerCase();

  if (!res.ok) {
    throw Object.assign(new Error(`HTTP ${res.status} ${res.statusText}`), { code: 'EHTTP', status: res.status });
  }

  const buf = res.body;

  // Plain text and JSON need no extraction at all.
  if (/^(text\/plain|application\/json|text\/markdown)/.test(type)) {
    const text = buf.toString('utf8');
    return {
      url: finalUrl, title: finalUrl, type, bytes: buf.length,
      text: text.slice(0, 200000), links: [], extracted: false
    };
  }
  if (!/html|xml/.test(type)) {
    throw Object.assign(new Error('不是可閱讀的內容類型：' + (type || '未知')), { code: 'ETYPE' });
  }

  const html = buf.toString('utf8');
  const title = pickTitle(html) || finalUrl;
  const text = toText(narrow(html));

  return {
    url: finalUrl,
    title,
    type,
    bytes: buf.length,
    text: text.slice(0, 200000),
    links: collectLinks(html, finalUrl),
    extracted: true,
    // How much of the page was prose. Useful for spotting a failed extraction:
    // a ratio near zero usually means the content is rendered by script.
    ratio: html.length ? Math.round((text.length / html.length) * 1000) / 10 : 0
  };
}

/* Request headers a generated program may set. Everything else is dropped
   rather than refused, so a program that copies a browser's header list still
   runs. Host, Cookie, Origin and the connection headers are the ones that would
   let it impersonate this machine's browser or reach a private network's trust. */
const APP_HEADERS = /^(accept|accept-language|content-type|authorization|x-[a-z0-9-]+|if-none-match|if-modified-since|cache-control)$/i;
const MAX_APP_BODY = 1024 * 1024;

/**
 * A plain request for a generated program: `os.net.fetch` on the other side.
 *
 * Unlike read(), nothing is extracted -- the program wanted an API, and an API
 * answers in JSON. Same URL screen as read() (http/https only, no loopback, no
 * private ranges), same size cap, and the response is text: a program that
 * needs bytes can ask for base64 from a service that offers it. The frame's own
 * CSP is default-src 'none', so this is the only way out, and it is behind the
 * net.egress gate like every other request this machine makes.
 */
async function fetchRaw(rawUrl, opts = {}) {
  const url = validateUrl(rawUrl);
  const method = String(opts.method || 'GET').toUpperCase();
  if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(method)) {
    throw Object.assign(new Error('不支援的方法：' + method), { code: 'EINVAL' });
  }
  const headers = { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*;q=0.8' };
  for (const [k, v] of Object.entries(opts.headers && typeof opts.headers === 'object' ? opts.headers : {})) {
    if (!APP_HEADERS.test(k)) continue;
    headers[k] = String(v).replace(/[\r\n]/g, '').slice(0, 2000);
  }
  let body;
  if (opts.body != null && method !== 'GET' && method !== 'HEAD') {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    if (body.length > MAX_APP_BODY) {
      throw Object.assign(new Error('請求內容超過 1 MB'), { code: 'EFBIG' });
    }
    if (!headers['Content-Type'] && !headers['content-type'] && typeof opts.body !== 'string') {
      headers['Content-Type'] = 'application/json';
    }
  }

  const res = await request(url.href, {
    method,
    headers,
    body,
    screen: validateUrl,
    timeoutMs: Math.min(60000, Number(opts.timeoutMs) || TIMEOUT_MS)
  });
  const out = {};
  for (const name of ['content-type', 'content-length', 'etag', 'last-modified', 'cache-control', 'x-ratelimit-remaining']) {
    const v = res.header(name);
    if (v) out[name] = v;
  }
  return {
    url: res.url,
    status: res.status,
    ok: res.ok,
    headers: out,
    bytes: res.body.length,
    text: res.body.toString('utf8')
  };
}

module.exports = { read, fetchRaw, request, validateUrl, toText, decodeEntities };
