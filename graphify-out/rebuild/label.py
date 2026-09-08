import json
import sys
from pathlib import Path
from graphify.build import build_from_json
from graphify.analyze import suggest_questions
from graphify.report import generate
from graphify.export import to_json

# Community id -> name.
#
# The ids are positional: Leiden renumbers on every run, so this map is only
# valid for the clustering it was written against. Re-running after the code
# changed and keeping the old map is worse than having no names at all -- it was
# measured drifting badly enough that `app_main_preset` came out labelled
# 「視窗管理與版面」, `app_main_zip` as 「HUD 與軌跡繪製」 and `package.json` as
# 「Markdown 檢視器」. A graph that names things wrongly is read as fact.
#
# So: after every rebuild, check the names against what is actually in each
# community before trusting the report. `python graphify-out/rebuild/label.py`
# refuses to run when a community has no name, which catches new ones but not
# renumbered ones -- those only a look will catch. `audit()` below prints the
# dominant file of each community next to its name for exactly that.
# 2026-08-30 第三次重跑：整張表又重寫過。45 → 52 個社群，對應關係和上一版完全不同。
# 這一輪加了 fs.find（sandbox / ipc / preload / surfaces）、計畫的 more 旗標
# （kernel / boot）、pdf.js 的部首修復、瀏覽器分頁，Leiden 從頭重新編號。
# 兩個結構性的變化值得記：office.js 的四個子社群合回成一個（第 4 群，70 個節點），
# 而 gate.js 裂成三個——主體（17）、批次授權（46）、汙染集（50）。
# 每一條都是拿實際成員對出來的，不是沿用。
LABELS = {
    0: '簡報應用程式', 1: '試算表應用程式', 2: '文件應用程式', 3: '公式引擎',
    4: '模型供應商與傳輸', 5: 'PDF 剖析與抽字', 6: '共用面板與視窗管理',
    7: '瀏覽器視圖、syscall 邊界與模型預設檔', 8: '沙箱檔案系統',
    9: '端對端測試骨架',
    10: '公式、Markdown 與沙箱測試', 11: '視窗 AI 對話面板與工作階段',
    12: 'PDF 檢視器算繪', 13: '郵件 IMAP/SMTP 與網頁抓取', 14: '專案相依與建置設定',
    15: '能力閘門與授權', 16: '郵件本機鏡像', 17: '意圖核心與 context 預算',
    18: 'App Forge 主程序', 19: 'Markdown 檢視器', 20: 'OOXML 讀寫核心',
    21: '生成程式沙箱與 broker', 22: '開機序列與意圖回合', 23: '主程序生命週期',
    24: '接線測試與主題對比', 25: 'App Forge 建置介面', 26: 'PDF 應用程式視窗',
    27: 'PDF 轉 Markdown', 28: '長期記憶儲存', 29: '文字編輯器',
    30: '瀏覽器應用程式視窗', 31: '檔案總管', 32: '書籤儲存',
    33: 'preload 橋接、HUD 與記憶視窗', 34: '郵件應用程式視窗',
    35: '桌面殼層與 shell 文件', 36: 'OOXML：xlsx 產出與欄寬換算',
    37: 'OOXML：pptx 產出', 38: '授權視窗與窄橋',
    # 這一輪新增的：檢查文件本身是否還說著實話的那一套測試。
    39: '文件自我檢查測試',
    40: '能力邊界與汙染的概念', 41: 'OOXML：框線算術與 xlsx 讀取',
    42: 'zip 容器與 PowerPoint 匯出', 43: '應用程式註冊表與分頁',
    44: 'aios-app scheme 與程式完整性', 45: 'OOXML：docx 產出',
    46: 'Office 往返測試', 47: '汙染集追蹤', 48: '建置腳本',
}

extraction = json.loads(Path('graphify-out/.graphify_extract.json').read_text(encoding='utf-8'))
detection = json.loads(Path('graphify-out/.graphify_detect.json').read_text(encoding='utf-8'))
analysis = json.loads(Path('graphify-out/.graphify_analysis.json').read_text(encoding='utf-8'))

G = build_from_json(extraction, root='.', directed=False)
communities = {int(k): v for k, v in analysis['communities'].items()}
cohesion = {int(k): v for k, v in analysis['cohesion'].items()}
tokens = {'input': extraction.get('input_tokens', 0),
          'output': extraction.get('output_tokens', 0)}

missing = set(communities) - set(LABELS)
if missing:
    raise SystemExit(f'unlabelled communities: {sorted(missing)}')


def audit():
    """Print each community's name next to the file it is actually made of.

    The only check that catches renumbering. A missing name stops the script; a
    name attached to the wrong community does not, and that is the failure that
    actually happened -- run with `audit` and read the two columns.
    """
    import collections
    import re
    prefixes = ('app_renderer_apps_', 'app_renderer_', 'app_main_', 'app_preload_',
                'test_', 'readme_', 'docref_', 'smoke_', 'build_')
    for cid in sorted(communities):
        counts = collections.Counter()
        for m in communities[cid]:
            for p in prefixes:
                if m.startswith(p):
                    counts[p + m[len(p):].split('_')[0]] += 1
                    break
            else:
                counts[re.sub(r'_.*$', '', m)] += 1
        top = ', '.join(f'{k}({n})' for k, n in counts.most_common(3))
        print(f'{cid:>3} | {LABELS.get(cid, "(無)"):<22} | {top}')


if 'audit' in sys.argv:
    audit()
    raise SystemExit(0)

questions = suggest_questions(G, communities, LABELS)
report = generate(G, communities, cohesion, LABELS, analysis['gods'],
                  analysis['surprises'], detection, tokens, '.',
                  suggested_questions=questions)
Path('graphify-out/GRAPH_REPORT.md').write_text(report, encoding='utf-8')
Path('graphify-out/.graphify_labels.json').write_text(
    json.dumps({str(k): v for k, v in LABELS.items()}, ensure_ascii=False), encoding='utf-8')

if not to_json(G, communities, 'graphify-out/graph.json', community_labels=LABELS):
    print('ERROR: refused to shrink graphify-out/graph.json (#479).')
else:
    print('Report and graph.json updated with community labels')
