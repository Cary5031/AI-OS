'use strict';

/* ===========================================================================
   AI-OS // long-term memory manager
   ---------------------------------------------------------------------------
   Nothing in this machine's memory is hardcoded. It starts empty, and every
   item arrives one of two ways: the user typed it, or a turn taught it. Both are
   labelled, so "why does it think that about me" always has an answer, and
   anything can be corrected or deleted.

   Pinned items survive eviction when memory fills up and score higher during
   retrieval, which makes pinning the way to say "this is not negotiable".
   =========================================================================== */

/* global window, document, AIOS */

(function () {
  var A = window.aios;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* A memory card is the person's own note, but it is still handed to an
     extension only as what the card shows. */
  AIOS.slots.declare('memory:entry-row', {
    desc: '每一則記憶底下多一行字',
    gives: '{rows:[{id, text, tags, pinned, source, useCount, updatedAt}]}',
    wants: '{items:["每一則要多寫的那行字，沒有就給空字串"]}'
  });
  AIOS.slots.declare('memory:entry-actions', {
    kind: 'act',
    desc: '記憶的右鍵選單多一項，按下去把那一則交給擴充程式',
    gives: '{slot, unit:{id, text, tags, pinned, source, useCount, updatedAt}}',
    wants: 'slotAct 自己決定；它跑在擴充程式自己的視窗與能力裡',
    unitAt: function (ev) {
      var card = ev && ev.target && ev.target.closest ? ev.target.closest('.mem-card') : null;
      return card && card.__slotUnit ? card.__slotUnit : null;
    }
  });

  AIOS.apps.register({
    id: 'memory',
    name: '長期記憶',
    icon: '\u25c9',
    kind: 'MEM',
    width: 640,
    height: 460,
    singleton: true,
    purpose: '管理這台機器記得的事',
    chatHint: '可以說「記住我用繁體中文」或「把關於顯卡的記憶改成 RTX 5090」。',

    actions: {
      remember: {
        args: '{text, tags}', desc: '新增一筆記憶',
        run: async function (args, ctx) {
          var r = await A.memory.add({ text: args.text, tags: args.tags, source: 'manual' });
          if (!r.ok) throw new Error(r.error);
          await ctx.api.refresh();
          return { note: r.data.deduped ? '已合併到既有記憶' : '已記住' };
        }
      },
      edit: {
        args: '{id, text}', desc: '修改一筆記憶',
        run: async function (args, ctx) {
          var r = await A.memory.update(args.id, { text: args.text });
          if (!r.ok) throw new Error(r.error);
          await ctx.api.refresh();
          return { note: '已更新 ' + args.id };
        }
      },
      forget: {
        args: '{id}', desc: '刪除一筆記憶',
        run: async function (args, ctx) {
          var r = await A.memory.remove(args.id);
          if (!r.ok) throw new Error(r.error);
          await ctx.api.refresh();
          return { note: '已刪除' };
        }
      },
      pin: {
        args: '{id, pinned}', desc: '釘選或取消釘選',
        run: async function (args, ctx) {
          var r = await A.memory.update(args.id, { pinned: args.pinned !== false });
          if (!r.ok) throw new Error(r.error);
          await ctx.api.refresh();
          return { note: args.pinned === false ? '已取消釘選' : '已釘選' };
        }
      }
    },

    mount: function (ctx) {
      ctx.body.classList.add('flush');

      var items = [];
      var filter = '';
      var editing = null;

      /* ---------------------------------------------------------- chrome */

      var addForm = el('form', 'mem-add');
      var addInput = el('textarea', 'mem-add-input');
      addInput.rows = 2;
      addInput.placeholder = '要這台機器記住什麼？（例如：我偏好繁體中文回覆）';
      addInput.setAttribute('aria-label', '新記憶內容');
      var addTags = el('input', 'mem-add-tags');
      addTags.placeholder = '標籤，用逗號分隔（可留空）';
      addTags.setAttribute('aria-label', '標籤');
      var addBtn = el('button', 'fbtn fbtn-primary', '記住');
      addBtn.type = 'submit';
      var row = el('div', 'mem-add-row');
      row.appendChild(addTags);
      row.appendChild(addBtn);
      addForm.appendChild(addInput);
      addForm.appendChild(row);
      ctx.body.appendChild(addForm);

      var bar = el('div', 'mem-bar');
      var search = el('input', 'mem-search');
      search.type = 'search';
      search.placeholder = '搜尋記憶…';
      search.setAttribute('aria-label', '搜尋記憶');
      bar.appendChild(search);
      var btnExport = el('button', 'fbtn', '匯出');
      btnExport.type = 'button';
      btnExport.title = '把全部記憶寫成沙箱裡的 JSON';
      var btnImport = el('button', 'fbtn', '匯入');
      btnImport.type = 'button';
      btnImport.title = '從沙箱的 JSON 匯入（累加，不會清空現有記憶）';
      bar.appendChild(btnExport);
      bar.appendChild(btnImport);
      ctx.body.appendChild(bar);

      var list = el('ul', 'mem-list');
      list.setAttribute('aria-label', '記憶清單');
      ctx.body.appendChild(list);

      var status = el('div', 'mem-status');
      ctx.body.appendChild(status);

      /* -------------------------------------------------------- rendering */

      function unitOf(it) {
        return {
          id: String(it.id || ''), text: String(it.text || ''), tags: (it.tags || []).map(String),
          pinned: !!it.pinned, source: String(it.source || ''),
          useCount: Number(it.useCount) || 0, updatedAt: Number(it.updatedAt) || 0
        };
      }

      function paintContributions(shown) {
        if (!AIOS.slots || !shown.length) return;
        var cards = list.querySelectorAll('li.mem-card');
        AIOS.slots.annotate('memory:entry-row', shown.map(unitOf), function (i) { return cards[i] || null; });
      }

      function render() {
        list.innerHTML = '';
        var shown = items;
        if (filter) {
          var f = filter.toLowerCase();
          shown = items.filter(function (it) {
            return it.text.toLowerCase().indexOf(f) >= 0 ||
                   (it.tags || []).join(' ').toLowerCase().indexOf(f) >= 0;
          });
        }

        if (!items.length) {
          var empty = el('li', 'mem-empty-state');
          empty.appendChild(el('p', null, '記憶是空的。'));
          empty.appendChild(el('p', 'micro',
            '這裡不預載任何東西。上面打一句話按「記住」，或在主意圖列說「記住…」，' +
            '模型也會在對話中主動提議要記下的事，你可以留下或刪掉。'));
          list.appendChild(empty);
        } else if (!shown.length) {
          list.appendChild(el('li', 'mem-empty-state', '沒有符合「' + filter + '」的記憶'));
        }

        shown.forEach(function (it) {
          var li = el('li', 'mem-card' + (it.pinned ? ' pinned' : ''));
          // Read back by the menu provider.
          li.__item = it;
          li.__slotUnit = unitOf(it);

          var head = el('div', 'mem-card-head');
          var src = el('span', 'mem-src mem-src-' + it.source, it.source === 'learned' ? '學習而來' : '手動輸入');
          head.appendChild(src);
          if (it.useCount) head.appendChild(el('span', 'mem-uses', '用過 ' + it.useCount + ' 次'));
          head.appendChild(el('span', 'mem-when', new Date(it.updatedAt).toLocaleDateString('zh-TW')));

          var pin = el('button', 'mem-icon', it.pinned ? '\u25c9' : '\u25cb');
          pin.type = 'button';
          pin.title = it.pinned ? '取消釘選' : '釘選（不會被淘汰，檢索時加權）';
          pin.setAttribute('aria-pressed', it.pinned ? 'true' : 'false');
          pin.addEventListener('click', async function () {
            await A.memory.update(it.id, { pinned: !it.pinned });
            await refresh();
          });
          head.appendChild(pin);

          var edit = el('button', 'mem-icon', '\u270e');
          edit.type = 'button';
          edit.title = '編輯';
          edit.addEventListener('click', function () { editing = editing === it.id ? null : it.id; render(); });
          head.appendChild(edit);

          var del = el('button', 'mem-icon mem-del', '\u2715');
          del.type = 'button';
          del.title = '刪除';
          del.addEventListener('click', async function () {
            var r = await A.memory.remove(it.id);
            if (!r.ok) { ctx.toast('刪除失敗：' + r.error, 't-err'); return; }
            await refresh();
          });
          head.appendChild(del);
          li.appendChild(head);

          if (editing === it.id) {
            var form = el('form', 'mem-edit');
            var ta = el('textarea', 'mem-edit-input');
            ta.value = it.text;
            ta.rows = 3;
            ta.setAttribute('aria-label', '編輯記憶內容');
            var tagsIn = el('input', 'mem-add-tags');
            tagsIn.value = (it.tags || []).join(', ');
            tagsIn.setAttribute('aria-label', '編輯標籤');
            var save = el('button', 'fbtn fbtn-primary', '儲存');
            save.type = 'submit';
            var cancel = el('button', 'fbtn', '取消');
            cancel.type = 'button';
            var r2 = el('div', 'mem-add-row');
            r2.appendChild(tagsIn); r2.appendChild(cancel); r2.appendChild(save);
            form.appendChild(ta); form.appendChild(r2);
            form.addEventListener('submit', async function (e) {
              e.preventDefault();
              var res = await A.memory.update(it.id, {
                text: ta.value,
                tags: tagsIn.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean)
              });
              if (!res.ok) { ctx.toast('更新失敗：' + res.error, 't-err'); return; }
              editing = null;
              await refresh();
            });
            cancel.addEventListener('click', function () { editing = null; render(); });
            li.appendChild(form);
          } else {
            li.appendChild(el('p', 'mem-text', it.text));
            if ((it.tags || []).length) {
              var tagWrap = el('div', 'mem-tags');
              it.tags.forEach(function (t) { tagWrap.appendChild(el('span', 'mem-tag', t)); });
              li.appendChild(tagWrap);
            }
          }

          list.appendChild(li);
        });
        paintContributions(shown);

        var manual = items.filter(function (i) { return i.source === 'manual'; }).length;
        var learned = items.length - manual;
        status.textContent = items.length + ' 筆記憶（手動 ' + manual + ' · 學習 ' + learned + '）' +
          '　·　釘選 ' + items.filter(function (i) { return i.pinned; }).length +
          (filter ? '　·　顯示 ' + shown.length : '');
        publish();
      }

      async function refresh() {
        var res = await A.memory.list();
        if (!res.ok) { ctx.toast('讀取記憶失敗：' + res.error, 't-err'); return; }
        items = res.data;
        render();
        if (AIOS.ui) AIOS.ui.renderMemory();
      }

      /* -------------------------------------------------------- behaviour */

      addForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var text = addInput.value.trim();
        if (!text) return;
        var res = await A.memory.add({
          text: text,
          tags: addTags.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
          source: 'manual'
        });
        if (!res.ok) { ctx.toast('新增失敗：' + res.error, 't-err'); return; }
        addInput.value = '';
        addTags.value = '';
        ctx.toast(res.data.deduped ? '已合併到既有記憶' : '已記住', 't-ok');
        await refresh();
      });

      var timer = null;
      search.addEventListener('input', function () {
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(function () { filter = search.value.trim(); render(); }, 140);
      });

      btnExport.addEventListener('click', async function () {
        var res = await A.memory.export();
        if (!res.ok) { ctx.toast('匯出失敗：' + res.error, 't-err'); return; }
        var path = '/notes/memory-export.json';
        var w = await A.fs.write(path, JSON.stringify(res.data, null, 2));
        if (!w.ok) { ctx.toast('寫入失敗：' + w.error, 't-err'); return; }
        ctx.toast('已匯出到 ' + path, 't-ok');
        await AIOS.afterFsChange();
      });

      btnImport.addEventListener('click', async function () {
        var path = '/notes/memory-export.json';
        var r = await A.fs.read(path);
        if (!r.ok) { ctx.toast('找不到 ' + path + '（先匯出或把檔案放進沙箱）', 't-warn'); return; }
        var payload;
        try { payload = JSON.parse(r.data.content); } catch (e) { ctx.toast('JSON 格式不對', 't-err'); return; }
        var res = await A.memory.import(payload);
        if (!res.ok) { ctx.toast('匯入失敗：' + res.error, 't-err'); return; }
        ctx.toast('匯入 ' + res.data.added + ' 筆，略過重複 ' + res.data.skipped + ' 筆', 't-ok');
        await refresh();
      });

      function publish() {
        if (!items.length) { ctx.publish(null); return; }
        ctx.publish('長期記憶（' + items.length + ' 筆）：\n' +
          items.slice(0, 40).map(function (i) {
            return '  [' + i.id + '] ' + (i.pinned ? '★ ' : '') + i.text;
          }).join('\n'), 'app/memory');
      }

      ctx.describe(function () {
        return '記憶清單（id 可用於 edit / forget / pin 動作）：\n' +
          (items.length
            ? items.map(function (i) {
                return '  ' + i.id + (i.pinned ? ' ★' : '') + ' [' + i.source + '] ' + i.text +
                       ((i.tags || []).length ? '  #' + i.tags.join(' #') : '');
              }).join('\n')
            : '  （空的）');
      });

      /* Right-click. Deleting a memory asks first: this is the one store on the
         machine whose contents cannot be reconstructed from anything else. */
      ctx.setMenu(function (ev) {
        var card = ev.target.closest ? ev.target.closest('.mem-card') : null;
        var it = card && card.__item;

        if (it) {
          return [
            { label: it.pinned ? '取消釘選' : '釘選', run: async function () {
              await A.memory.update(it.id, { pinned: !it.pinned });
              await refresh();
            } },
            { label: '複製內容', run: function () { A.clipboard.write(it.text); ctx.toast('已複製'); } },
            it.source === 'learned'
              ? { label: '這筆是學習而來的', disabled: true }
              : null,
            { sep: true },
            { label: '刪掉這筆記憶', danger: true, run: async function () {
              var ok = await ctx.confirm({
                label: '忘掉這筆記憶？',
                note: it.text.slice(0, 160),
                okLabel: '忘掉',
                danger: true
              });
              if (!ok) return;
              var r = await A.memory.remove(it.id);
              if (!r.ok) { ctx.toast('刪除失敗：' + r.error, 't-err'); return; }
              await refresh();
              ctx.toast('已忘掉一筆', 't-ok');
            } }
          ];
        }

        return [
          { label: '重新讀取', run: refresh },
          { sep: true },
          { label: '匯出成 JSON 到剪貼簿', run: async function () {
            var r = await A.memory.export();
            if (!r.ok) { ctx.toast('匯出失敗：' + r.error, 't-err'); return; }
            A.clipboard.write(JSON.stringify(r.data, null, 2));
            ctx.toast('已複製 ' + (r.data.items || []).length + ' 筆到剪貼簿', 't-ok');
          } },
          { label: '從剪貼簿匯入 JSON', run: async function () {
            var c = await A.clipboard.read();
            if (!c.ok || !c.data.text) { ctx.toast('剪貼簿是空的', 't-warn'); return; }
            var payload;
            try { payload = JSON.parse(c.data.text); }
            catch (e) { ctx.toast('剪貼簿裡不是合法的 JSON', 't-err'); return; }
            var r = await A.memory.import(payload);
            if (!r.ok) { ctx.toast('匯入失敗：' + r.error, 't-err'); return; }
            await refresh();
            ctx.toast('匯入 ' + r.data.added + ' 筆，略過重複 ' + r.data.skipped + ' 筆', 't-ok');
          } }
        ];
      });

      ctx.api = { refresh: refresh };
      refresh();

      return {
        getState: function () { return { filter: filter }; },
        onClose: function () { ctx.publish(null); }
      };
    }
  });
})();
