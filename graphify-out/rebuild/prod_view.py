"""Two honest views: the whole corpus, and production code only.

wiring.test.js dominates betweenness because it genuinely touches 32 of the
~48 source files. That is a real property, but it buries the production
architecture's own bridges, so both views are worth having.
"""
import json
from pathlib import Path

import networkx as nx

g = json.loads(Path('graphify-out/graph.json').read_text(encoding='utf-8'))
nodes = {n['id']: n for n in g['nodes']}
G = nx.Graph()
G.add_nodes_from(nodes)
for e in g['links']:
    G.add_edge(e['source'], e['target'])

tests = {nid for nid, n in nodes.items()
         if str(n.get('source_file', '')).replace('\\', '/').startswith('test/')}
P = G.subgraph([n for n in G if n not in tests]).copy()

print(f'whole corpus : {G.number_of_nodes()} nodes, {G.number_of_edges()} edges')
print(f'production   : {P.number_of_nodes()} nodes, {P.number_of_edges()} edges '
      f'({len(tests)} test nodes removed)')
print()
print('=== production-only betweenness, top 12 ===')
bt = nx.betweenness_centrality(P)
for nid, v in sorted(bt.items(), key=lambda kv: -kv[1])[:12]:
    n = nodes[nid]
    print(f'  {v:.4f}  {str(n.get("label")):32s} deg={P.degree(nid):3d}  '
          f'{n.get("community_name")}')

print()
print('=== how connected is each file-level node? (top 12 by degree) ===')
files = [nid for nid, n in nodes.items()
         if str(n.get('label', '')).endswith(('.js', '.json'))]
for nid in sorted(files, key=lambda x: -G.degree(x))[:12]:
    n = nodes[nid]
    ext = sum(1 for nb in G.neighbors(nid)
              if nodes[nb].get('source_file') != n.get('source_file'))
    print(f'  deg={G.degree(nid):3d}  cross-file={ext:3d}  {n.get("source_file")}')

print()
print('=== components ===')
comps = sorted(nx.connected_components(G), key=len, reverse=True)
print(f'whole corpus: {len(comps)} components, largest={len(comps[0])}')
pcomps = sorted(nx.connected_components(P), key=len, reverse=True)
print(f'production  : {len(pcomps)} components, largest={len(pcomps[0])}')
print('  production islands >1 node:',
      [sorted(c)[:3] for c in pcomps[1:] if len(c) > 1][:6])
