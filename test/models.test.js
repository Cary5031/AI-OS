'use strict';

/* ===========================================================================
   What a model can hold, when the provider will not say.

   The machine reported 「n_ctx 未知（供應商不報）」 while the number was published
   on a page the user could read. It was accurate -- OpenAI's Models API returns
   id, object, created, owned_by and shutdown_date, and nothing else -- and
   being accurate about not knowing something knowable is still the wrong
   answer.

   So the number is looked for in four places, and every one of them records
   where it came from. These tests are about the order they win in: a table
   compiled in September must not outrank the server's own refusal, and nothing
   may outrank what the user typed.
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');

const models = require('../app/main/models');

test('已知的模型講得出自己的上限，連帶日期變體也認得', () => {
  const got = models.describe('gpt-5.6-terra');
  assert.equal(got.ctx, 1050000);
  assert.equal(got.out, 128000);
  assert.equal(got.ctxSource, 'openai-docs');
  assert.match(got.ctxSourceName, /內建資料表/, '數字要說得出自己哪裡來的');
  assert.ok(got.ctxSourceName.includes(models.TAKEN), '還要說得出是什麼時候抄的');

  /* Providers add a date to the id when they pin a snapshot. Longest prefix
     wins, so a dated variant resolves through its family and not through a
     shorter, wronger entry. */
  assert.equal(models.describe('gpt-5.6-terra-2026-08-01').ctx, 1050000);
  assert.equal(models.describe('GPT-5.6-Terra').ctx, 1050000, '大小寫不該影響');
});

test('不知道就說不知道，不要編一個出來', () => {
  const got = models.describe('some-local-gguf-model');
  assert.equal(got.ctx, 0);
  assert.equal(got.out, 0);
  assert.equal(got.ctxSource, '');
  /* A family that publishes nothing gets no entry. An invented number would be
     believed exactly as much as a real one, and the machine would be confidently
     wrong instead of honestly ignorant. */
  assert.equal(models.lookup('gpt-realtime-2.1'), null,
    '文件沒寫上限的型號就不該在表裡');
});

test('供應商有講就聽它的，不管它用哪個欄位名', () => {
  /* Five names for one number, because five people implemented the same
     endpoint separately. OpenAI reports none of them; almost every
     OpenAI-compatible gateway reports one. */
  assert.equal(models.reportedCtx({ context_length: 32768 }), 32768, 'OpenRouter');
  assert.equal(models.reportedCtx({ max_model_len: 8192 }), 8192, 'vLLM');
  assert.equal(models.reportedCtx({ n_ctx: 4096 }), 4096, 'llama.cpp');
  assert.equal(models.reportedCtx({ context_window: 200000 }), 200000);
  assert.equal(models.reportedCtx({ max_input_tokens: 1000 }), 1000);
  assert.equal(models.reportedCtx({ top_provider: { context_length: 131072 } }), 131072,
    '包一層的也要讀得到');
  assert.equal(models.reportedCtx({ id: 'x', owned_by: 'y' }), 0, 'OpenAI 自己什麼都沒給');
  assert.equal(models.reportedCtx(null), 0);

  assert.equal(models.reportedOut({ max_output_tokens: 4096 }), 4096);
  assert.equal(models.reportedOut({ details: { max_completion_tokens: 8192 } }), 8192);
});

test('伺服器自己拒絕時講的數字最準，因為那是今天的這個部署', () => {
  /* The one moment a provider that documents nothing says the number out loud.
     Every phrasing here has come back from an OpenAI-compatible endpoint. */
  assert.equal(models.ctxFromError(
    "This model's maximum context length is 128000 tokens. However, you requested 131000."), 128000);
  assert.equal(models.ctxFromError(
    'maximum context length is 1,050,000 tokens'), 1050000, '有千分位也要讀得出來');
  assert.equal(models.ctxFromError(
    'This model supports at most 8192 tokens'), 8192);
  assert.equal(models.ctxFromError('Rate limit exceeded'), 0, '不是這種錯就不要亂認');
  assert.equal(models.ctxFromError(''), 0);
  assert.equal(models.ctxFromError(null), 0);
});

test('四個來源的順序：使用者 > 量到的 > 供應商 > 內建表', () => {
  const table = models.describe('gpt-5.6-terra');
  assert.equal(table.ctxSource, 'openai-docs');

  const reported = models.describe('gpt-5.6-terra', { reported: { context_length: 32768 } });
  assert.equal(reported.ctx, 32768, '供應商講的贏過表');
  assert.equal(reported.ctxSource, 'provider');

  const measured = models.describe('gpt-5.6-terra', {
    reported: { context_length: 32768 }, measured: 65536
  });
  assert.equal(measured.ctx, 65536, '從錯誤訊息量到的又贏過供應商的清單');
  assert.equal(measured.ctxSource, 'measured');

  const mine = models.describe('gpt-5.6-terra', {
    reported: { context_length: 32768 }, measured: 65536, override: { ctx: 4096 }
  });
  assert.equal(mine.ctx, 4096, '使用者自己填的贏過全部');
  assert.equal(mine.ctxSource, 'user');
  assert.match(mine.ctxSourceName, /你自己/);
});

test('每一條內建資料都寫得出來源與日期', () => {
  /* A number with no provenance is indistinguishable from a guess, and these go
     stale: a reader has to be able to tell how old they are without going
     through git. */
  assert.ok(models.KNOWN.length > 0);
  for (const row of models.KNOWN) {
    assert.ok(row.id && typeof row.id === 'string');
    assert.ok(row.ctx > 0, row.id + ' 的 context window 要有值');
    assert.ok(row.src, row.id + ' 沒有註明來源');
    assert.match(String(row.at), /^\d{4}-\d{2}-\d{2}$/, row.id + ' 沒有註明日期');
    assert.ok(models.sourceName(row.src), row.src + ' 沒有人看得懂的說法');
  }
});
