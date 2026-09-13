'use strict';
/**
 * What a model can hold, when the provider will not say.
 *
 * The machine reported 「n_ctx 未知（供應商不報）」 and that was accurate but not
 * useful: the number exists, it is published, and the user could read it on a
 * documentation page while the program in front of them claimed not to know.
 *
 * It is accurate because OpenAI's Models API genuinely does not carry it. The
 * whole documented response is:
 *
 *     id, object, created, owned_by, shutdown_date
 *
 * -- no context window, no output limit, no encoding name. So there is nothing
 * to read at run time for that provider, and the honest fix is not to try
 * harder against the API but to look in the three places the answer can
 * actually come from, in order of how much they can be trusted:
 *
 *   1. the provider, when it is one that reports it. Not OpenAI, but most
 *      OpenAI-compatible gateways do: vLLM sends `max_model_len`, OpenRouter
 *      sends `context_length`, Ollama sends it under the model's details, and
 *      llama.cpp answers `/props`. Read whatever is there rather than assuming
 *      the OpenAI shape is the only one.
 *   2. this table, for models whose numbers are published but not served. Every
 *      entry records where its number came from and when it was taken, because
 *      a number with no provenance is indistinguishable from a guess, and these
 *      go stale.
 *   3. the user, who can put it in the model settings and end the argument.
 *
 * And one that outranks all three when it happens: the provider's own refusal.
 * A request over the limit comes back saying what the limit was, and a number
 * measured from the thing itself is worth more than any of the above.
 */

/* Written down when the table was filled in, so a reader can tell how old these
   are without going through git. */
const TAKEN = '2026-09-12';

/**
 * Longest match wins, so `gpt-5.6-terra-2026-08` resolves through
 * `gpt-5.6-terra` rather than through `gpt-`.
 *
 * Only models whose numbers were actually read from the vendor's own
 * documentation are here. A family that publishes nothing gets no entry: an
 * invented number would be believed exactly as much as a real one.
 */
const KNOWN = [
  { id: 'gpt-6-astra', ctx: 1050000, out: 128000, src: 'openai-docs', at: TAKEN },
  { id: 'gpt-5.6-sol', ctx: 1050000, out: 128000, src: 'openai-docs', at: TAKEN },
  { id: 'gpt-5.6-terra', ctx: 1050000, out: 128000, src: 'openai-docs', at: TAKEN },
  { id: 'gpt-5.6-luna', ctx: 1050000, out: 128000, src: 'openai-docs', at: TAKEN }
];

/** Where a number came from, in words a person can weigh. */
const SOURCE_NAMES = {
  provider: '供應商回報',
  measured: '從伺服器的錯誤訊息量到的',
  user: '你自己設定的',
  'openai-docs': '內建資料表（OpenAI 文件，' + TAKEN + '）',
  table: '內建資料表'
};

function sourceName(src) {
  return SOURCE_NAMES[src] || String(src || '');
}

/** The table's entry for a model id, or null. */
function lookup(modelId) {
  const id = String(modelId || '').trim().toLowerCase();
  if (!id) return null;
  let best = null;
  for (const row of KNOWN) {
    if (id.indexOf(row.id) !== 0) continue;
    if (!best || row.id.length > best.id.length) best = row;
  }
  return best;
}

/**
 * The context window a provider reported, whatever shape it used to report it.
 *
 * Five names for one number, because five people implemented the same endpoint
 * separately. Reading all of them costs nothing and means a gateway that does
 * answer is not ignored because it phrased the answer differently.
 */
function reportedCtx(record) {
  if (!record || typeof record !== 'object') return 0;
  const names = [
    'context_length', 'context_window', 'max_context_length', 'max_model_len',
    'max_input_tokens', 'n_ctx', 'context_size'
  ];
  for (const n of names) {
    const v = Number(record[n]);
    if (Number.isFinite(v) && v > 0) return Math.round(v);
  }
  /* Nested, which is where OpenRouter and Ollama put it. */
  for (const holder of ['top_provider', 'details', 'model_info', 'capabilities', 'limits']) {
    const inner = record[holder];
    if (inner && typeof inner === 'object') {
      const got = reportedCtx(inner);
      if (got) return got;
    }
  }
  return 0;
}

function reportedOut(record) {
  if (!record || typeof record !== 'object') return 0;
  for (const n of ['max_output_tokens', 'max_completion_tokens', 'max_tokens_out']) {
    const v = Number(record[n]);
    if (Number.isFinite(v) && v > 0) return Math.round(v);
  }
  for (const holder of ['top_provider', 'details', 'model_info', 'capabilities', 'limits']) {
    const inner = record[holder];
    if (inner && typeof inner === 'object') {
      const got = reportedOut(inner);
      if (got) return got;
    }
  }
  return 0;
}

/**
 * A provider's refusal, read for the number it is refusing over.
 *
 * Worth more than the table: it is the limit as the server enforces it today,
 * for this key, on this deployment. Every phrasing here has been seen in the
 * wild from an OpenAI-compatible endpoint.
 */
function ctxFromError(message) {
  const t = String(message || '');
  const shapes = [
    /maximum context length is\s*([\d,]+)/i,
    /context length of\s*([\d,]+)/i,
    /max(?:imum)?[_\s-]?(?:model[_\s-]?len|context)[^0-9]{0,20}([\d,]+)/i,
    /reduce the length[^0-9]{0,40}([\d,]+)\s*tokens/i,
    /this model supports at most\s*([\d,]+)\s*tokens/i
  ];
  for (const re of shapes) {
    const m = re.exec(t);
    if (!m) continue;
    const n = Number(String(m[1]).replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return 0;
}

/**
 * A provider's refusal, read for the OUTPUT limit it is refusing over.
 *
 * Kept apart from ctxFromError because they are different numbers about
 * different things, and mixing them would be worse than knowing neither: a
 * context window learned from an output-cap refusal would shrink the attention
 * budget to a fraction of the truth, and nothing on screen would say why.
 *
 * The hard part is that these messages carry TWO numbers -- what was asked for
 * and what is allowed -- and the useful one is the smaller, later one:
 *
 *     max_tokens is too large: 200000. This model supports at most 128000
 *     completion tokens, whereas you provided 200000.
 *
 * So the shapes here anchor on the phrase that introduces the limit, never on
 * the one that quotes the request back. A pattern that matched "too large:
 * 200000" would learn the wrong number and then keep sending it.
 */
function outFromError(message) {
  const t = String(message || '');
  const shapes = [
    /supports? at most\s*([\d,]+)\s*(?:completion|output|sampled)\s*tokens/i,
    /* 「max_tokens: 300000 > 200000, which is the maximum allowed」 -- the limit
       is the number being exceeded, so it is the one on the right. */
    /max_tokens:\s*[\d,]+\s*>\s*([\d,]+)/i,
    /max(?:imum)?[_\s-]?(?:completion|output|sampled)[_\s-]?tokens?[^0-9]{0,40}?([\d,]+)/i,
    /max_tokens[^0-9]{0,40}?(?:must be|should be|has to be)[^0-9]{0,20}([\d,]+)/i,
    /(?:less than or equal to|at most|no more than|<=)\s*([\d,]+)\s*(?:completion|output)?\s*tokens/i
  ];
  for (const re of shapes) {
    const m = re.exec(t);
    if (!m) continue;
    const n = Number(String(m[1]).replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return 0;
}

/**
 * Everything known about one model, and where each part came from.
 *
 * `override` is the user's own setting and wins outright; a person who has
 * typed a number has more standing than a table compiled months ago.
 */
function describe(modelId, { reported = null, override = null, measured = 0, measuredOut = 0 } = {}) {
  const out = { model: String(modelId || ''), ctx: 0, out: 0, ctxSource: '', outSource: '' };

  const table = lookup(modelId);
  if (table) {
    out.ctx = table.ctx;
    out.out = table.out;
    out.ctxSource = table.src;
    out.outSource = table.src;
  }

  const rCtx = reportedCtx(reported);
  if (rCtx) { out.ctx = rCtx; out.ctxSource = 'provider'; }
  const rOut = reportedOut(reported);
  if (rOut) { out.out = rOut; out.outSource = 'provider'; }

  if (measured > 0) { out.ctx = measured; out.ctxSource = 'measured'; }
  if (measuredOut > 0) { out.out = measuredOut; out.outSource = 'measured'; }

  if (override && Number(override.ctx) > 0) { out.ctx = Math.round(Number(override.ctx)); out.ctxSource = 'user'; }
  if (override && Number(override.out) > 0) { out.out = Math.round(Number(override.out)); out.outSource = 'user'; }

  out.ctxSourceName = sourceName(out.ctxSource);
  out.outSourceName = sourceName(out.outSource);
  return out;
}

module.exports = {
  KNOWN, TAKEN, lookup, describe, reportedCtx, reportedOut, ctxFromError, outFromError,
  sourceName, SOURCE_NAMES
};
