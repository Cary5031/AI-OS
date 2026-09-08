# Semantic extraction for the 4 non-code files, written to the chunk file the
# graphify skill's Part C merge expects. Node IDs follow the AST convention:
# full repo-relative path, extension dropped, segments joined with "_".
import json
from pathlib import Path

README = r'D:\WorkSpace\AI-OS\README.md'
INDEX = r'D:\WorkSpace\AI-OS\app\renderer\index.html'
CONSENT = r'D:\WorkSpace\AI-OS\app\renderer\consent.html'
PDFVIEW = r'D:\WorkSpace\AI-OS\app\renderer\pdfview.html'

nodes = []
edges = []


FILES = {'index.html': INDEX, 'consent.html': CONSENT, 'pdfview.html': PDFVIEW}

# Anchors: a line range is a claim about where something is, and a line range is
# the most rot-prone claim in this whole file -- every edit above a marked block
# moves it, silently, and the graph then points confidently at the wrong lines.
# Measured: after one edit `授權刻意不在這份文件裡呈現` pointed at a dock button and
# `renderer 腳本相依順序` pointed at the drop-zone overlay. Both looked fine.
#
# So each located node names a string that must appear inside the range it
# claims. If the block moves, the build stops and says which one, instead of
# publishing a wrong address.
ANCHORS = {
    'app_renderer_index_csp': 'Content-Security-Policy',
    'app_renderer_index_frame_src': 'frame-src',
    'app_renderer_index_script_order': 'Classic scripts, loaded in dependency order',
    'app_renderer_index_dock': 'DOCK',
    'app_renderer_index_hud_left': 'HUD: left',
    'app_renderer_index_hud_right': 'HUD: right',
    'app_renderer_index_intent_bar': 'INTENT BAR',
    'app_renderer_index_boot_sequence': 'class="boot"',
    'app_renderer_index_no_consent_here': 'Consent is not rendered here',
    'app_renderer_consent_narrow_bridge': 'consent-view.js',
    'app_renderer_consent_csp': 'Content-Security-Policy',
    'app_renderer_pdfview_isolation': 'PDF viewer document',
    'app_renderer_pdfview_textlayer': 'textLayer',
    'app_renderer_pdfview_print_images': 'printing',
}

located = []


def check_locations():
    """Verify every claimed line range still holds what it claims."""
    bad = []
    for nid, loc in located:
        fname, rng = loc.split(':')
        parts = rng.split('-')
        a = int(parts[0])
        b = int(parts[1]) if len(parts) > 1 else a
        lines = Path(FILES[fname]).read_text(encoding='utf-8').splitlines()
        if b > len(lines):
            bad.append(f'{nid}: {loc} 超出檔案（只有 {len(lines)} 行）')
            continue
        text = '\n'.join(lines[a - 1:b])
        anchor = ANCHORS.get(nid)
        if anchor is None:
            bad.append(f'{nid}: 有行號卻沒有 anchor，無法驗證')
        elif anchor not in text:
            bad.append(f'{nid}: {loc} 裡找不到「{anchor}」——那個區塊搬走了')
    if bad:
        raise SystemExit('位置宣稱對不上程式碼：\n  ' + '\n  '.join(bad))
    print(f'locations verified: {len(located)}')


def n(nid, label, src, ftype='rationale', rationale=None, loc=None):
    node = {
        'id': nid, 'label': label, 'file_type': ftype, 'source_file': src,
        'source_location': loc, 'source_url': None, 'captured_at': None,
        'author': None, 'contributor': None,
    }
    if rationale:
        node['rationale'] = rationale
    nodes.append(node)
    if loc and ':' in loc and loc.split(':')[0] in FILES:
        located.append((nid, loc))


def e(s, t, rel, conf, score, src, loc=None):
    edges.append({
        'source': s, 'target': t, 'relation': rel, 'confidence': conf,
        'confidence_score': score, 'source_file': src,
        'source_location': loc, 'weight': 1.0,
    })


# ---------------------------------------------------------------- documents --
n('readme_ai_os', 'AI-OS README', README, 'document',
  '整份設計文件：每個決定都寫出理由與實測數字，而不只是描述行為。')
n('app_renderer_index_shell_document', 'shell 文件 index.html', INDEX, 'document')
n('app_renderer_consent_dialog_document', '授權視窗文件 consent.html', CONSENT, 'document')
n('app_renderer_pdfview_viewer_document', 'PDF 檢視器文件 pdfview.html', PDFVIEW, 'document')

# ------------------------------------------------------------ kernel & gate --
n('readme_intent_kernel', '意圖核心', README, 'rationale',
  '自然語言翻成計畫而不是散文；約束強度依供應商能力決定。')
n('readme_syscall_table', '26 個系統呼叫（OPS 表）', README, 'rationale',
  'gate.js 的 OPS 是唯一定義，renderer 開機時抓它組 prompt，'
  '所以「模型知道的能力」與「閘門認得的能力」不可能不同步。')
n('readme_internal_ops', 'INTERNAL_OPS（app.run、session.write）', README, 'rationale',
  '同樣過閘門，但不出現在 prompt 裡，模型無法指名呼叫。')
n('readme_capability_gate', '能力閘門', README, 'rationale',
  '十四個能力各有 allow / ask / deny，政策存在沙箱外的 policy.json。')
n('readme_elevated_capabilities', 'ELEVATED 能力', README, 'rationale',
  '會摧毀資料、送資料出機器、或引入新程式碼的六個能力。')
n('readme_taint_downgrade', '汙染降級', README, 'rationale',
  '惡意文字一旦進了對話就能影響之後每一輪，而 renderer 沒有資格宣告它已經不在了；'
  '所以汙染是黏著的，只有明確的使用者動作能清除。')
n('readme_consent_window', '授權視窗（主程序 modal）', README, 'rationale',
  'renderer 遲早要渲染不可信資料；在 renderer 裡判定授權，等於讓被攻陷的 renderer 自己核准自己。')
n('readme_consent_race_fix', '遲到的 closed 事件競態', README, 'rationale',
  '原本會結掉下一個 pending 請求，把沒人碰過的請求回報成「使用者拒絕」——'
  '這正是 App Forge 安裝一直失敗的原因。現在每個 pending 綁定自己的視窗。')
n('readme_main_process_boundary', '主程序邊界（四件事 renderer 拿不到）', README, 'rationale',
  '政策表、授權視窗、汙染集、模型位址與金鑰，全部留在主程序。')
n('readme_validate_before_asking', '先驗證路徑再問使用者', README, 'rationale',
  '不為註定失敗的操作騷擾人：逃逸路徑直接回 EESCAPE，不彈授權視窗。')

# ------------------------------------------------------------------ sandbox --
n('readme_sandbox_filesystem', '沙箱檔案系統', README, 'rationale')
n('readme_sandbox_invariants', '沙箱三條不變量', README, 'rationale',
  '只有一個寫入原語且只吃虛擬路徑；唯一讀沙箱外的 importFiles() 由手勢驅動且永遠是複製；'
  '刪除是搬進回收桶，所以「復原」是真的還原。')
n('readme_windows_path_traps', 'Windows 路徑陷阱', README, 'rationale',
  '磁碟相對路徑、UNC、\\\\?\\、保留裝置名、交替資料流、結尾點與空白、symlink 全部拒絕；'
  '測試列了 21 種逃逸手法。')
n('readme_sandbox_quota', '沙箱配額', README, 'rationale',
  '回收桶不出現在給模型的檔案樹（不可尋址的路徑列出來只會誘發失敗呼叫），但照算配額。')
n('readme_seed_injection_demo', '種子 prompt injection 假請款單', README, 'rationale',
  'inbox/urgent-invoice.txt 讓人親眼看到汙染降級如何作用。')
n('readme_config_outside_sandbox', '設定刻意放在沙箱外', README, 'rationale',
  '讓「能寫沙箱檔案」不等於「能改政策、能改記憶、能安裝程式」。')

# --------------------------------------------------------- model providers ---
n('readme_model_provider', '核心模型供應商', README, 'rationale',
  '只能跑一個 gguf、一張顯卡的機器是展示品，所以核心是一個可替換的供應商。')
n('readme_transport_in_main_process', '模型傳輸在主程序', README, 'rationale',
  'index.html 的 connect-src 只允許本機；為了打到 api.openai.com 而放寬它，'
  '等於用一道真的邊界換一點方便。搬進主程序順帶讓 API 金鑰從來不進 renderer。')
n('readme_provider_described_not_branched', '供應商是被描述的，不是被 if 判斷的', README, 'rationale',
  '每個供應商帶的是事實（有無 tokenizer、吃不吃 chat_template_kwargs、JSON 約束強度）；'
  'if (provider === ...) 散在傳輸層裡，就是第五個供應商變成重寫的原因。')
n('readme_model_list_probe', '模型清單是問來的', README, 'rationale',
  '打錯一個字得到的是 404 而不是提示。金鑰欄放在模型欄上面不是排版偏好：'
  '「填完金鑰」正是清單問得到的觸發點。清單一定留「自己輸入…」這條逃生路。')
n('readme_thinking_ladder', '思考模式：一道階梯', README, 'rationale',
  '一家一個控制項等於沒有人學得會任何一個。往低的方向對應，因為花掉比要求更多的思考，'
  '是花使用者沒有同意的錢；而且對應結果會寫在畫面上。')
n('readme_none_not_rounded', 'NONE 不是拿來四捨五入的等級', README, 'rationale',
  'DeepSeek 的 effort 從 high 起跳，把 NONE 丟給「找最近一級」會得到 HIGH——'
  '使用者要「不要思考」，拿到「想到最深」，還是貴的那一邊。')
n('readme_output_cap_provider_owned', '輸出上限是供應商的設定', README, 'rationale',
  '思考與回覆共用同一個輸出上限。「這個模型需要多少空間」是關於模型的事實，'
  '不是關於問題的事實，所以它屬於供應商而不是呼叫端；0 表示交給呼叫端決定。')
n('readme_rejected_field_dropping', '被拒絕的欄位自動拿掉', README, 'rationale',
  '哪個模型接受哪些參數既不穩定也看不出來，「每家一張固定表」在一個下午內過期了兩次。'
  '只動可選欄位，且這個記錄不落盤——過期的快取會永遠把那個欄位壓著。')
n('readme_no_tokenizer_disclosure', '沒有 tokenizer 就說沒有', README, 'rationale',
  '一個把估算當測量顯示的 HUD，會是這台機器上唯一不誠實的數字。')
n('readme_handshake_vs_boot', '握手失敗不等於開機失敗', README, 'rationale',
  '修設定的那個視窗就在開不起來的那個 shell 裡。')
n('readme_key_storage_blob', '金鑰以 safeStorage 加密成一個 blob', README, 'rationale',
  '加密金鑰卻明文寫著 X-Api-Key: sk-… 是安全劇場，所以整個設定一起加密。'
  '橋接層刻意沒有讀回金鑰的方法，因此空白欄位一律是「不要動」而不是「清空」。')
n('readme_remote_kernel_cost_banner', '雲端核心的代價要講清楚', README, 'rationale',
  '刻意不做成能力閘門：model:chat 每輪都跳同意視窗等於沒有人會讀那個視窗。'
  '真正的決定在選供應商的那一刻做一次。')
n('readme_cloud_wire_format', '雲端回傳格式：實測不是照文件猜', README, 'rationale',
  'json_object 不是絕對的；散文與「有動作沒說明」對 {say, action} 都是真的答案，'
  '但計畫不吃這一套。解析失敗會把收到的文字印出來——那一輪是付過錢的。')

# ---------------------------------------------------------------- app forge --
n('readme_app_forge', 'App Forge', README, 'rationale',
  '四步流程：規劃規格、產生程式碼、檢查、安裝。')
n('readme_forge_parse_first', '第 3 步先問「這是 JavaScript 嗎」', README, 'rationale',
  '規則檢查是文字比對，會愉快放過永遠跑不起來的程式。通過檢查然後不會動，'
  '是失敗最糟的一種形狀。解析在主程序用 vm.Script 只編譯不執行。')
n('readme_forge_iframe_sandbox', '生成程式跑在 opaque origin 的 iframe', README, 'rationale',
  '沒有 allow-same-origin，所以拿不到 parent.document、localStorage、cookie，fetch 被 CSP 擋掉。')
n('readme_forge_capability_broker', 'postMessage 能力 broker', README, 'rationale',
  '沒宣告的能力 manifest 寫了也不算；window.aios 從來不會交給生成的程式。')
n('readme_forge_integrity_hash', '完整性：能寫檔案 ≠ 能安裝程式', README, 'rationale',
  '這是偵測而不是阻止，這才是誠實的說法。fs.write 是一個你很可能設成 ALLOW 的能力，'
  '如果「程式碼躺在磁碟上」就足以讓它被執行，任何能寫檔案的東西都能裝會跑的程式碼。')
n('readme_forge_gesture_channel', '建置按鈕走 installByGesture', README, 'rationale',
  '問使用者要不要批准他三秒前才下的指令，只會訓練人閉著眼睛按確定；'
  '但沒有把 app.create 改成 allow，因為讀過惡意郵件的模型能無聲裝程式。'
  '少報能力換不到免彈窗的好處，因為那份清單就是 manifest。')
n('readme_gesture_sentinel', '手勢憑證是哨兵物件不是布林值', README, 'rationale',
  'create() 同時是這個程式的 api，一個 true 旗標會讓兩條路只差一個誤傳的引數。')
n('readme_aios_app_scheme', 'aios-app:// scheme', README, 'rationale',
  'srcdoc 文件會繼承父文件的 CSP，於是生成程式的 inline bootstrap 全被擋，'
  '而且連回報錯誤的那段也沒跑——壞得無聲無息。HTML 只放記憶體、隨機 token 當 key。')
n('readme_os_calc', 'os.calc：禁止 eval 之後留一條路', README, 'rationale',
  '只擋不給替代方案，禁令就變成死路：實測它用 eval 被擋、改 new Function 又被擋，整個生成失敗。')
n('readme_forge_layout_color_rules', '版面與配色寫成可照做的規則', README, 'rationale',
  '一個功能正確但讀不清楚的程式沒有做完，而這兩件事沒辦法靠靜態檢查驗證。')
n('readme_on_fill_variable', '--on-fill 主題變數', README, 'rationale',
  '一個顏色該配白字還是黑字，答案取決於主題而不是取決於那個顏色，所以規則變成機械式的一行。')

# ------------------------------------------------------------------ context --
n('readme_attention_scheduler', '注意力排程器', README, 'rationale',
  '這一層管理的稀缺資源不是 CPU 時間，而是 context window。')
n('readme_chatpane_context', '面板的上下文脈絡', README, 'rationale',
  '會忘記的面板等於每講一句話都要重新交代背景。用 token 量而不是數訊息，'
  '因為一句「好」跟一份六千字傾印不是同一個量的記憶。')
n('readme_whole_turn_eviction', '整輪整輪捨棄', README, 'rationale',
  '半輪比沒有更糟：問題留著答案被丟掉，模型會再答一次；收據留著請求被丟掉，'
  '那就是一件沒有理由的事。最新的一輪永遠不丟。')
n('readme_receipts_carry_args', '動作收據帶著參數', README, 'rationale',
  '沒有參數的話，「把它改成藍色」裡的「它」指不到任何東西。')
n('readme_state_not_in_context', '狀態不進脈絡，每輪重新產生', README, 'rationale',
  '記住一份早就改掉的文件描述，比不記得更糟。')
n('readme_long_term_memory', '長期記憶', README, 'rationale',
  '存在沙箱外的 memory.json：一個模型能悄悄編輯的記憶庫，'
  '就是一個能被使用者拖進來的檔案汙染的記憶庫。')
n('readme_no_seeded_memory', '完全不預載任何種子', README, 'rationale',
  '在一台聲稱記得你的機器上，開機就編出關於你的「事實」是不誠實的。')

# ---------------------------------------------------------------- lifecycle --
n('readme_shutdown_ritual', '關機儀式', README, 'rationale',
  '回收必須是同步的：非同步 spawn taskkill 會輸掉競速，一個 8.9 GB 的模型會繼續佔著顯存。')
n('readme_session_restore', '工作階段還原', README, 'rationale',
  '每 60 秒自動存一次，崩潰的代價是幾秒鐘而不是一個工作階段。')
n('readme_unsaved_close_prompt', '關閉前會問（三顆按鈕）', README, 'rationale',
  '會發生的事有三件，折成 yes/no 一定會少掉一件。存檔失敗就不關窗：'
  'fs.write 被拒卻把視窗關掉，等於丟掉工作還回報成功。')
n('readme_forced_close_needs_snapshot', '強制關窗的前提是快照帶著未存內容', README, 'rationale',
  '編輯器原本只存分頁路徑，還原時會靜靜蓋掉你沒存的那份。')

# -------------------------------------------------------------- shared libs --
n('readme_formula_engine', '公式引擎（tokenizer + parser）', README, 'rationale',
  '不是 regex 替換加 eval：CSP 已經禁掉 eval，而且模型會往格子裡寫東西——'
  '一個把儲存格內容丟給 eval 的試算表，等於把 prompt injection 升級成任意程式碼執行。')
n('readme_formula_omissions', '刻意不做的函式', README, 'rationale',
  'INDIRECT / OFFSET 回傳參照，靜態相依圖分析不了，做出來會是壞的。')
n('readme_merged_cells', '合併儲存格（存矩形清單）', README, 'rationale',
  '矩形就是人操作的單位，而兩種 OOXML 存的也是矩形，往返因此是翻譯而不是推論。')
n('readme_merge_invariant', '選取範圍永不只含半個合併區', README, 'rationale',
  '這條不變式讓樣式、排序、複製、Delete 全部不必知道合併存在。')
n('readme_grid_algebra', 'AIOS.grid 矩形代數', README, 'rationale',
  '純函式、不碰 DOM 也不持有狀態，所以合併跟其他編輯一樣被同一套快照機制復原。')
n('readme_cell_picker', 'AIOS.cellPicker 範圍拖選', README, 'rationale',
  '按下的那一刻刻意不 preventDefault——那正是會把游標拿掉的動作；'
  'dragstart 一律取消，因為原生拖放一開始就會發出 pointercancel。')
n('readme_shared_borders', 'AIOS.borders 框線與網底', README, 'rationale',
  '畫筆是共用的 session 狀態，這是 Word 的行為；做成各自一支，'
  '等於要讓兩張表看起來一樣就得設定三次。')
n('readme_three_edge_states', '一條邊有三種狀態', README, 'rationale',
  '把「明確不畫」與「沒有意見」合成一種，就得在「加下框線不擦掉其他線」跟'
  '「無框線真的拿掉線」之間選一個，不管選哪個都有一半的時候是錯的。')
n('readme_palette', 'AIOS.palette 文件配色', README, 'rationale',
  'readableOn() 的兩個墨色交叉點在相對亮度 0.184；wiring.test.js 對整份色盤算 WCAG 對比。')
n('readme_images_pipeline', 'AIOS.images 圖片管線', README, 'rationale',
  '文件是 file://、沙箱沒有自己的 scheme、CSP 只允許 img-src self data:，'
  '所以「讀出位元組再轉 data URL」不是繞路，就是路。刻意不支援 SVG。')
n('readme_popover', 'AIOS.popover 共用面板', README, 'rationale',
  '位置必須在插進 DOM 之後才算：還沒掛上的元素 offsetWidth 是 0，量了會把面板丟到角落。')
n('readme_context_menu', '右鍵選單', README, 'rationale',
  '原本在可編輯元素上直接跳出、交給「平台選單」，但主行程從來沒有實作 context-menu，'
  '所以在表格格子裡按右鍵什麼都不會出現。開選單時要把選取範圍複製下來，執行動詞前再放回去。')
n('readme_column_width_authority', '欄寬歸 colgroup 決定', README, 'rationale',
  'table-layout: auto 下儲存格的 width 只是建議，輸給 min-width；'
  '而寬度不能寫在會被匯出隱藏的儲存格上，`<col>` 不屬於任何一列。')
n('readme_percent_coordinates', '物件座標是百分比', README, 'rationale',
  '同一張投影片會被畫在四個尺寸上，像素座標只會在其中一個是對的。')
n('readme_one_renderer_four_targets', '一份算繪器，四個目的地', README, 'rationale',
  '匯出是把畫面那份 DOM 序列化，不是拿字串重蓋一次——先前兩份字串組裝都已經跟編輯畫面漂開。')

# ----------------------------------------------------------------- ooxml/pdf --
n('readme_no_byte_roundtrip', '不做 byte-preserving 往返', README, 'rationale',
  '讀別人的 .docx 只拿得到 AI-OS 支援的區塊，存回去是乾淨的新檔案；UI 在覆蓋前明講。')
n('readme_ooxml_toggle_properties', '開關屬性不是「有就是開」', README, 'rationale',
  '<w:b w:val="0"/> 是明確關掉；只看標籤存不存在，剛好把那些 run 讀反。')
n('readme_ooxml_element_order', 'OOXML 子元素順序是 schema 規定的', README, 'rationale',
  '<mergeCells> 寫錯位置 Excel 會說檔案需要修復——其他讀取器都收，只有真正要用的那個不收。')
n('readme_pdf_to_markdown', 'PDF 轉 Markdown', README, 'rationale',
  '抽出來的純文字是一整片，階層全部消失；Markdown 把結構留住。'
  '圖片不自己解碼，改讓 pdf.js 算繪整頁再按擺放矩形裁切，所有編碼一次解決。')
n('readme_pdfmd_origin_inheritance', '轉出的檔案沿用原 PDF 的來源標記', README, 'rationale',
  '從不可信 PDF 轉出的 Markdown 是不可信文字，走一般寫檔路徑等於把汙染洗掉。')
n('readme_pdf_export', 'PDF 匯出（printToPDF）', README, 'rationale',
  '這台機器上已經有一個完整的排版引擎，再抬一個 PDF 產生器進來只會多一套要維護的字型與斷頁邏輯。')
n('readme_print_via_scheme', '列印走 aios-pdf:// 而不是 file://', README, 'rationale',
  'file:// 文件裡的一個 <img src> 就能把本機任何讀得到的檔案吸進輸出。')
n('readme_tounicode_defect', '中文字的 ToUnicode 缺陷', README, 'rationale',
  '缺陷在 Chromium、從這裡修不掉。處理方式是偵測後明講，不替使用者換字型：'
  '靜靜換掉會破壞所見即所得，靜靜接受則會讓搜尋失敗、複製出部首。')
n('readme_aios_pdf_scheme', 'aios-pdf:// scheme', README, 'rationale',
  '隔離不是靠 sandbox 屬性——opaque origin 會讓 pdf.js 自己的 fetch 變跨域、worker 被拒。'
  'token 才是重點：解析檔案的 frame 在整個 scheme 裡找不到任何路徑參數。')

# --------------------------------------------------------------- ops & tests --
n('readme_test_suite', '兩套測試：讀原始碼的與跑真程式的', README, 'rationale',
  'npm test 讀原始碼斷言形狀（452 條，八個檔案）；npm run test:e2e 啟動真的程式用 CDP 驅動（58 條）。'
  '第二套是後來才有的，而且是真正抓到 bug 的那一套——形狀測試看不見行為：'
  '書籤匯入解析出 0 筆、.pptx 存出來是 JSON、樹狀窗格被 flex 壓成六像素，'
  '都是「面板存在嗎」一路通過而東西不能用。')
n('readme_wiring_test', 'wiring.test.js（223 條）', README, 'rationale',
  '抓的是「preload 呼叫了一個沒人註冊的頻道」這種錯——在執行期只會表現成模糊的失敗。'
  '有幾條不是斷言註解而是算出來的（WCAG 對比、@page 尺寸）。')
n('readme_ncpumoe_tuning', '--n-cpu-moe 調校', README, 'rationale',
  '直覺以為 N 越小越快，但約 26 以下這張 12 GB 卡被填滿，WDDM 開始經 PCIe 補位，'
  '於是「把更多層搬上 GPU」變成更慢。真正的限制是這個行程同時是瀏覽器（多吃約 850 MiB）。')
# 2026-08-30：README 這一輪多出來的六節，補齊。概念節點是人工抽的，
# README 大改之後不補，圖就會安靜地少掉整個主題。
n('readme_pptx_export', 'PowerPoint 匯出（.pptx）', README, 'rationale',
  '和 docx / xlsx 走同一支 zip.js。只寫不讀：PowerPoint 存的檔案描述不了的那半個'
  '（母片繼承、版面配置、佈景主題、動畫）正好是使用者會想念的那半個，做一半比不做糟。'
  '兩個母片不能共用一份 theme——違反這條的檔案 OPC 驗證完全合法，PowerPoint 直接拒絕開啟。')
n('readme_tabs_not_windows', '為什麼是分頁不是視窗', README, 'rationale',
  '一次做出一百份筆記的流程開出了一百個視窗。每個視窗都是一個帶 backdrop-filter 的合成層，'
  '幾十個之後捲動任何東西都會看到內容閃掉再回來——看起來完全像記憶體不足，但記憶體很充足。'
  '會收文件的程式宣告 tabs: true，文件就進既有視窗的分頁。')
n('readme_external_drop', '從外面丟檔案進來', README, 'rationale',
  '沙箱是磁碟上真的目錄，把東西丟進去是再正常不過的用法。'
  '機器自己寫的不算外部變動，而且登記必須在寫入之前——監看器和寫入排在同一個事件迴圈上，'
  '通知可能比 promise resolve 還早到。刷新是安靜的：那行字沒有任何可據以行動的內容。')
n('readme_named_by_user', '例外：你自己指名的目標', README, 'rationale',
  '汙染降級要擋的是動作伸向使用者從沒提過的地方，它卻擋了所有提權動作，'
  '包含使用者在同一句話裡拼出來的那一個。什麼都要問的機器會訓練人不看就按允許，'
  '而那正是注入指令指望的習慣。只比對目的地參數：信件內文也是字串，'
  '讓內文能比對就等於讓注入的文字批准自己被寄出。')
n('readme_sandbox_search', '搜尋沙箱（fs.find）', README, 'rationale',
  '命中的那一行會一起回傳，不只是路徑：一串檔名會讓下一輪把每個檔案打開才知道哪個是對的。'
  '有界而且界限會說出來——安靜放棄的搜尋會對著明明在那裡的檔案說「找不到」。')
n('readme_plan_more_flag', '一份計畫可以說「我還沒做完」', README, 'rationale',
  '把猜測換成詢問。機器看「有什麼變了」分不出條件式，規劃者分得出。'
  '它立刻暴露出去重機制會擋住「再攻擊一次」——看過結果後選同一個動作，'
  '不是修復輪重述已完成步驟的那個錯。')
n('readme_electron_over_tauri', 'Electron 43.4.0 而不是 Tauri', README, 'rationale',
  '核心需求是內嵌任意網站：WebContentsView 不受 X-Frame-Options 限制，webview / iframe 會。')
n('readme_no_spawn_llama_semantics', '--no-spawn-llama 是「不要啟動」不是「沒有就失敗」', README, 'rationale',
  '能改供應商的那個視窗就在被拒絕開機的那個桌面裡。')
n('readme_reader_mode_own_extractor', '閱讀模式自己抽正文', README, 'rationale',
  'Readability + jsdom 是 50 MB 依賴外加第二個 JS 引擎，在一張要餵模型的顯卡上不值得。')

# -------------------------------------------------------------- html sources --
n('app_renderer_index_csp', 'shell 的 Content-Security-Policy', INDEX, 'rationale',
  'renderer 遲早要顯示抓回來的網頁與郵件內文，所以現在就鎖死：'
  '沒有遠端程式碼、沒有 inline script，唯一的網路目的地是本機模型主機。', 'index.html:29-38')
n('app_renderer_index_frame_src', 'frame-src aios-app: aios-pdf:', INDEX, 'rationale',
  '兩個 scheme 都只由主程序回應、只對它剛發出的隨機 token 有效；'
  '兩者都不是政策上的洞：這份文件仍然碰不到那兩個 frame，frame 也到不了網路。', 'index.html:10-35')
n('app_renderer_index_script_order', 'renderer 腳本相依順序', INDEX, 'rationale',
  '刻意不上 bundler：整個 renderer 在文字編輯器裡讀得懂、不用 sourcemap 就能除錯。'
  'markdown.js 必須排在 editor.js 之前，否則 .md 會被編輯器搶去當原始碼開。',
  'index.html:312-338')
n('app_renderer_index_dock', 'Dock', INDEX, 'code', None, 'index.html:270-294')
n('app_renderer_index_hud_left', '左側 HUD（注意力 / 沙箱 / 能力 / 記憶）', INDEX, 'code',
  None, 'index.html:146-213')
n('app_renderer_index_hud_right', '右側 HUD（核心軌跡 / 動作日誌）', INDEX, 'code',
  None, 'index.html:216-240')
n('app_renderer_index_intent_bar', '意圖列', INDEX, 'code',
  '收合建議詞的按鈕放在意圖列上而不是它控制的那一排：'
  '把那排藏起來之後，總得有個地方可以把它們叫回來。', 'index.html:246-265')
n('app_renderer_index_boot_sequence', '開機序列畫面', INDEX, 'code', None, 'index.html:45-62')
n('app_renderer_index_no_consent_here', '授權刻意不在這份文件裡呈現', INDEX, 'rationale',
  '主程序擁有那個視窗，所以這份文件無法核准自己的動作。', 'index.html:305-306')
n('app_renderer_consent_narrow_bridge', '授權視窗的窄橋 consent-view.js', CONSENT, 'code',
  None, 'consent.html:36')
n('app_renderer_consent_csp', '授權視窗的 CSP', CONSENT, 'rationale',
  "default-src 'none' 加 script-src 'self'：這個視窗就是對話框本身。", 'consent.html:5-6')
n('app_renderer_pdfview_isolation', 'PDF 檢視器的隔離', PDFVIEW, 'rationale',
  '它解析一個不可信檔案，所以拿到自己的來源、沒有 preload 橋接、'
  'CSP 由主程序給而不是文件自己宣告。', 'pdfview.html:6-19')
n('app_renderer_pdfview_textlayer', 'textLayer 樣式（取自 pdf.js）', PDFVIEW, 'rationale',
  '弄錯不會看起來壞掉，只會讓選取落在錯的字上，所以是抄過來而不是重新發明。',
  'pdfview.html:152-206')
n('app_renderer_pdfview_print_images', '列印時把每頁畫成圖', PDFVIEW, 'rationale',
  '螢幕上的頁面是惰性算繪的，沒有人捲到的那些會印成空白。', 'pdfview.html:284-296')

# ===================================================================== edges ==
# README concepts -> the code files the README's architecture reference names.
for cid, target in [
    ('readme_intent_kernel', 'app_renderer_kernel'),
    ('readme_syscall_table', 'app_main_gate'),
    ('readme_internal_ops', 'app_main_gate'),
    ('readme_capability_gate', 'app_main_gate'),
    ('readme_elevated_capabilities', 'app_main_gate'),
    ('readme_taint_downgrade', 'app_main_gate'),
    ('readme_consent_window', 'app_main_gate'),
    ('readme_consent_race_fix', 'app_main_gate'),
    ('readme_validate_before_asking', 'app_main_ipc'),
    ('readme_sandbox_filesystem', 'app_main_sandbox'),
    ('readme_sandbox_invariants', 'app_main_sandbox'),
    ('readme_windows_path_traps', 'app_main_sandbox'),
    ('readme_sandbox_quota', 'app_main_sandbox'),
    ('readme_model_provider', 'app_main_llama'),
    ('readme_transport_in_main_process', 'app_main_llama'),
    ('readme_provider_described_not_branched', 'app_main_llama'),
    ('readme_thinking_ladder', 'app_main_llama'),
    ('readme_none_not_rounded', 'app_main_llama'),
    ('readme_output_cap_provider_owned', 'app_main_llama'),
    ('readme_rejected_field_dropping', 'app_main_llama'),
    ('readme_key_storage_blob', 'app_main_llama'),
    ('readme_ncpumoe_tuning', 'app_main_llama'),
    ('readme_no_spawn_llama_semantics', 'app_main_llama'),
    ('readme_app_forge', 'app_main_forge'),
    ('readme_forge_parse_first', 'app_main_forge'),
    ('readme_forge_integrity_hash', 'app_main_forge'),
    ('readme_forge_gesture_channel', 'app_renderer_apps_forge'),
    ('readme_gesture_sentinel', 'app_renderer_apps_forge'),
    ('readme_aios_app_scheme', 'app_main_index'),
    ('readme_forge_iframe_sandbox', 'app_renderer_apps_appshell'),
    ('readme_forge_capability_broker', 'app_renderer_apps_appshell'),
    ('readme_os_calc', 'app_renderer_apps_formula'),
    ('readme_attention_scheduler', 'app_renderer_kernel'),
    ('readme_chatpane_context', 'app_renderer_apps_chatpane'),
    ('readme_whole_turn_eviction', 'app_renderer_apps_chatpane'),
    ('readme_receipts_carry_args', 'app_renderer_apps_chatpane'),
    ('readme_state_not_in_context', 'app_renderer_apps_chatpane'),
    ('readme_long_term_memory', 'app_main_memory'),
    ('readme_no_seeded_memory', 'app_main_memory'),
    ('readme_shutdown_ritual', 'app_renderer_shell'),
    ('readme_session_restore', 'app_main_session'),
    ('readme_unsaved_close_prompt', 'app_renderer_apps_registry'),
    ('readme_forced_close_needs_snapshot', 'app_renderer_apps_editor'),
    ('readme_formula_engine', 'app_renderer_apps_formula'),
    ('readme_formula_omissions', 'app_renderer_apps_formula'),
    ('readme_merged_cells', 'app_renderer_apps_sheets'),
    ('readme_merge_invariant', 'app_renderer_apps_sheets'),
    ('readme_grid_algebra', 'app_renderer_surfaces'),
    ('readme_cell_picker', 'app_renderer_surfaces'),
    ('readme_shared_borders', 'app_renderer_surfaces'),
    ('readme_palette', 'app_renderer_surfaces'),
    ('readme_images_pipeline', 'app_renderer_surfaces'),
    ('readme_popover', 'app_renderer_surfaces'),
    ('readme_context_menu', 'app_renderer_apps_registry'),
    ('readme_column_width_authority', 'app_renderer_apps_sheets'),
    ('readme_percent_coordinates', 'app_renderer_apps_slides'),
    ('readme_one_renderer_four_targets', 'app_renderer_apps_slides'),
    ('readme_no_byte_roundtrip', 'app_main_office'),
    ('readme_ooxml_toggle_properties', 'app_main_office'),
    ('readme_ooxml_element_order', 'app_main_office'),
    ('readme_pdf_to_markdown', 'app_renderer_pdfmd'),
    ('readme_pdfmd_origin_inheritance', 'app_main_pdf'),
    ('readme_pdf_export', 'app_main_pdf'),
    ('readme_print_via_scheme', 'app_main_pdf'),
    ('readme_tounicode_defect', 'app_main_pdf'),
    ('readme_aios_pdf_scheme', 'app_main_pdf'),
    ('readme_test_suite', 'test_wiring_test'),
    ('readme_test_suite', 'e2e_run'),
    ('readme_wiring_test', 'test_wiring_test'),
    ('readme_reader_mode_own_extractor', 'app_main_web'),
    ('readme_config_outside_sandbox', 'app_main_index'),
    ('readme_seed_injection_demo', 'app_main_sandbox'),
    ('readme_electron_over_tauri', 'package'),
    ('readme_main_process_boundary', 'app_preload_index'),
]:
    e(cid, target, 'references', 'EXTRACTED', 1.0, README)

# README concept -> concept
for s, t, rel, conf, score in [
    ('readme_ai_os', 'readme_intent_kernel', 'references', 'EXTRACTED', 1.0),
    ('readme_intent_kernel', 'readme_syscall_table', 'references', 'EXTRACTED', 1.0),
    ('readme_syscall_table', 'readme_capability_gate', 'references', 'EXTRACTED', 1.0),
    ('readme_capability_gate', 'readme_elevated_capabilities', 'references', 'EXTRACTED', 1.0),
    ('readme_capability_gate', 'readme_taint_downgrade', 'references', 'EXTRACTED', 1.0),
    ('readme_taint_downgrade', 'readme_elevated_capabilities', 'references', 'EXTRACTED', 1.0),
    ('readme_capability_gate', 'readme_consent_window', 'references', 'EXTRACTED', 1.0),
    ('readme_consent_window', 'readme_consent_race_fix', 'references', 'EXTRACTED', 1.0),
    ('readme_consent_race_fix', 'readme_forge_gesture_channel', 'rationale_for', 'EXTRACTED', 1.0),
    ('readme_main_process_boundary', 'readme_consent_window', 'references', 'EXTRACTED', 1.0),
    ('readme_main_process_boundary', 'readme_transport_in_main_process', 'references', 'EXTRACTED', 1.0),
    ('readme_main_process_boundary', 'readme_taint_downgrade', 'references', 'EXTRACTED', 1.0),
    ('readme_transport_in_main_process', 'app_renderer_index_csp', 'rationale_for', 'EXTRACTED', 1.0),
    ('readme_transport_in_main_process', 'readme_key_storage_blob', 'references', 'EXTRACTED', 1.0),
    ('readme_model_provider', 'readme_provider_described_not_branched', 'references', 'EXTRACTED', 1.0),
    ('readme_model_provider', 'readme_model_list_probe', 'references', 'EXTRACTED', 1.0),
    ('readme_model_provider', 'readme_thinking_ladder', 'references', 'EXTRACTED', 1.0),
    ('readme_thinking_ladder', 'readme_none_not_rounded', 'references', 'EXTRACTED', 1.0),
    ('readme_thinking_ladder', 'readme_output_cap_provider_owned', 'references', 'EXTRACTED', 1.0),
    ('readme_model_provider', 'readme_rejected_field_dropping', 'references', 'EXTRACTED', 1.0),
    ('readme_model_provider', 'readme_cloud_wire_format', 'references', 'EXTRACTED', 1.0),
    ('readme_model_provider', 'readme_no_tokenizer_disclosure', 'references', 'EXTRACTED', 1.0),
    ('readme_no_tokenizer_disclosure', 'readme_attention_scheduler', 'references', 'EXTRACTED', 1.0),
    ('readme_model_provider', 'readme_remote_kernel_cost_banner', 'references', 'EXTRACTED', 1.0),
    ('readme_model_provider', 'readme_handshake_vs_boot', 'references', 'EXTRACTED', 1.0),
    ('readme_handshake_vs_boot', 'readme_no_spawn_llama_semantics', 'conceptually_related_to', 'INFERRED', 0.95),
    ('readme_remote_kernel_cost_banner', 'readme_capability_gate', 'references', 'EXTRACTED', 1.0),
    ('readme_app_forge', 'readme_forge_parse_first', 'references', 'EXTRACTED', 1.0),
    ('readme_app_forge', 'readme_forge_iframe_sandbox', 'references', 'EXTRACTED', 1.0),
    ('readme_forge_iframe_sandbox', 'readme_forge_capability_broker', 'references', 'EXTRACTED', 1.0),
    ('readme_app_forge', 'readme_forge_integrity_hash', 'references', 'EXTRACTED', 1.0),
    ('readme_forge_integrity_hash', 'readme_config_outside_sandbox', 'references', 'EXTRACTED', 1.0),
    ('readme_app_forge', 'readme_forge_gesture_channel', 'references', 'EXTRACTED', 1.0),
    ('readme_forge_gesture_channel', 'readme_gesture_sentinel', 'references', 'EXTRACTED', 1.0),
    ('readme_forge_gesture_channel', 'readme_taint_downgrade', 'references', 'EXTRACTED', 1.0),
    ('readme_app_forge', 'readme_aios_app_scheme', 'references', 'EXTRACTED', 1.0),
    ('readme_os_calc', 'readme_no_eval_anchor', 'references', 'AMBIGUOUS', 0.2),
    ('readme_app_forge', 'readme_os_calc', 'references', 'EXTRACTED', 1.0),
    ('readme_os_calc', 'readme_formula_engine', 'references', 'EXTRACTED', 1.0),
    ('readme_app_forge', 'readme_forge_layout_color_rules', 'references', 'EXTRACTED', 1.0),
    ('readme_forge_layout_color_rules', 'readme_on_fill_variable', 'references', 'EXTRACTED', 1.0),
    ('readme_on_fill_variable', 'readme_palette', 'conceptually_related_to', 'INFERRED', 0.85),
    ('readme_on_fill_variable', 'readme_wiring_test', 'references', 'EXTRACTED', 1.0),
    ('readme_attention_scheduler', 'readme_chatpane_context', 'references', 'EXTRACTED', 1.0),
    ('readme_chatpane_context', 'readme_whole_turn_eviction', 'references', 'EXTRACTED', 1.0),
    ('readme_chatpane_context', 'readme_receipts_carry_args', 'references', 'EXTRACTED', 1.0),
    ('readme_chatpane_context', 'readme_state_not_in_context', 'references', 'EXTRACTED', 1.0),
    ('readme_chatpane_context', 'readme_session_restore', 'references', 'EXTRACTED', 1.0),
    ('readme_long_term_memory', 'readme_no_seeded_memory', 'references', 'EXTRACTED', 1.0),
    ('readme_long_term_memory', 'readme_config_outside_sandbox', 'references', 'EXTRACTED', 1.0),
    ('readme_shutdown_ritual', 'readme_session_restore', 'references', 'EXTRACTED', 1.0),
    ('readme_shutdown_ritual', 'readme_unsaved_close_prompt', 'references', 'EXTRACTED', 1.0),
    ('readme_shutdown_ritual', 'readme_forced_close_needs_snapshot', 'references', 'EXTRACTED', 1.0),
    ('readme_formula_engine', 'readme_formula_omissions', 'references', 'EXTRACTED', 1.0),
    ('readme_merged_cells', 'readme_grid_algebra', 'references', 'EXTRACTED', 1.0),
    ('readme_merged_cells', 'readme_merge_invariant', 'references', 'EXTRACTED', 1.0),
    ('readme_grid_algebra', 'readme_cell_picker', 'references', 'EXTRACTED', 1.0),
    ('readme_grid_algebra', 'readme_shared_borders', 'references', 'EXTRACTED', 1.0),
    ('readme_shared_borders', 'readme_three_edge_states', 'references', 'EXTRACTED', 1.0),
    ('readme_shared_borders', 'readme_ooxml_toggle_properties', 'conceptually_related_to', 'INFERRED', 0.85),
    ('readme_cell_picker', 'readme_context_menu', 'references', 'EXTRACTED', 1.0),
    ('readme_palette', 'readme_wiring_test', 'references', 'EXTRACTED', 1.0),
    ('readme_images_pipeline', 'app_renderer_index_csp', 'rationale_for', 'EXTRACTED', 1.0),
    ('readme_images_pipeline', 'readme_taint_downgrade', 'references', 'EXTRACTED', 1.0),
    ('readme_no_byte_roundtrip', 'readme_ooxml_toggle_properties', 'references', 'EXTRACTED', 1.0),
    ('readme_no_byte_roundtrip', 'readme_ooxml_element_order', 'references', 'EXTRACTED', 1.0),
    ('readme_pdf_to_markdown', 'readme_pdfmd_origin_inheritance', 'references', 'EXTRACTED', 1.0),
    ('readme_pdfmd_origin_inheritance', 'readme_taint_downgrade', 'references', 'EXTRACTED', 1.0),
    ('readme_pdf_export', 'readme_print_via_scheme', 'references', 'EXTRACTED', 1.0),
    ('readme_pdf_export', 'readme_tounicode_defect', 'references', 'EXTRACTED', 1.0),
    ('readme_print_via_scheme', 'readme_aios_pdf_scheme', 'references', 'EXTRACTED', 1.0),
    ('readme_pdf_export', 'readme_one_renderer_four_targets', 'conceptually_related_to', 'INFERRED', 0.85),
    ('readme_column_width_authority', 'readme_pdf_export', 'references', 'EXTRACTED', 1.0),
    ('readme_test_suite', 'readme_wiring_test', 'references', 'EXTRACTED', 1.0),
    ('readme_wiring_test', 'readme_syscall_table', 'references', 'EXTRACTED', 1.0),
    ('readme_wiring_test', 'readme_forge_gesture_channel', 'references', 'EXTRACTED', 1.0),
    ('readme_wiring_test', 'readme_merge_invariant', 'references', 'EXTRACTED', 1.0),
    ('readme_wiring_test', 'readme_three_edge_states', 'references', 'EXTRACTED', 1.0),
    ('readme_wiring_test', 'readme_column_width_authority', 'references', 'EXTRACTED', 1.0),
    ('readme_wiring_test', 'readme_chatpane_context', 'references', 'EXTRACTED', 1.0),
    ('readme_wiring_test', 'readme_model_provider', 'references', 'EXTRACTED', 1.0),
    ('readme_wiring_test', 'readme_aios_pdf_scheme', 'references', 'EXTRACTED', 1.0),
    ('readme_electron_over_tauri', 'readme_reader_mode_own_extractor', 'conceptually_related_to', 'INFERRED', 0.75),
    ('readme_ncpumoe_tuning', 'readme_electron_over_tauri', 'conceptually_related_to', 'INFERRED', 0.75),
    ('readme_validate_before_asking', 'readme_windows_path_traps', 'references', 'EXTRACTED', 1.0),
    ('readme_sandbox_invariants', 'readme_sandbox_quota', 'references', 'EXTRACTED', 1.0),
    ('readme_sandbox_filesystem', 'readme_windows_path_traps', 'references', 'EXTRACTED', 1.0),
    ('readme_seed_injection_demo', 'readme_taint_downgrade', 'references', 'EXTRACTED', 1.0),
    # 2026-08-30：新補的六個概念接到它們描述的程式碼上。一個沒有邊的概念節點
    # 是一座孤島，圖上看得到卻走不到。
    ('readme_pptx_export', 'app_main_office', 'references', 'EXTRACTED', 1.0),
    ('readme_pptx_export', 'app_renderer_apps_slides', 'references', 'EXTRACTED', 1.0),
    ('readme_pptx_export', 'app_main_zip', 'references', 'EXTRACTED', 1.0),
    ('readme_tabs_not_windows', 'app_renderer_apps_registry', 'references', 'EXTRACTED', 1.0),
    ('readme_tabs_not_windows', 'app_renderer_apps_browser', 'references', 'EXTRACTED', 1.0),
    ('readme_tabs_not_windows', 'app_renderer_apps_editor', 'references', 'EXTRACTED', 1.0),
    ('readme_external_drop', 'app_main_sandbox', 'references', 'EXTRACTED', 1.0),
    ('readme_external_drop', 'app_renderer_surfaces', 'references', 'EXTRACTED', 1.0),
    ('readme_named_by_user', 'app_main_gate', 'references', 'EXTRACTED', 1.0),
    ('readme_named_by_user', 'readme_taint_downgrade', 'references', 'EXTRACTED', 1.0),
    ('readme_sandbox_search', 'app_main_sandbox', 'references', 'EXTRACTED', 1.0),
    ('readme_sandbox_search', 'app_renderer_apps_files', 'references', 'EXTRACTED', 1.0),
    ('readme_sandbox_search', 'readme_syscall_table', 'references', 'EXTRACTED', 1.0),
    ('readme_plan_more_flag', 'app_renderer_kernel', 'references', 'EXTRACTED', 1.0),
    ('readme_plan_more_flag', 'app_renderer_boot', 'references', 'EXTRACTED', 1.0),
    ('readme_plan_more_flag', 'readme_intent_kernel', 'references', 'EXTRACTED', 1.0),
    ('readme_forge_integrity_hash', 'readme_capability_gate', 'references', 'EXTRACTED', 1.0),
]:
    e(s, t, rel, conf, score, README)

# The three HTML documents.
for s, t, rel, conf, score, src in [
    ('app_renderer_index_shell_document', 'app_renderer_index_csp', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_csp', 'app_renderer_index_frame_src', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_frame_src', 'readme_aios_app_scheme', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_frame_src', 'readme_aios_pdf_scheme', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_shell_document', 'app_renderer_index_script_order', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_script_order', 'app_renderer_kernel', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_script_order', 'app_renderer_surfaces', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_script_order', 'app_renderer_apps_markdown', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_script_order', 'app_renderer_apps_editor', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_script_order', 'app_renderer_boot', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_script_order', 'app_renderer_shell', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_script_order', 'readme_wiring_test', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_shell_document', 'app_renderer_index_dock', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_shell_document', 'app_renderer_index_hud_left', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_shell_document', 'app_renderer_index_hud_right', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_shell_document', 'app_renderer_index_intent_bar', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_shell_document', 'app_renderer_index_boot_sequence', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_shell_document', 'app_renderer_index_no_consent_here', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_no_consent_here', 'app_main_gate', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_no_consent_here', 'readme_consent_window', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_hud_left', 'readme_attention_scheduler', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_hud_left', 'readme_capability_gate', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_hud_left', 'readme_long_term_memory', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_intent_bar', 'readme_intent_kernel', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_dock', 'readme_capability_gate', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_index_csp', 'readme_transport_in_main_process', 'references', 'EXTRACTED', 1.0, INDEX),
    ('app_renderer_consent_dialog_document', 'app_renderer_consent_csp', 'references', 'EXTRACTED', 1.0, CONSENT),
    ('app_renderer_consent_dialog_document', 'app_renderer_consent_narrow_bridge', 'references', 'EXTRACTED', 1.0, CONSENT),
    ('app_renderer_consent_narrow_bridge', 'app_renderer_consent_view', 'references', 'EXTRACTED', 1.0, CONSENT),
    ('app_renderer_consent_narrow_bridge', 'app_preload_consent', 'references', 'EXTRACTED', 1.0, CONSENT),
    ('app_renderer_consent_dialog_document', 'readme_consent_window', 'references', 'EXTRACTED', 1.0, CONSENT),
    ('app_renderer_consent_dialog_document', 'app_main_gate', 'references', 'EXTRACTED', 1.0, CONSENT),
    ('app_renderer_pdfview_viewer_document', 'app_renderer_pdfview_isolation', 'references', 'EXTRACTED', 1.0, PDFVIEW),
    ('app_renderer_pdfview_viewer_document', 'app_renderer_pdfview_textlayer', 'references', 'EXTRACTED', 1.0, PDFVIEW),
    ('app_renderer_pdfview_viewer_document', 'app_renderer_pdfview_print_images', 'references', 'EXTRACTED', 1.0, PDFVIEW),
    ('app_renderer_pdfview_viewer_document', 'app_renderer_pdfview', 'references', 'EXTRACTED', 1.0, PDFVIEW),
    ('app_renderer_pdfview_isolation', 'readme_aios_pdf_scheme', 'references', 'EXTRACTED', 1.0, PDFVIEW),
    ('app_renderer_pdfview_isolation', 'app_main_pdf', 'references', 'EXTRACTED', 1.0, PDFVIEW),
    ('app_renderer_pdfview_isolation', 'readme_main_process_boundary', 'conceptually_related_to', 'INFERRED', 0.95, PDFVIEW),
    ('app_renderer_pdfview_print_images', 'readme_pdf_export', 'conceptually_related_to', 'INFERRED', 0.75, PDFVIEW),
    ('app_renderer_consent_csp', 'app_renderer_index_csp', 'semantically_similar_to', 'INFERRED', 0.85, CONSENT),
    ('app_renderer_pdfview_isolation', 'readme_forge_iframe_sandbox', 'semantically_similar_to', 'INFERRED', 0.85, PDFVIEW),
]:
    e(s, t, rel, conf, score, src)

hyperedges = [
    {
        'id': 'consent_and_taint_flow',
        'label': '授權與汙染的主程序防線',
        'nodes': ['readme_capability_gate', 'readme_taint_downgrade',
                  'readme_elevated_capabilities', 'readme_consent_window',
                  'readme_main_process_boundary', 'app_main_gate'],
        'relation': 'participate_in', 'confidence': 'EXTRACTED',
        'confidence_score': 1.0, 'source_file': README,
    },
    {
        'id': 'shared_table_stack',
        'label': '三個介面共用的表格堆疊',
        'nodes': ['readme_grid_algebra', 'readme_cell_picker', 'readme_shared_borders',
                  'readme_merged_cells', 'readme_palette', 'app_renderer_surfaces'],
        'relation': 'form', 'confidence': 'EXTRACTED',
        'confidence_score': 1.0, 'source_file': README,
    },
    {
        'id': 'provider_abstraction_stack',
        'label': '供應商抽象層',
        'nodes': ['readme_model_provider', 'readme_provider_described_not_branched',
                  'readme_transport_in_main_process', 'readme_thinking_ladder',
                  'readme_output_cap_provider_owned', 'readme_rejected_field_dropping'],
        'relation': 'form', 'confidence': 'EXTRACTED',
        'confidence_score': 1.0, 'source_file': README,
    },
]

# Drop the one placeholder target that has no node (kept AMBIGUOUS above by
# mistake would create a dangling endpoint the health check would flag).
known = {x['id'] for x in nodes} | {
    'app_main_browser', 'app_main_forge', 'app_main_gate', 'app_main_index',
    'app_main_ipc', 'app_main_llama', 'app_main_mail', 'app_main_memory',
    'app_main_office', 'app_main_pdf', 'app_main_sandbox', 'app_main_session',
    'app_main_web', 'app_main_zip', 'app_preload_consent', 'app_preload_index',
    'app_renderer_apps_appshell', 'app_renderer_apps_browser',
    'app_renderer_apps_chatpane', 'app_renderer_apps_docs',
    'app_renderer_apps_editor', 'app_renderer_apps_files',
    'app_renderer_apps_forge', 'app_renderer_apps_formula',
    'app_renderer_apps_mail', 'app_renderer_apps_markdown',
    'app_renderer_apps_memory', 'app_renderer_apps_pdf',
    'app_renderer_apps_registry', 'app_renderer_apps_sheets',
    'app_renderer_apps_slides', 'app_renderer_boot',
    'app_renderer_consent_view', 'app_renderer_kernel', 'app_renderer_pdfmd',
    'app_renderer_pdfview', 'app_renderer_shell', 'app_renderer_surfaces',
    'app_renderer_ui', 'package', 'test_formula_test', 'test_markdown_test',
    'test_office_test', 'test_pdf_test', 'test_pdfmd_test',
    'test_sandbox_test', 'test_wiring_test',
    # The e2e suite's own root. Added when the test-suite concept stopped
    # being 「362 個測試」 and became 「兩套測試」 -- the concept now names both,
    # so it has to reach both.
    'e2e_run', 'test_mailstore_test',
}
dropped = [x for x in edges if x['source'] not in known or x['target'] not in known]
edges[:] = [x for x in edges if x['source'] in known and x['target'] in known]

# Before writing anything: a wrong address published confidently is worse
# than no address at all.
check_locations()

out = {'nodes': nodes, 'edges': edges, 'hyperedges': hyperedges,
       'input_tokens': 0, 'output_tokens': 0}
Path(r'D:\WorkSpace\AI-OS\graphify-out\.graphify_chunk_01.json').write_text(
    json.dumps(out, indent=2, ensure_ascii=False), encoding='utf-8')
print(f'chunk 1/1: {len(nodes)} nodes, {len(edges)} edges, {len(hyperedges)} hyperedges')
print(f'dropped {len(dropped)} edges with unknown endpoints:',
      [(x["source"], x["target"]) for x in dropped])
