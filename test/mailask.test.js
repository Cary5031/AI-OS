'use strict';

/* ===========================================================================
   Reading a sentence about a mailbox.
   ---------------------------------------------------------------------------
   郵件待辦 stopped being seven form fields and became a sentence, because the
   user's verdict on the seven fields was that they are too complicated. Two
   halves of that are testable without a model or a window, and they are the two
   halves where being wrong is expensive:

     read()    the plain reading. It runs whether or not there is a model, so a
               machine with no core still turns 「這禮拜 abc.com 寄來的信」 into
               a search. A window phrase read wrong is a rule that quietly looks
               at the wrong fortnight for months.

     merge()   the model's reading, grounded against the sentence. This is the
               one that stops a plausible invention from becoming what the
               mailbox gets searched for every morning: a model asked about
               「ABC 公司」 will offer `abc.com`, and nothing in an empty list
               afterwards says that is where it came from.

   Neither function ever sees a message, so nothing here is about untrusted
   content -- the inputs are what the user typed and a reply about it.
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');

const mailask = require('../app/renderer/mailask');

test('a sentence becomes a search: the conditions that are actually in it', () => {
  const r = mailask.read('這禮拜 abc.com 寄來的信都列出來，內容有提到我的標起來，每天早上七點半自己跑一次');
  assert.equal(r.from, 'abc.com', 'the domain as written');
  assert.equal(r.days, 7, '這禮拜');
  assert.equal(r.daysSaid, true, 'and it was asked for, not defaulted');
  assert.deepEqual(r.mentions, [], '提到我 turns the marking on, with the account supplying the words');
  assert.equal(r.dailyAt, '07:30', '每天早上七點半');
  assert.equal(r.summarise, true);

  const plain = mailask.read('監控系統寄來的警報，只留真的要我動手處理的');
  assert.equal(plain.days, 7, 'a window nobody asked for still has to be some number');
  assert.equal(plain.daysSaid, false, 'but the screen has to be able to say it was our choice');
  assert.equal(plain.from, '', 'a company described in prose is not a domain');
});

test('a domain ends where the domain ends, not where a space happens to be', () => {
  /* Chinese runs words together. The first version of this required a delimiter
     after the domain, so 「abc.com的信」 -- the way it is actually typed -- lost
     its sender entirely and the rule searched the whole mailbox instead. */
  assert.equal(mailask.read('abc.com的信都收進來').from, 'abc.com');
  assert.equal(mailask.read('這禮拜abc.com寄來的').from, 'abc.com');
  assert.equal(mailask.read('xyz.co.jp的信').from, 'xyz.co.jp');
  assert.equal(mailask.read('abc.com.tw的信').from, 'abc.com.tw', 'the longer domain wins');
  assert.deepEqual(mailask.sendersIn('billing@abc.com.tw 的請款信'), ['billing@abc.com.tw'],
    'the domain inside an address is not read a second time on its own');
  assert.equal(mailask.read('notabc.com 的信').from, 'notabc.com', 'and it is not truncated');
});

test('a company name is never turned into a domain', () => {
  /* The expensive failure this whole file exists for: the rule runs every
     morning against a domain the user never wrote, and an empty list looks
     exactly like a quiet mailbox. */
  for (const say of ['ABC 公司寄來的信', '幫我追蹤台積電的來信', '銀行寄來的通知']) {
    assert.equal(mailask.read(say).from, '', say + ' must not produce a guessed domain');
  }
  assert.equal(mailask.read('abc.com 寄來的信').from, 'abc.com', 'written down, it is used');
  assert.equal(mailask.read('billing@abc.com.tw 的請款信').from, 'billing@abc.com.tw',
    'an address beats the domain inside it');
});

test('windows people write, longest phrase first', () => {
  const cases = [
    ['今天的信', 1], ['昨天的信', 2], ['這幾天', 3], ['這禮拜', 7], ['一週內', 7],
    ['上禮拜的信', 14], ['這兩個禮拜', 14], ['兩個月內', 60], ['這個月收到的信', 30],
    ['近一個月', 30], ['上個月的信', 60], ['三個月內的信', 90], ['半年內', 180],
    ['今年的信', 365], ['近 45 天', 45], ['六個星期', 42]
  ];
  for (const [say, want] of cases) {
    assert.equal(mailask.daysIn(say), want, say);
  }
  assert.equal(mailask.daysIn('沒有提到時間的句子'), 0, 'nothing said is 0, not a default');
  assert.equal(mailask.daysIn('這個月的信，近 45 天就好'), 45, 'a number beats a phrase');
  /* 上個月 is 60 and not 30 because the search runs backwards from today: 30
     would stop at the first of this month and miss the month being asked about. */
  assert.equal(mailask.daysIn('上個月'), 60);
});

test('a time of day only counts when the sentence wants it to happen by itself', () => {
  assert.equal(mailask.dailyIn('每天早上八點跑一次'), '08:00');
  assert.equal(mailask.dailyIn('每天早上七點半'), '07:30');
  assert.equal(mailask.dailyIn('每天 08:00'), '08:00');
  assert.equal(mailask.dailyIn('下午三點半每天跑一次'), '15:30', '下午 moves it past noon');
  assert.equal(mailask.dailyIn('晚上十一點每天跑'), '23:00', 'a written-out hour');
  assert.equal(mailask.dailyIn('每日 07:05 跑'), '07:05');
  /* The mixed phrasing -- a word for the half of the day, digits for the time --
     is the common one, and the digits branch used to stop at the digits: 「每天
     下午 3:30」 scheduled itself for half past three in the morning. */
  assert.equal(mailask.dailyIn('每天下午 3:30 跑一次'), '15:30');
  assert.equal(mailask.dailyIn('每天晚上 9:05'), '21:05');
  assert.equal(mailask.dailyIn('每天上午 9:05'), '09:05');

  assert.equal(mailask.dailyIn('八點那封信要找出來'), '',
    'a time in the subject matter is not a schedule');
  assert.equal(mailask.dailyIn('每天都會收到的那種信'), '',
    'every day, but no hour: nothing to schedule');
  assert.equal(mailask.dailyIn('每天 99:99 跑'), '', 'out of range is nothing');
});

test('quoted words and case numbers are the only keywords taken', () => {
  assert.equal(mailask.read('主旨有「請款」的信').text, '請款');
  assert.equal(mailask.read('跟 P2409 這個案子有關的信').text, 'P2409');
  assert.equal(mailask.read('客戶在催進度的信挑出來').text, '',
    'prose is not a keyword -- that is what the criterion is for');
});

test('switches the sentence flips', () => {
  assert.equal(mailask.read('還沒讀的信裡挑出語氣很急的').unread, true);
  assert.equal(mailask.read('未讀的信').unread, true);
  assert.equal(mailask.read('有夾檔案寄來的信').hasAttachment, true);
  assert.equal(mailask.read('有附件的信').hasAttachment, true);
  assert.equal(mailask.read('不要彙整，只要主旨').summarise, false);
  assert.equal(mailask.read('每封寫一行摘要').summarise, true);
});

/* --------------------------------------------------------------- grounding */

test('the model may not put anything in a search condition that is not in the sentence', () => {
  const say = 'ABC 公司寄來的信，這禮拜的';
  const base = mailask.read(say);
  const plan = mailask.merge(base, {
    from: 'abc.com',            // plausible, never written down
    text: '報價',               // also never written down
    days: 7,
    sieve: '只留在催我回覆的',
    name: 'ABC 公司'
  }, say);

  assert.equal(plan.from, '', 'the invented domain does not reach the mailbox');
  assert.equal(plan.text, '', 'nor the invented keyword');
  assert.equal(plan.dropped.length, 2, 'and both are reported rather than silently dropped');
  assert.match(plan.dropped.join(' '), /abc\.com/, 'the screen can name what was refused');
  assert.match(plan.dropped.join(' '), /報價/);
  assert.equal(plan.sieve, '只留在催我回覆的',
    'the criterion is an instruction, not a search key: nothing to ground it against');
  assert.equal(plan.sift, true, 'and having one turns the sieve on');
});

test('what the sentence does contain is believed, punctuation and case aside', () => {
  const say = '幫我追 ABC.COM 的信，關鍵字「請款」';
  const plan = mailask.merge(mailask.read(say), { from: 'abc.com', text: '請款' }, say);
  assert.equal(plan.from, 'abc.com', 'case is not a difference that means anything');
  assert.equal(plan.text, '請款');
  assert.deepEqual(plan.dropped, [], 'nothing to report');

  assert.equal(mailask.grounded('abc.com', 'ＡＢＣ．ＣＯＭ 的信'), true,
    'full-width input is the same request');
  assert.equal(mailask.grounded('abc.com', 'ABC 公司的信'), false);
  assert.equal(mailask.grounded('', 'anything'), false, 'nothing is not grounded');
});

test('numbers are clamped, not quoted', () => {
  const say = '這禮拜的信';
  const plan = mailask.merge(mailask.read(say), { days: 4000, limit: 999 }, say);
  assert.equal(plan.days, 365, 'a year is as far back as a rule reaches');
  assert.equal(plan.limit, 50);
  assert.equal(plan.bodies, mailask.MAX_BODIES,
    'and the reading budget never exceeds what the bridge will fetch');

  const small = mailask.merge(mailask.read(say), { limit: 5 }, say);
  assert.equal(small.bodies, 5, 'asking for fewer reads fewer');
});

test('the switches are grounded too, because they are search conditions', () => {
  /* unread and hasAttachment reach mailstore exactly as `from` does: one drops
     every message that has been opened, the other every message without a file.
     A boolean has no substring to find, so what grounds it is the plain reading
     -- the sentence has the cue or it does not. */
  const say = 'abc.com 這禮拜寄來、我還沒處理完的信列出來';
  const plan = mailask.merge(mailask.read(say), { unread: true, hasAttachment: true }, say);
  assert.equal(plan.unread, false, '「還沒處理完」 is not 「未讀」, and the model may not decide it is');
  assert.equal(plan.hasAttachment, false);
  assert.equal(plan.dropped.length, 2, 'and both refusals are reported');
  assert.match(plan.dropped.join(' '), /只看未讀/);

  const said = '未讀的信裡挑出語氣急的';
  const kept = mailask.merge(mailask.read(said), { unread: false }, said);
  assert.equal(kept.unread, true, 'what the user did say survives the model disagreeing');
  assert.match(kept.dropped.join(' '), /不限未讀/);

  const agreed = '未讀又有附件的信';
  const fine = mailask.merge(mailask.read(agreed), { unread: true, hasAttachment: true }, agreed);
  assert.deepEqual(fine.dropped, [], 'agreeing with the sentence is not a refusal');
});

test('a sentence with nothing to search for is still a rule', () => {
  /* Three of the six examples on the first screen name no sender, no keyword and
     no switch -- that is the entire point of them. With no criterion either there
     would be nothing to store, so the plain reading falls back to the only
     criterion it is sure of: what the user wrote. Without this, a machine with no
     model answered five of its own six suggestions with a refusal. */
  const say = '這禮拜有人問我問題、還在等我回覆的信挑出來';
  const plan = mailask.merge(mailask.read(say), {}, say);
  assert.equal(plan.sieve, say, 'the sentence becomes the criterion');
  assert.equal(plan.sift, true);
  assert.equal(mailask.isWide(plan), true, 'and it is still marked as looking at the newest few');

  const better = mailask.merge(mailask.read(say), { sieve: '在等我回覆的' }, say);
  assert.equal(better.sieve, '在等我回覆的', 'a model reading the same sentence replaces it');

  const narrowed = mailask.merge(mailask.read('abc.com 的信'), {}, 'abc.com 的信');
  assert.equal(narrowed.sieve, '', 'a sentence that does narrow the mailbox needs no fallback');
});

test('re-reading a rule never erases what only the rule knew', () => {
  /* The base is the rule being edited. Blanking these meant that pressing save
     on a machine with no core deleted the criterion, the summary instruction and
     the per-run limit -- none of which the mechanical reader can produce, and
     none of which the user had asked to change. */
  const say = 'abc.com 的信';
  const existing = {
    from: 'abc.com', days: 7, sieve: '只留在催我回覆的', sift: true,
    focus: '寫金額跟期限', limit: 30, mentions: ['小陳']
  };
  const base = mailask.read(say);
  base.sieve = existing.sieve;
  base.sift = existing.sift;
  base.focus = existing.focus;
  base.limit = existing.limit;
  base.mentions = existing.mentions.slice();

  const plan = mailask.merge(base, {}, say);
  assert.equal(plan.sieve, '只留在催我回覆的');
  assert.equal(plan.focus, '寫金額跟期限');
  assert.equal(plan.limit, 30);
  assert.deepEqual(plan.mentions, ['小陳']);
  assert.equal(plan.bodies, mailask.MAX_BODIES, 'but the reading budget is still the bridge\'s');
});

test('a rule with no mechanical condition is marked as looking at whatever is newest', () => {
  const say = '語氣已經在催的那種留下來，不管是誰寄的';
  const plan = mailask.merge(mailask.read(say), { sieve: '語氣在催促的' }, say);
  assert.equal(mailask.isWide(plan), true, 'nothing narrows the mailbox but the window');
  assert.equal(mailask.isWide(mailask.merge(mailask.read('abc.com 的信'), {}, 'abc.com 的信')), false);
});

/* ------------------------------------------------------------------- drift */

test('a rule knows when its conditions were read from an older sentence', () => {
  const say = '這禮拜 abc.com 寄來的信';
  const rule = { say: say, sayFor: mailask.fingerprint(say) };
  assert.equal(mailask.isStale(rule), false);

  rule.say = '這禮拜 xyz.com 寄來的信';
  assert.equal(mailask.isStale(rule), true, 'the sentence moved and the conditions did not');

  assert.equal(mailask.isStale({ say: '', sayFor: '' }), false, 'an old fieldwise rule is not stale');
  assert.equal(mailask.fingerprint(say), mailask.fingerprint(say), 'same sentence, same fingerprint');
  assert.notEqual(mailask.fingerprint('a'), mailask.fingerprint('b'));
  assert.match(mailask.fingerprint(say), /^[0-9a-f]{16}$/, 'short and stable');
});

test('a rule written before sentences existed gets one that says what it has been doing', () => {
  const said = mailask.sentenceOf({
    from: 'abc.com', text: '請款', days: 14, mentions: ['小陳'], summarise: true
  });
  assert.match(said, /近 14 天/);
  assert.match(said, /abc\.com/);
  assert.match(said, /請款/);
  assert.match(said, /小陳/);

  /* And reading that sentence back has to produce the conditions it came from,
     or the migration would change what the rule finds. */
  const back = mailask.read(said);
  assert.equal(back.from, 'abc.com');
  assert.equal(back.text, '請款');
  assert.equal(back.days, 14);

  /* Including the switch that costs money. A rule with summarising turned off
     became a sentence saying so, and reading it back turned it on again -- so
     migrating a deliberately cheap rule started paying for a model call a day. */
  const quiet = mailask.sentenceOf({ from: 'abc.com', days: 7, summarise: false });
  assert.equal(mailask.read(quiet).summarise, false, quiet);
  assert.equal(mailask.read(mailask.sentenceOf({ from: 'abc.com', days: 7 })).summarise, true);

  assert.equal(mailask.sentenceOf({ say: '使用者自己寫的句子' }), '使用者自己寫的句子',
    'a rule that already has one keeps it');
});

test('everything is bounded and single-line, because it all ends up on screen', () => {
  const long = 'x'.repeat(2000);
  const plan = mailask.merge(mailask.read(long), { sieve: long, focus: long, name: long }, long);
  assert.ok(plan.say.length <= mailask.MAX_SAY);
  assert.ok(plan.sieve.length <= 200);
  assert.ok(plan.focus.length <= 200);
  assert.ok(plan.name.length <= 60);

  const nasty = mailask.read('第一行\n第二行​‮');
  assert.equal(nasty.say.indexOf('\n'), -1, 'newlines collapse');
  assert.equal(nasty.say.indexOf('‮'), -1, 'and so does anything that reorders a line');
});
