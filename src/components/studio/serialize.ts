/**
 * Compact, human-readable, base-path-safe graph ↔ URL encoding for the Studio.
 *
 * Format: `1;<nodes>;<edges>` where nodes are joined by `~` and edges by `~`.
 * Each node: a 1-char type code, quantized x/y (÷10), then positional params.
 * Each edge: `fromIndex-toIndex`. Node ids collapse to array index. Example:
 *   1;S,4,21~L,22,21,0~A,40,21,3,50~C,58,21,80,500~D,76,21,60;0-1~1-2~2-3~3-4
 */
import { CODE_TYPE, TYPE_CODE } from './engine';
import type { Edge, Graph, GraphNode, NodeParams, Strategy } from './engine';
import { INFO, STRATEGIES } from './nodes';
import { withBase } from '../../utils/url';

const STRAT_ORDER: Strategy[] = STRATEGIES.map((s) => s.value);

function num(s: string | undefined): number {
  const v = Number(s);
  if (!Number.isFinite(v)) throw new Error(`bad number: ${s}`);
  return v;
}

export function encode(graph: Graph): string {
  const q = (v: number) => Math.round(v / 10);
  const stratIndex = (s: Strategy) => Math.max(0, STRAT_ORDER.indexOf(s));

  const nodeStr = graph.nodes.map((n) => {
    const p = n.params;
    const head = `${TYPE_CODE[n.type]},${q(n.x)},${q(n.y)}`;
    switch (n.type) {
      case 'lb':
        return `${head},${stratIndex(p.strategy)}`;
      case 'app':
        return `${head},${p.instances},${Math.round(p.capacity)}`;
      case 'cache':
        return `${head},${Math.round(p.hitRatio * 100)},${Math.round(p.capacity)}`;
      case 'db':
        return `${head},${Math.round(p.capacity)}`;
      case 'queue':
        return `${head},${Math.round(p.capacity)},${Math.round(p.queueCap)}`;
      default:
        return head; // source
    }
  });

  const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const edgeStr = graph.edges
    .map((e) => `${index.get(e.from)}-${index.get(e.to)}`)
    .filter((s) => !s.includes('undefined'));

  return `1;${nodeStr.join('~')};${edgeStr.join('~')}`;
}

export function decode(str: string): Graph {
  const parts = str.split(';');
  if (parts.length < 2 || parts[0] !== '1') throw new Error('bad version');

  const nodeTokens = parts[1] ? parts[1].split('~') : [];
  const edgeTokens = parts[2] ? parts[2].split('~') : [];

  const nodes: GraphNode[] = nodeTokens.map((tok, i) => {
    const f = tok.split(',');
    const type = CODE_TYPE[f[0]];
    if (!type) throw new Error(`bad node code: ${f[0]}`);
    const params: NodeParams = { ...INFO[type].defaults };
    switch (type) {
      case 'lb':
        params.strategy = STRAT_ORDER[num(f[3])] ?? 'rr';
        break;
      case 'app':
        params.instances = num(f[3]);
        params.capacity = num(f[4]);
        break;
      case 'cache':
        params.hitRatio = num(f[3]) / 100;
        params.capacity = num(f[4]);
        break;
      case 'db':
        params.capacity = num(f[3]);
        break;
      case 'queue':
        params.capacity = num(f[3]);
        params.queueCap = num(f[4]);
        break;
      default:
        break; // source
    }
    return { id: `n${i}`, type, x: num(f[1]) * 10, y: num(f[2]) * 10, params };
  });

  const edges: Edge[] = [];
  for (const tok of edgeTokens) {
    if (!tok) continue;
    const a = parseInt(tok.split('-')[0], 10);
    const b = parseInt(tok.split('-')[1], 10);
    if (a >= 0 && a < nodes.length && b >= 0 && b < nodes.length && a !== b) {
      edges.push({ from: nodes[a].id, to: nodes[b].id });
    }
  }

  return { nodes, edges };
}

/** Full shareable URL for a graph (base-path-safe). */
export function shareUrl(graph: Graph): string {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return `${origin}${withBase('/studio/')}?d=${encodeURIComponent(encode(graph))}`;
}

/** Read a graph from the current URL's `?d=`, or null if absent/malformed. */
export function readGraphFromLocation(): Graph | null {
  if (typeof location === 'undefined') return null;
  const d = new URLSearchParams(location.search).get('d');
  if (!d) return null;
  try {
    return decode(d);
  } catch {
    return null;
  }
}
