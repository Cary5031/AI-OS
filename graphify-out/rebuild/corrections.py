"""Corrections to the first semantic extraction pass, each backed by evidence.

1. `readme_wiring_test` was a ghost duplicate of the AST node `test_wiring_test`.
   The extraction spec forbids this ("using just the filename ... will create
   orphan ghost-duplicate nodes"). The ghost carried 13 concept edges while the
   real file node carried the 29 structural ones, so the project's genuine
   cross-cutting hub was split in two and the ghost took the betweenness
   (0.1889 vs 0.0684). Fix: rewire every edge onto `test_wiring_test`.

2. `app_renderer_consent_narrow_bridge` was both a ghost duplicate of
   `app_renderer_consent_view` AND a conflation: the README calls
   `preload/consent.js` the narrow bridge, while consent.html line 36 loads
   `renderer/consent-view.js`. Two different files. Fix: drop the node and let
   consent.html reference each real node directly.

3. wiring.test.js's real coupling is invisible to AST: it reads 28 source files
   as text through `read()` (test/wiring.test.js:25) and globs every .js in
   renderer/apps/. Those are real dependencies -- change any of those files and
   this test can fail -- but `fs.readFileSync(path.join(...))` is not an import,
   so AST saw only 3 requires. Fix: add the read() couplings as EXTRACTED
   `references` edges, each anchored to the line that reads the file.

4. Same gap, smaller, in formula.test.js and markdown.test.js.
"""
import json
from pathlib import Path

CHUNK = Path('graphify-out/.graphify_chunk_01.json')
WIRING = r'D:\WorkSpace\AI-OS\test\wiring.test.js'
FORMULA = r'D:\WorkSpace\AI-OS\test\formula.test.js'
MARKDOWN = r'D:\WorkSpace\AI-OS\test\markdown.test.js'

d = json.loads(CHUNK.read_text(encoding='utf-8'))
before_n, before_e = len(d['nodes']), len(d['edges'])

# -- 1 & 2: drop the ghosts, rewire their edges onto the real nodes ------------
REWIRE = {
    'readme_wiring_test': 'test_wiring_test',
    'app_renderer_consent_narrow_bridge': 'app_renderer_consent_view',
}
ghosts = set(REWIRE)
d['nodes'] = [x for x in d['nodes'] if x['id'] not in ghosts]

for edge in d['edges']:
    edge['source'] = REWIRE.get(edge['source'], edge['source'])
    edge['target'] = REWIRE.get(edge['target'], edge['target'])
for h in d['hyperedges']:
    h['nodes'] = [REWIRE.get(x, x) for x in h['nodes']]

# The conflated node also stood in for the preload bridge; consent.html loads
# consent-view.js and the gate hands it a narrow preload. Both edges are real.
d['edges'].append({
    'source': 'app_renderer_consent_dialog_document', 'target': 'app_preload_consent',
    'relation': 'references', 'confidence': 'EXTRACTED', 'confidence_score': 1.0,
    'source_file': r'D:\WorkSpace\AI-OS\app\renderer\consent.html',
    'source_location': 'consent.html:36', 'weight': 1.0,
})

# Drop self-loops and exact duplicates created by the rewiring.
seen, deduped = set(), []
for edge in d['edges']:
    if edge['source'] == edge['target']:
        continue
    key = (edge['source'], edge['target'], edge['relation'])
    if key in seen:
        continue
    seen.add(key)
    deduped.append(edge)
d['edges'] = deduped

# -- 3: the read() couplings AST cannot see ------------------------------------
# path in the read() call -> (AST node id, first line that reads it)
READS = [
    ('app_main_ipc', 'L78'), ('app_preload_index', 'L124'), ('app_main_index', 'L126'),
    ('app_renderer_index_shell_document', 'L151'), ('app_renderer_apps_appshell', 'L198'),
    ('app_renderer_apps_forge', 'L245'), ('app_main_forge', 'L408'),
    ('app_main_gate', 'L618'), ('app_renderer_surfaces', 'L628'),
    ('app_renderer_shell', 'L729'), ('app_renderer_boot', 'L730'),
    ('app_renderer_apps_sheets', 'L738'), ('app_renderer_apps_docs', 'L1262'),
    ('app_main_browser', 'L1426'), ('app_main_pdf', 'L1435'),
    ('app_renderer_apps_pdf', 'L1453'), ('app_renderer_pdfview', 'L1472'),
    ('app_renderer_apps_markdown', 'L1545'), ('app_renderer_apps_editor', 'L1571'),
    ('app_renderer_apps_slides', 'L1635'), ('app_renderer_apps_registry', 'L1897'),
    ('app_main_office', 'L2195'), ('app_renderer_apps_chatpane', 'L2798'),
    ('app_main_session', 'L2867'), ('app_renderer_kernel', 'L2941'),
    ('app_main_llama', 'L2957'), ('app_renderer_ui', 'L3073'),
]
# readdirSync globs over every .js in renderer/apps/ pick up the rest.
GLOBS = [
    ('app_renderer_apps_browser', 'L711'), ('app_renderer_apps_files', 'L711'),
    ('app_renderer_apps_mail', 'L711'), ('app_renderer_apps_memory', 'L711'),
    ('app_renderer_apps_formula', 'L1749'),
]
for target, loc in READS + GLOBS:
    d['edges'].append({
        'source': 'test_wiring_test', 'target': target, 'relation': 'references',
        'confidence': 'EXTRACTED', 'confidence_score': 1.0,
        'source_file': WIRING, 'source_location': loc, 'weight': 1.0,
    })

# -- 4: the same gap in two more test files ------------------------------------
d['edges'].append({
    'source': 'test_formula_test', 'target': 'app_renderer_apps_formula',
    'relation': 'references', 'confidence': 'EXTRACTED', 'confidence_score': 1.0,
    'source_file': FORMULA, 'source_location': 'L21', 'weight': 1.0,
})
d['edges'].append({
    'source': 'test_markdown_test', 'target': 'app_renderer_apps_markdown',
    'relation': 'references', 'confidence': 'EXTRACTED', 'confidence_score': 1.0,
    'source_file': MARKDOWN, 'source_location': 'L21', 'weight': 1.0,
})

# The suite concept covers all seven files, not just the one it happened to name.
for t in ('test_formula_test', 'test_markdown_test', 'test_office_test',
          'test_pdf_test', 'test_pdfmd_test', 'test_sandbox_test'):
    d['edges'].append({
        'source': 'readme_test_suite', 'target': t, 'relation': 'references',
        'confidence': 'EXTRACTED', 'confidence_score': 1.0,
        'source_file': r'D:\WorkSpace\AI-OS\README.md',
        'source_location': None, 'weight': 1.0,
    })

CHUNK.write_text(json.dumps(d, indent=2, ensure_ascii=False), encoding='utf-8')
print(f'nodes {before_n} -> {len(d["nodes"])}   edges {before_e} -> {len(d["edges"])}')
print('dropped ghosts:', sorted(ghosts))
