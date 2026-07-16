/**
 * Node-type catalog + presets for the Design Studio.
 * Pure data (no React). Consumed by the engine, the palette, and the inspector.
 */
import type { Graph, GraphNode, NodeParams, NodeType, Strategy } from './engine';

export interface ParamSpec {
  key: 'capacity' | 'instances' | 'hitRatio' | 'queueCap';
  label: string;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
}

export interface NodeTypeInfo {
  type: NodeType;
  label: string;
  /** Short glyph drawn inside the node box. */
  short: string;
  blurb: string;
  defaults: NodeParams;
  /** Numeric params exposed in the inspector. */
  params: ParamSpec[];
  /** Whether to show the LB strategy control. */
  strategy: boolean;
}

const base: NodeParams = {
  capacity: 100,
  instances: 1,
  hitRatio: 0,
  queueCap: 40,
  strategy: 'rr',
};

const perS = (v: number) => `${Math.round(v)}/s`;

export const CATALOG: NodeTypeInfo[] = [
  {
    type: 'source',
    label: 'Traffic Source',
    short: 'SRC',
    blurb: 'Generates requests at the global traffic rate.',
    defaults: { ...base, capacity: 1, queueCap: 1 },
    params: [],
    strategy: false,
  },
  {
    type: 'lb',
    label: 'Load Balancer',
    short: 'LB',
    blurb: 'Routes each request to a healthy successor by strategy.',
    defaults: { ...base, capacity: 1000, queueCap: 60 },
    params: [],
    strategy: true,
  },
  {
    type: 'app',
    label: 'App Server',
    short: 'APP',
    blurb: 'Handles requests; scale out with instances (M/M/c).',
    defaults: { ...base, capacity: 50, instances: 3, queueCap: 30 },
    params: [
      { key: 'instances', label: 'Instances', min: 1, max: 8, step: 1, format: (v) => `×${v}` },
      { key: 'capacity', label: 'Capacity / instance', min: 10, max: 200, step: 5, format: perS },
    ],
    strategy: false,
  },
  {
    type: 'cache',
    label: 'Cache',
    short: 'CACHE',
    blurb: 'Serves hits instantly; misses fall through to the successor.',
    defaults: { ...base, capacity: 500, hitRatio: 0.8, queueCap: 60 },
    params: [
      {
        key: 'hitRatio',
        label: 'Hit ratio',
        min: 0,
        max: 1,
        step: 0.05,
        format: (v) => `${Math.round(v * 100)}%`,
      },
      { key: 'capacity', label: 'Capacity', min: 50, max: 1000, step: 50, format: perS },
    ],
    strategy: false,
  },
  {
    type: 'db',
    label: 'Database',
    short: 'DB',
    blurb: 'The durable backing store — usually the bottleneck.',
    defaults: { ...base, capacity: 60, queueCap: 30 },
    params: [
      { key: 'capacity', label: 'Capacity', min: 10, max: 300, step: 10, format: perS },
      { key: 'queueCap', label: 'Queue depth', min: 5, max: 200, step: 5 },
    ],
    strategy: false,
  },
  {
    type: 'queue',
    label: 'Queue',
    short: 'QUE',
    blurb: 'Buffers bursts and decouples producers from a slow consumer.',
    defaults: { ...base, capacity: 80, queueCap: 200 },
    params: [
      { key: 'capacity', label: 'Drain rate', min: 10, max: 300, step: 10, format: perS },
      { key: 'queueCap', label: 'Buffer depth', min: 20, max: 500, step: 20 },
    ],
    strategy: false,
  },
];

export const INFO: Record<NodeType, NodeTypeInfo> = CATALOG.reduce(
  (acc, info) => {
    acc[info.type] = info;
    return acc;
  },
  {} as Record<NodeType, NodeTypeInfo>,
);

export const STRATEGIES: { value: Strategy; label: string }[] = [
  { value: 'rr', label: 'Round robin' },
  { value: 'lc', label: 'Least conn' },
  { value: 'p2c', label: '2 choices' },
  { value: 'rand', label: 'Random' },
];

/** A fresh graph node of the given type with default params. */
export function makeGraphNode(type: NodeType, x: number, y: number, id: string): GraphNode {
  return { id, type, x, y, params: { ...INFO[type].defaults } };
}

// --- presets -----------------------------------------------------------------

interface PresetSpec {
  type: NodeType;
  x: number;
  y: number;
  overrides?: Partial<NodeParams>;
}

function buildGraph(specs: PresetSpec[], links: [number, number][]): Graph {
  const nodes: GraphNode[] = specs.map((s, i) => {
    const g = makeGraphNode(s.type, s.x, s.y, `n${i}`);
    if (s.overrides) g.params = { ...g.params, ...s.overrides };
    return g;
  });
  const edges = links.map(([a, b]) => ({ from: `n${a}`, to: `n${b}` }));
  return { nodes, edges };
}

const COL = [40, 220, 400, 580, 760];
const ROW = 210;

export interface Preset {
  name: string;
  blurb: string;
  rate: number;
  graph: Graph;
}

export const PRESETS: Preset[] = [
  {
    name: 'Read-heavy web app',
    blurb: 'Source → LB → App×3 → Cache → DB. The classic read path.',
    rate: 120,
    graph: buildGraph(
      [
        { type: 'source', x: COL[0], y: ROW },
        { type: 'lb', x: COL[1], y: ROW },
        { type: 'app', x: COL[2], y: ROW, overrides: { instances: 3 } },
        { type: 'cache', x: COL[3], y: ROW, overrides: { hitRatio: 0.8 } },
        { type: 'db', x: COL[4], y: ROW },
      ],
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 4],
      ],
    ),
  },
  {
    name: 'Write-heavy pipeline',
    blurb: 'Source → App×2 → Queue → DB. A buffer absorbs the write burst.',
    rate: 90,
    graph: buildGraph(
      [
        { type: 'source', x: COL[0], y: ROW },
        { type: 'app', x: COL[1], y: ROW, overrides: { instances: 2 } },
        { type: 'queue', x: COL[2], y: ROW },
        { type: 'db', x: COL[3], y: ROW },
      ],
      [
        [0, 1],
        [1, 2],
        [2, 3],
      ],
    ),
  },
  {
    name: 'No-cache baseline',
    blurb: 'Source → LB → App×2 → DB. Watch the DB saturate without a cache.',
    rate: 90,
    graph: buildGraph(
      [
        { type: 'source', x: COL[0], y: ROW },
        { type: 'lb', x: COL[1], y: ROW },
        { type: 'app', x: COL[2], y: ROW, overrides: { instances: 2 } },
        { type: 'db', x: COL[3], y: ROW },
      ],
      [
        [0, 1],
        [1, 2],
        [2, 3],
      ],
    ),
  },
];

export const DEFAULT_PRESET = PRESETS[0];
