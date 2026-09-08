"""The renderer's real dependency graph lives in a global namespace.

app/renderer/index.html:307-309 says the renderer is loaded as classic scripts
with no bundler on purpose. So modules never import each other -- they publish
onto `window.AIOS` and read each other back off it at runtime, and the preload
bridge arrives as `window.aios`. Those are real dependencies (delete
surfaces.js and docs.js stops working) but `AIOS.grid.merge(...)` is a property
access, not an import, so the AST extractor cannot see a single one of them.

That is why the production graph fell into 9 disconnected components with the
test files removed. This pass recovers the edges from the source itself:
every `AIOS.<symbol>` use is attributed to the file that assigns that symbol.
"""
import json
import re
from pathlib import Path

ROOT = Path('.')
RENDERER = ROOT / 'app' / 'renderer'
ABS = str(ROOT.resolve())

DEF_RE = re.compile(r'^\s*(?:window\.)?AIOS\.([A-Za-z_]\w*)\s*=', re.M)
USE_RE = re.compile(r'\bAIOS\.([A-Za-z_]\w*)')
BRIDGE_RE = re.compile(r'\bwindow\.aios\b')
BLOCK_COMMENT = re.compile(r'/\*[\s\S]*?\*/')
LINE_COMMENT = re.compile(r'(?m)//.*$')
STRINGS = re.compile(r"'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|`(?:\\.|[^`\\])*`")


def node_id(p: Path) -> str:
    rel = p.resolve().relative_to(ROOT.resolve()).with_suffix('')
    return '_'.join(re.sub(r'[^a-z0-9]', '_', part.lower()) for part in rel.parts)


def code_only(text: str) -> str:
    """Comments and string bodies blanked, newlines preserved for line numbers."""
    def blank(m):
        return re.sub(r'[^\n]', ' ', m.group(0))
    return LINE_COMMENT.sub(blank, STRINGS.sub(blank, BLOCK_COMMENT.sub(blank, text)))


files = sorted(RENDERER.rglob('*.js'))
raw = {p: p.read_text(encoding='utf-8') for p in files}
code = {p: code_only(t) for p, t in raw.items()}

# symbol -> the file that assigns it
owner = {}
for p, t in code.items():
    for sym in DEF_RE.findall(t):
        owner.setdefault(sym, p)
print(f'{len(owner)} AIOS.* symbols published by '
      f'{len({v for v in owner.values()})} files')

edges = []
pairs = {}
for p, t in code.items():
    lines = t.split('\n')
    for i, line in enumerate(lines, 1):
        for sym in USE_RE.findall(line):
            home = owner.get(sym)
            if home is None or home == p:
                continue          # unknown symbol, or the file's own publication
            key = (node_id(p), node_id(home))
            pairs.setdefault(key, {'syms': set(), 'line': i})
            pairs[key]['syms'].add(sym)

for (src, dst), info in sorted(pairs.items()):
    edges.append({
        'source': src, 'target': dst, 'relation': 'references',
        'confidence': 'EXTRACTED', 'confidence_score': 1.0,
        'source_file': str((ROOT / src.replace('_', '/')).with_suffix('.js')),
        'source_location': f'L{info["line"]} AIOS.' + '/'.join(sorted(info['syms'])[:4]),
        'weight': 1.0,
    })

# The preload bridge: window.aios is contextBridge-exposed by app/preload/index.js.
bridge = []
for p, t in code.items():
    m = BRIDGE_RE.search(t)
    if m:
        line = t[:m.start()].count('\n') + 1
        bridge.append({
            'source': node_id(p), 'target': 'app_preload_index',
            'relation': 'references', 'confidence': 'EXTRACTED',
            'confidence_score': 1.0,
            'source_file': str(p), 'source_location': f'L{line} window.aios',
            'weight': 1.0,
        })
edges += bridge

out = {'nodes': [], 'edges': edges, 'hyperedges': [],
       'input_tokens': 0, 'output_tokens': 0}
Path('graphify-out/.graphify_chunk_02.json').write_text(
    json.dumps(out, indent=2, ensure_ascii=False), encoding='utf-8')

print(f'namespace edges: {len(pairs)}  preload-bridge edges: {len(bridge)}')
print('\nsample:')
for e in edges[:12]:
    print(f'  {e["source"]:32s} -> {e["target"]:28s} {e["source_location"]}')
