"""Corrective full rebuild: detect -> AST -> corrected semantic -> build."""
import json
import shutil
from pathlib import Path

from graphify.detect import detect
from graphify.extract import collect_files, extract

OUT = Path('graphify-out')

# ------------------------------------------------------------------- detect --
result = detect(Path('.'))
(OUT / '.graphify_detect.json').write_text(json.dumps(result, ensure_ascii=False),
                                           encoding='utf-8')
print(f'Detected {result["total_files"]} files')

# ---------------------------------------------------------------------- AST --
code_files = []
for f in result.get('files', {}).get('code', []):
    p = Path(f)
    code_files.extend(collect_files(p) if p.is_dir() else [p])
ast = extract(code_files, cache_root=Path('.'), parallel=False)
print(f'AST: {len(ast["nodes"])} nodes, {len(ast["edges"])} edges')

# -- AST artifact: a node parsed out of a string literal ----------------------
# test/wiring.test.js:227 holds the fixture 'function render(){ import("x") }',
# a sample of forbidden code the validator must reject. The extractor parsed
# inside the string and emitted a `dynamic_import` edge to a node literally
# named "x", whose source_file is "x" -- no such file exists.
phantom = {n['id'] for n in ast['nodes']
           if n['id'] == 'x' and n.get('source_file') == 'x'}
if phantom:
    ast['nodes'] = [n for n in ast['nodes'] if n['id'] not in phantom]
    dropped = [e for e in ast['edges']
               if e['source'] in phantom or e['target'] in phantom]
    ast['edges'] = [e for e in ast['edges']
                    if e['source'] not in phantom and e['target'] not in phantom]
    print(f'dropped phantom node(s) {sorted(phantom)} and {len(dropped)} edge(s) '
          f'parsed from a string-literal fixture')

# ----------------------------------------------------------------- semantic --
sem = {'nodes': [], 'edges': [], 'hyperedges': []}
for chunk in sorted(OUT.glob('.graphify_chunk_*.json')):
    part = json.loads(chunk.read_text(encoding='utf-8'))
    sem['nodes'] += part.get('nodes', [])
    sem['edges'] += part.get('edges', [])
    sem['hyperedges'] += part.get('hyperedges', [])
    print(f'  {chunk.name}: {len(part.get("nodes", []))} nodes, '
          f'{len(part.get("edges", []))} edges')
sem['input_tokens'], sem['output_tokens'] = 67000, 10000

# ------------------------------------------------- Part C: merge AST + semantic
seen = {n['id'] for n in ast['nodes']}
merged_nodes = list(ast['nodes'])
for n in sem['nodes']:
    if n['id'] not in seen:
        merged_nodes.append(n)
        seen.add(n['id'])

# The dropped ghost carried the README's reasoning about this file. Keep the
# reasoning, attached to the node that actually represents the file.
RATIONALE = {
    'test_wiring_test':
        'README「測試」節：wiring.test.js 是最容易被忽略但最有用的一組，抓的是'
        '「preload 呼叫了一個沒人註冊的頻道」這種在執行期只會表現成模糊失敗的錯。'
        '有幾條不是斷言註解而是算出來的（三主題的 WCAG 對比、簡報 @page 尺寸）。'
        '實測 165 個測試，全套 362 個全數通過。',
}
for n in merged_nodes:
    if n['id'] in RATIONALE:
        n['rationale'] = RATIONALE[n['id']]

# Guard against re-introducing dangling endpoints from the semantic side.
bad = [e for e in sem['edges'] if e['source'] not in seen or e['target'] not in seen]
if bad:
    raise SystemExit(f'semantic edges with unknown endpoints: {bad[:5]}')

extraction = {
    'nodes': merged_nodes,
    'edges': ast['edges'] + sem['edges'],
    'hyperedges': sem.get('hyperedges', []),
    'input_tokens': sem['input_tokens'],
    'output_tokens': sem['output_tokens'],
}
(OUT / '.graphify_extract.json').write_text(
    json.dumps(extraction, indent=2, ensure_ascii=False), encoding='utf-8')
print(f'Merged: {len(merged_nodes)} nodes, {len(extraction["edges"])} edges '
      f'({len(ast["nodes"])} AST + {len(sem["nodes"])} semantic)')

# ------------------------------------------------ build / cluster / analyze ---
from graphify.build import build_from_json
from graphify.cluster import cluster, score_all
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.export import to_json
from graphify.diagnostics import diagnose_extraction, format_diagnostic_report

G = build_from_json(extraction, root='.', directed=False)
if G.number_of_nodes() == 0:
    raise SystemExit('ERROR: Graph is empty.')

communities = cluster(G)
cohesion = score_all(G, communities)
gods = god_nodes(G)
surprises = surprising_connections(G, communities)
labels = {cid: 'Community ' + str(cid) for cid in communities}
questions = suggest_questions(G, communities, labels)

# The corrected graph is 3 nodes smaller on purpose (2 ghost duplicates + 1
# phantom), so the #479 shrink guard would refuse it. The previous graph is
# backed up first and force is used only for that reason.
gp = OUT / 'graph.json'
if gp.exists():
    shutil.copy2(gp, OUT / 'graph.prev.json')
    print('backed up previous graph.json -> graph.prev.json')
to_json(G, communities, str(gp), force=True)

(OUT / '.graphify_analysis.json').write_text(json.dumps({
    'communities': {str(k): v for k, v in communities.items()},
    'cohesion': {str(k): v for k, v in cohesion.items()},
    'gods': gods, 'surprises': surprises, 'questions': questions,
}, indent=2, ensure_ascii=False), encoding='utf-8')
print(f'Graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges, '
      f'{len(communities)} communities')

summary = diagnose_extraction(extraction, directed=False, root='.')
print(format_diagnostic_report(summary))
flags = [f'{summary[k]} {label}' for k, label in (
    ('dangling_endpoint_edges', 'dangling-endpoint edges'),
    ('missing_endpoint_edges', 'missing-endpoint edges'),
    ('self_loop_edges', 'self-loop edges'),
    ('undirected_same_endpoint_collapsed_edges', 'collapsed (undirected) edges'),
) if summary.get(k, 0)]
print('GRAPH HEALTH WARNING: ' + '; '.join(flags) if flags
      else 'Graph health: OK (no dangling/missing/collapsed edges).')
