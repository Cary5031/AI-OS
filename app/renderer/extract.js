'use strict';

/* ===========================================================================
   AI-OS // document extraction, the part with no screen in it
   ---------------------------------------------------------------------------
   Everything the 文件萃取 program knows that is not a button: what a vendor
   profile is, what prompt goes with a document, how the rows that come back are
   squared up against the columns that were asked for, which cells are missing,
   what each file should be renamed to, and where it gets filed.

   Kept out of the window for the usual reason -- this is the half that can be
   tested without a DOM, and it is the half where being wrong is expensive. A
   part number filed under the wrong vendor is not a cosmetic bug.

   THE PROFILE IS A FILE

   A vendor profile is one JSON file in the sandbox. Not a database row, not a
   setting inside the program: a file, so it can be read, edited, diffed, copied
   to another machine, and kept in a folder next to the documents it describes.
   The prompt that a prompt-tuning studio produced is pasted into it.

   Its keys are Chinese because the people who edit these are reading Chinese
   delivery notes, and English aliases are accepted because the API that
   produced some of them speaks English. Both, always, in that order.

   EVERY VALUE IS TEXT

   A part number is 0012345 and a heat number is 0800. Read as numbers they
   become 12345 and 800, and the spreadsheet stops matching the document. So the
   model is asked for strings, the rows are kept as strings, and the cells are
   written with the text format. One rule, applied the whole way down, rather
   than three places that each have to remember.
   =========================================================================== */

/* global window, module */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null);
  } else {
    root.AIOS = root.AIOS || {};
    root.AIOS.extract = factory(root.AIOS);
  }
}(typeof window !== 'undefined' ? window : this, function () {

  /* Where profiles live. A folder rather than a file, so one vendor's settings
     can be handed to someone else by sending them one file. */
  var PROFILE_DIR = '/檔案/萃取設定';
  var PROFILE_EXT = '.json';

  /* The default destination. Placeholders are resolved per document, so one
     profile can serve every month without being edited. */
  var DELIVER_DEFAULT = '/檔案/{大類}/{廠商}/{年月}';

  /* The two bins under the destination. Their own console calls them this and
     whatever reads the result downstream is expecting these words, so they are
     the defaults rather than translations -- and they are overridable, because
     somebody else's downstream will be expecting different ones. */
  var FINISHED = 'Finished';
  var UNSURE = 'Undefined';

  /* Where each row came from. Appended after the profile's own columns, never
     mixed into them: these are provenance, not data, and an export that lost
     them would leave a person holding a row they cannot trace back to a page. */
  var SOURCE_COLUMNS = ['_檔名', '_廠商', '_列號'];

  var MAX_COLUMNS = 60;
  var MAX_ROWS = 20000;

  /* --------------------------------------------------------------- profile */

  /* Chinese first, English second. The English names are the ones their
     extraction API already uses, so a profile can be pasted together from what
     that API returns without being translated first. */
  var KEYS = {
    name:     ['名稱', 'name', 'label'],
    category: ['大類', '類別', 'category'],
    vendor:   ['廠商', '供應商', 'vendor'],
    columns:  ['欄位', '欄位順序', 'columns', 'export_columns'],
    required: ['必填', 'required', 'required_columns'],
    prompt:   ['提示詞', '萃取提示詞', 'prompt', 'extract_prompt'],
    rename:   ['命名', '命名規則', 'rename', 'rename_field'],
    deliver:  ['交付', '交付路徑', '歸檔', 'deliver', 'deliver_to'],
    finished: ['完成資料夾', 'finished_dir'],
    unsure:   ['待確認資料夾', 'undefined_dir'],
    note:     ['備註', 'note', 'description']
  };

  function pick(src, names) {
    for (var i = 0; i < names.length; i++) {
      if (src && Object.prototype.hasOwnProperty.call(src, names[i])) return src[names[i]];
    }
    return undefined;
  }

  function asText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return String(v);
  }

  function asList(v) {
    if (Array.isArray(v)) return v.map(asText).map(function (s) { return s.trim(); }).filter(Boolean);
    var text = asText(v).trim();
    if (!text) return [];
    // A single string of comma- or newline-separated names, which is how a
    // person pastes a column list out of a spreadsheet header.
    return text.split(/[,，\n\r\t]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function uniq(list) {
    var seen = Object.create(null);
    var out = [];
    list.forEach(function (x) {
      if (seen[x]) return;
      seen[x] = true;
      out.push(x);
    });
    return out;
  }

  /**
   * Read a profile, and say what is wrong with it rather than throwing.
   *
   * Returns `{ok, profile, errors, warnings}`. A profile with errors is still
   * returned, because a settings screen showing the broken thing next to the
   * complaint is more use than an empty screen and a message.
   */
  function parseProfile(input, vpath) {
    var errors = [];
    var warnings = [];
    var raw = input;

    if (typeof input === 'string') {
      try {
        raw = JSON.parse(input);
      } catch (e) {
        return {
          ok: false,
          profile: blankProfile(),
          errors: ['這個檔案不是有效的 JSON：' + (e.message || e)],
          warnings: []
        };
      }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, profile: blankProfile(), errors: ['設定檔要是一個 JSON 物件'], warnings: [] };
    }

    var columns = uniq(asList(pick(raw, KEYS.columns)));
    if (!columns.length) errors.push('沒有列出任何欄位（「欄位」）');
    if (columns.length > MAX_COLUMNS) {
      errors.push('欄位太多了（' + columns.length + ' 欄，上限 ' + MAX_COLUMNS + '）');
      columns = columns.slice(0, MAX_COLUMNS);
    }
    SOURCE_COLUMNS.forEach(function (c) {
      if (columns.indexOf(c) >= 0) {
        warnings.push('欄位「' + c + '」是系統自己要加的來源欄，已從你的欄位清單移除');
      }
    });
    columns = columns.filter(function (c) { return SOURCE_COLUMNS.indexOf(c) < 0; });

    var required = uniq(asList(pick(raw, KEYS.required)));
    var strays = required.filter(function (r) { return columns.indexOf(r) < 0; });
    if (strays.length) {
      errors.push('「必填」裡有不在欄位清單中的名稱：' + strays.join('、'));
    }

    var prompt = asText(pick(raw, KEYS.prompt)).trim();
    if (!prompt) errors.push('沒有萃取提示詞（「提示詞」），模型不會知道要抓什麼');

    var vendor = asText(pick(raw, KEYS.vendor)).trim();
    var category = asText(pick(raw, KEYS.category)).trim();
    var name = asText(pick(raw, KEYS.name)).trim() ||
      [category, vendor].filter(Boolean).join(' · ') ||
      (vpath ? baseName(vpath).replace(/\.json$/i, '') : '未命名設定');

    var deliver = asText(pick(raw, KEYS.deliver)).trim() || DELIVER_DEFAULT;
    if (deliver.charAt(0) !== '/') {
      errors.push('交付路徑要從 / 開始，例如 ' + DELIVER_DEFAULT);
    }

    var rename = asText(pick(raw, KEYS.rename)).trim();

    var profile = {
      vpath: vpath || '',
      name: name,
      category: category,
      vendor: vendor,
      columns: columns,
      required: required.filter(function (r) { return columns.indexOf(r) >= 0; }),
      prompt: prompt,
      rename: rename,
      deliver: deliver,
      finished: asText(pick(raw, KEYS.finished)).trim() || FINISHED,
      unsure: asText(pick(raw, KEYS.unsure)).trim() || UNSURE,
      note: asText(pick(raw, KEYS.note)).trim()
    };

    /* A rename template naming a field that is not a column can never resolve,
       and the failure would otherwise only show up at delivery time, one file at
       a time, as a file that would not file. */
    if (rename) {
      var unknown = templateFields(rename).filter(function (f) {
        return columns.indexOf(f) < 0 && !isBuiltinField(f);
      });
      if (unknown.length) {
        errors.push('命名規則用到不存在的欄位：' + unknown.map(function (u) { return '{' + u + '}'; }).join('、'));
      }
    }
    var unknownDeliver = templateFields(profile.deliver).filter(function (f) {
      return columns.indexOf(f) < 0 && !isBuiltinField(f);
    });
    if (unknownDeliver.length) {
      errors.push('交付路徑用到不存在的欄位：' + unknownDeliver.map(function (u) { return '{' + u + '}'; }).join('、'));
    }

    return { ok: !errors.length, profile: profile, errors: errors, warnings: warnings };
  }

  function blankProfile() {
    return {
      vpath: '', name: '', category: '', vendor: '',
      columns: [], required: [], prompt: '', rename: '',
      deliver: DELIVER_DEFAULT, finished: FINISHED, unsure: UNSURE, note: ''
    };
  }

  /** A starting point for someone making their first profile, with the shape shown. */
  function profileTemplate(category, vendor) {
    return {
      名稱: [category, vendor].filter(Boolean).join(' · ') || '新的萃取設定',
      大類: category || '進貨單',
      廠商: vendor || '某某公司',
      欄位: ['單號', '日期', '料號', '品名', '數量', '單價', '金額'],
      必填: ['單號', '料號', '數量'],
      提示詞: '請閱讀這份文件，逐列抓出明細。\n' +
        '（把提示詞微調工作室產生的萃取提示詞貼在這裡。）',
      命名: '{廠商}-{單號}-{日期}',
      交付: DELIVER_DEFAULT,
      備註: ''
    };
  }

  /* ---------------------------------------------------------------- prompt */

  /**
   * The prompt that goes with the document.
   *
   * The vendor's own prompt comes first and is not touched -- it was tuned
   * against real pages and rewriting it would throw that away. What is appended
   * is the contract about the *shape* of the answer, which the vendor's prompt
   * has no reason to carry and which every vendor needs identically.
   */
  function promptFor(profile) {
    var p = profile || blankProfile();
    var cols = p.columns || [];
    var lines = [];
    lines.push(p.prompt);
    lines.push('');
    lines.push('---');
    lines.push('回答的格式規定（以下規定優先於上面任何關於輸出格式的說明）：');
    lines.push('1. 只輸出 JSON，不要有說明文字，不要有程式碼圍欄。');
    lines.push('2. 形狀是 {"rows": [ … ]}，每一筆明細是 rows 裡的一個物件。');
    lines.push('3. 每個物件的鍵剛好是這些，一個不多一個不少：');
    cols.forEach(function (c) { lines.push('   - ' + c); });
    lines.push('4. 所有的值都是字串，照文件上印的原樣抄，不要換算、不要補零也不要去掉前導零。' +
      '料號 0012345 就是 "0012345"，爐號 0800 就是 "0800"。');
    lines.push('5. 文件上沒有的欄位就填空字串 ""，不要猜、不要用別欄的值代替。');
    lines.push('6. 不要輸出小計列、合計列、頁尾或表頭；只要明細列。');
    if ((p.required || []).length) {
      lines.push('7. 這幾欄在文件上通常找得到，請特別確認：' + p.required.join('、') + '。');
    }
    return lines.join('\n');
  }

  /* -------------------------------------------------------------- the rows */

  /**
   * Square the model's answer up against the columns that were asked for.
   *
   * The model is told the exact key list and usually obeys, but "usually" is not
   * a thing to build a spreadsheet on. Every row is rebuilt in column order with
   * missing keys as empty strings and unexpected keys dropped, so the table has
   * the same shape whatever came back. Dropped keys are reported rather than
   * discarded silently -- a vendor whose documents carry a field the profile
   * does not list is a profile that needs a new column, and nobody will find
   * that out if the data quietly disappears.
   */
  function normalise(rows, profile, meta) {
    var p = profile || blankProfile();
    var cols = p.columns || [];
    var m = meta || {};
    var out = [];
    var extras = Object.create(null);
    var startAt = Number(m.startAt) > 0 ? Number(m.startAt) : 1;

    (Array.isArray(rows) ? rows : []).forEach(function (raw, i) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      if (out.length >= MAX_ROWS) return;

      var row = {};
      cols.forEach(function (c) { row[c] = asText(raw[c]).trim(); });
      Object.keys(raw).forEach(function (k) {
        if (cols.indexOf(k) < 0 && SOURCE_COLUMNS.indexOf(k) < 0) extras[k] = true;
      });

      /* A row where every asked-for column came back empty is not a row. Models
         do produce these at the end of a table, and one blank line in the middle
         of a delivery note becomes a blank line in the spreadsheet nobody can
         explain. */
      var anything = cols.some(function (c) { return row[c] !== ''; });
      if (!anything) return;

      row[SOURCE_COLUMNS[0]] = asText(m.filename);
      row[SOURCE_COLUMNS[1]] = asText(m.vendor || p.vendor);
      row[SOURCE_COLUMNS[2]] = String(startAt + out.length);
      out.push(row);
    });

    return { rows: out, dropped: Object.keys(extras) };
  }

  /** The full header, the profile's columns followed by the provenance ones. */
  function headerOf(profile) {
    return (profile && profile.columns ? profile.columns : []).concat(SOURCE_COLUMNS);
  }

  /**
   * Which required cells are empty.
   *
   * Reported per cell rather than per row, because the point is to steer someone
   * to the box they have to fill, and a count of bad rows does not do that.
   */
  function requiredBlanks(rows, profile) {
    var p = profile || blankProfile();
    var req = p.required || [];
    var out = [];
    (rows || []).forEach(function (row, i) {
      req.forEach(function (c) {
        if (asText(row[c]).trim() === '') out.push({ row: i, column: c, file: asText(row[SOURCE_COLUMNS[0]]) });
      });
    });
    return out;
  }

  /** The files that still have a required blank in them. */
  function filesWithBlanks(rows, profile) {
    var bad = Object.create(null);
    requiredBlanks(rows, profile).forEach(function (b) { bad[b.file] = true; });
    return Object.keys(bad);
  }

  /* ------------------------------------------------------------- templates */

  var FIELD_RE = /\{([^{}]+)\}/g;

  /* Fields every profile gets for free, whatever its columns are. */
  var BUILTIN = ['大類', '廠商', '今日', '年', '月', '日', '年月', '檔名', '原檔名'];

  function isBuiltinField(name) { return BUILTIN.indexOf(name) >= 0; }

  /** The placeholder names a template uses, in order, deduplicated. */
  function templateFields(tpl) {
    var out = [];
    var text = asText(tpl);
    var m;
    FIELD_RE.lastIndex = 0;
    while ((m = FIELD_RE.exec(text))) {
      var name = m[1].trim();
      if (name && out.indexOf(name) < 0) out.push(name);
    }
    return out;
  }

  /** Two digits, because a month sorts as text in a folder listing. */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /**
   * The values a template can draw on: the date, the profile, and the row.
   *
   * `at` is passed in rather than read from the clock so that a batch filed
   * across midnight lands in one folder, and so this is testable.
   */
  function fieldsFor(profile, row, at, filename) {
    var p = profile || blankProfile();
    var d = at instanceof Date ? at : new Date(at || 0);
    var y = d.getFullYear();
    var mo = pad2(d.getMonth() + 1);
    var da = pad2(d.getDate());
    var f = {
      '大類': p.category,
      '廠商': p.vendor,
      '今日': y + '-' + mo + '-' + da,
      '年': String(y),
      '月': mo,
      '日': da,
      '年月': y + '-' + mo,
      '檔名': stripExt(asText(filename)),
      '原檔名': asText(filename)
    };
    if (row) {
      (p.columns || []).forEach(function (c) {
        if (!Object.prototype.hasOwnProperty.call(f, c)) f[c] = asText(row[c]).trim();
      });
    }
    return f;
  }

  /**
   * Fill a template, and say which placeholders had nothing to fill them.
   *
   * An unresolved placeholder becomes empty rather than staying literal: a
   * folder actually named `{單號}` is worse than a missing one, because it looks
   * deliberate. The caller decides what to do about `missing`.
   */
  function fillTemplate(tpl, fields) {
    var missing = [];
    var text = asText(tpl).replace(FIELD_RE, function (whole, nameRaw) {
      var name = nameRaw.trim();
      var v = fields && Object.prototype.hasOwnProperty.call(fields, name) ? asText(fields[name]).trim() : '';
      if (!v) { if (missing.indexOf(name) < 0) missing.push(name); return ''; }
      return v;
    });
    return { text: text, missing: missing };
  }

  /* ---------------------------------------------------------------- naming */

  /* Reserved on Windows, whatever extension follows. A file called CON.pdf
     cannot be created, and the failure arrives as a permission error that tells
     nobody why. */
  var RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

  function baseName(vpath) { return asText(vpath).split('/').pop(); }

  function stripExt(name) { return asText(name).replace(/\.[^.\/]+$/, ''); }

  function extOf(name) {
    var m = /(\.[^.\/]+)$/.exec(asText(name));
    return m ? m[1] : '';
  }

  /**
   * One path segment that a filesystem will actually accept.
   *
   * The characters removed are the ones Windows refuses plus the separator,
   * because a vendor name with a slash in it would otherwise silently become two
   * folders. Trailing dots and spaces go for the same reason: Windows drops them
   * on creation, so a name ending in one never matches itself again.
   */
  function safeSegment(text, fallback) {
    var s = asText(text)
      .replace(/[\\/:*?"<>|]/g, '')
      /* Control characters, written as escapes rather than typed: a literal
         one is invisible to the next reader, and there is a test that refuses
         any source file carrying one. */
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 80)
      .trim();
    /* The underscore goes before the extension, not after the whole name.
       Windows decides a name is a device by what comes before the first dot, so
       `nul.pdf_` is every bit as unusable as `nul.pdf` -- it has to be
       `nul_.pdf`. Appending to the end looks like it works and does not. */
    if (RESERVED.test(stripExt(s))) s = stripExt(s) + '_' + extOf(s);
    return s || asText(fallback) || '未命名';
  }

  /** A sandbox path from segments, with every segment made safe. */
  function joinPath(base, segments) {
    var parts = asText(base).split('/').filter(Boolean).map(function (s) { return safeSegment(s, 's'); });
    (segments || []).forEach(function (s) {
      var seg = safeSegment(s, '');
      if (seg) parts.push(seg);
    });
    return '/' + parts.join('/');
  }

  /* -------------------------------------------------------------- delivery */

  /**
   * What filing this batch would do, before anything is moved.
   *
   * One entry per source document: where it is, where it would go, which bin,
   * and why. Nothing here touches the filesystem -- the plan is shown to a person
   * first, and the gate is asked about the whole list at once, because fifty
   * separate consent dialogs is the thing consent dialogs are supposed to
   * prevent.
   *
   * `files` is `[{path, rows}]` or plain paths with `rows` supplied separately;
   * both forms happen, one from a fresh parse and one from a reopened result.
   */
  function planDelivery(opts) {
    var o = opts || {};
    var p = o.profile || blankProfile();
    var at = o.at || new Date();
    var rows = Array.isArray(o.rows) ? o.rows : [];
    var move = o.move !== false;

    var byFile = Object.create(null);
    rows.forEach(function (r) {
      var f = asText(r[SOURCE_COLUMNS[0]]);
      if (!byFile[f]) byFile[f] = [];
      byFile[f].push(r);
    });

    var files = (o.files || []).map(function (f) {
      return typeof f === 'string' ? { path: f } : f;
    }).filter(function (f) { return f && f.path; });

    var blanksBy = Object.create(null);
    requiredBlanks(rows, p).forEach(function (b) {
      if (!blanksBy[b.file]) blanksBy[b.file] = [];
      if (blanksBy[b.file].indexOf(b.column) < 0) blanksBy[b.file].push(b.column);
    });

    var taken = Object.create(null);
    var plan = files.map(function (f) {
      var name = baseName(f.path);
      var mine = byFile[name] || [];
      var status = 'finished';
      var reason = '';

      if (!mine.length) {
        status = 'unsure';
        reason = '沒有萃取到任何資料';
      } else if (blanksBy[name] && blanksBy[name].length) {
        status = 'unsure';
        reason = '必填欄位還是空的：' + blanksBy[name].join('、');
      }

      var first = mine[0] || null;
      var fields = fieldsFor(p, first, at, name);
      var dir = fillTemplate(p.deliver || DELIVER_DEFAULT, fields);
      if (dir.missing.length && status === 'finished') {
        status = 'unsure';
        reason = '交付路徑要用的欄位是空的：' + dir.missing.join('、');
      }

      var newName = name;
      if (p.rename) {
        var built = fillTemplate(p.rename, fields);
        if (built.missing.length && status === 'finished') {
          status = 'unsure';
          reason = '命名規則要用的欄位是空的：' + built.missing.join('、');
        }
        if (built.text.trim()) newName = safeSegment(built.text, stripExt(name)) + (extOf(name) || '.pdf');
      }

      var bin = status === 'finished' ? (p.finished || FINISHED) : (p.unsure || UNSURE);
      var target = joinPath(dir.text || DELIVER_DEFAULT, [bin, newName]);

      /* Two documents that rename to the same thing. Numbering rather than
         refusing, because the usual cause is two pages of one delivery -- and
         refusing would strand both. Said out loud so nobody assumes -2 was
         theirs by design. */
      if (taken[target.toLowerCase()]) {
        var n = 2;
        var stem = target.replace(/(\.[^.\/]+)$/, '');
        var ext = extOf(target);
        while (taken[(stem + '-' + n + ext).toLowerCase()]) n++;
        target = stem + '-' + n + ext;
        reason = reason || ('檔名和另一份文件重複，加了 -' + n);
      }
      taken[target.toLowerCase()] = true;

      return {
        from: f.path,
        name: name,
        to: target,
        dir: target.slice(0, target.lastIndexOf('/')),
        newName: target.split('/').pop(),
        status: status,
        rows: mine.length,
        reason: reason,
        move: move
      };
    });

    var dirs = uniq(plan.map(function (e) { return e.dir; }));
    return {
      plan: plan,
      dirs: dirs,
      finished: plan.filter(function (e) { return e.status === 'finished'; }).length,
      unsure: plan.filter(function (e) { return e.status !== 'finished'; }).length,
      renamed: plan.filter(function (e) { return e.newName !== e.name; }).length
    };
  }

  /* ------------------------------------------------------------ the export */

  function colName(i) {
    var s = '';
    var n = i;
    do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
  }

  /**
   * The rows as spreadsheet cells.
   *
   * Every data cell carries the text format. Not a default that a later edit
   * could change -- written into the cell -- because the leading zero is the
   * whole point and a spreadsheet that helpfully reformats one column has
   * destroyed the document's meaning without saying so.
   *
   * The header is the blue their own exporter uses, so the file a person opens
   * here looks like the file they are used to.
   */
  function toCells(rows, profile) {
    var header = headerOf(profile);
    var cells = {};
    header.forEach(function (name, c) {
      cells[colName(c) + '1'] = {
        v: name, bold: true, bg: 'DDEBF7', align: 'center',
        border: { top: 'thin', bottom: 'thin', left: 'thin', right: 'thin' }
      };
    });
    (rows || []).forEach(function (row, r) {
      header.forEach(function (name, c) {
        cells[colName(c) + String(r + 2)] = { v: asText(row[name]), numFmt: '@' };
      });
    });
    return cells;
  }

  /** Column widths that make the first look at a result readable. */
  function colWidths(rows, profile) {
    var header = headerOf(profile);
    var widths = {};
    header.forEach(function (name, c) {
      var w = displayWidth(name) + 2;
      (rows || []).slice(0, 200).forEach(function (row) {
        var d = displayWidth(asText(row[name]));
        if (d > w) w = d;
      });
      widths[c] = Math.min(Math.max(Math.round(w * 8) + 10, 60), 320);
    });
    return widths;
  }

  /* A CJK character occupies two columns of a monospaced cell, which is what
     the width estimate has to count -- a header of four Chinese characters is
     as wide as eight Latin ones. */
  function displayWidth(text) {
    var s = asText(text);
    var w = 0;
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      w += (code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6))) ? 2 : 1;
    }
    return w;
  }

  /** A spreadsheet-ready book: one sheet, header frozen, text everywhere. */
  function workbook(rows, profile) {
    var p = profile || blankProfile();
    return {
      name: safeSegment(p.name || '萃取結果', '萃取結果').slice(0, 31),
      cells: toCells(rows, p),
      colWidths: colWidths(rows, p),
      freeze: { rows: 1, cols: 0 }
    };
  }

  /** `{大類}_{廠商}_{今日}.xlsx`, the way their exporter names things. */
  function exportName(profile, at) {
    var p = profile || blankProfile();
    var f = fieldsFor(p, null, at || new Date(), '');
    var parts = [p.category, p.vendor, f['今日']].map(function (s) { return asText(s).trim(); }).filter(Boolean);
    return safeSegment(parts.join('_'), '萃取結果') + '.xlsx';
  }

  /* ------------------------------------------------------------- reporting */

  /**
   * What the model outside this window is told about what is in it.
   *
   * Counts and column names, never the cell values: the rows came out of a
   * document this session has already marked untrusted, and copying them into
   * the kernel's context would be handing that document a second microphone.
   */
  function describe(view) {
    var v = view || {};
    var p = v.profile || blankProfile();
    var rows = v.rows || [];
    var lines = [];
    lines.push('文件萃取');
    lines.push('設定：' + (p.name || '（未選）') +
      (p.vendor ? '　廠商：' + p.vendor : '') +
      (p.category ? '　大類：' + p.category : ''));
    lines.push('欄位：' + (p.columns || []).join('、'));
    if ((p.required || []).length) lines.push('必填：' + p.required.join('、'));
    lines.push('文件：' + (v.files || []).length + ' 份　已萃取 ' + rows.length + ' 列');
    var blanks = requiredBlanks(rows, p);
    if (blanks.length) {
      lines.push('必填未填：' + blanks.length + ' 格，分布在 ' + filesWithBlanks(rows, p).length + ' 份文件');
    } else if (rows.length) {
      lines.push('必填欄位都填齊了');
    }
    if (v.deliverTo) lines.push('交付目的地：' + v.deliverTo);
    lines.push('');
    lines.push('（資料內容不放進這裡：它來自不可信的文件，摘要只報數量與欄位名稱。）');
    return lines.join('\n');
  }

  return {
    PROFILE_DIR: PROFILE_DIR,
    PROFILE_EXT: PROFILE_EXT,
    DELIVER_DEFAULT: DELIVER_DEFAULT,
    FINISHED: FINISHED,
    UNSURE: UNSURE,
    SOURCE_COLUMNS: SOURCE_COLUMNS,
    MAX_COLUMNS: MAX_COLUMNS,
    MAX_ROWS: MAX_ROWS,
    BUILTIN: BUILTIN,

    parseProfile: parseProfile,
    blankProfile: blankProfile,
    profileTemplate: profileTemplate,
    promptFor: promptFor,

    normalise: normalise,
    headerOf: headerOf,
    requiredBlanks: requiredBlanks,
    filesWithBlanks: filesWithBlanks,

    templateFields: templateFields,
    fieldsFor: fieldsFor,
    fillTemplate: fillTemplate,
    isBuiltinField: isBuiltinField,

    safeSegment: safeSegment,
    joinPath: joinPath,
    baseName: baseName,
    stripExt: stripExt,
    extOf: extOf,

    planDelivery: planDelivery,

    toCells: toCells,
    colWidths: colWidths,
    displayWidth: displayWidth,
    workbook: workbook,
    exportName: exportName,

    describe: describe,
    asText: asText,
    asList: asList
  };
}));
