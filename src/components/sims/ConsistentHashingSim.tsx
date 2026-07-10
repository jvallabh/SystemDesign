import { useMemo, useRef, useState } from 'react';
import { SimFrame } from './SimFrame';
import { Button, Slider, Toggle } from './controls';
import { useRafLoop } from './hooks/useRafLoop';

const W = 640;
const H = 340;
const CX = 170;
const CY = 170;
const RING_R = 118;
const TAU = Math.PI * 2;

const KEY_COUNT = 200;
const MIN_NODES = 2;
const MAX_NODES = 8;
const DEFAULT_NODE_COUNT = 4;
const DEFAULT_VNODES = 1;
const MAX_DOTS = 40;
const DOT_RATE_PER_S = 3.5;
const DOT_TRAVEL_MS = 850;

const NODE_LETTERS = 'ABCDEFGH';
const PALETTE = [
  'var(--accent)',
  'var(--accent-2)',
  'var(--ok)',
  'var(--danger)',
  'var(--text-muted)',
];

/** FNV-1a with a murmur-style avalanche finalizer (raw FNV-1a clusters
 *  badly on strings that differ only in the trailing character). */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function hash01(s: string): number {
  return hash32(s) / 4294967296;
}

const KEY_NAMES: string[] = Array.from({ length: KEY_COUNT }, (_, i) => `key-${i}`);
const KEY_POS: number[] = KEY_NAMES.map(hash01);

/** Angle for a ring position in [0,1); 0 sits at 12 o'clock, clockwise. */
function posToAngle(p: number): number {
  return p * TAU - Math.PI / 2;
}

function ringXY(p: number, r: number): { x: number; y: number } {
  const a = posToAngle(p);
  return { x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) };
}

interface RingNode {
  id: string;
  letter: string;
  color: string;
}

interface Dot {
  t: number; // 0..1 progress from ring center to target marker
  tx: number;
  ty: number;
  color: string;
}

interface World {
  nodes: RingNode[];
  vnodes: number;
  naive: boolean;
  owners: string[]; // per key: owning node id
  remapPct: number | null; // % of keys moved by the last topology change
  dots: Dot[];
  spawnAcc: number;
  version: number; // bumped on every topology change (drives static memo)
}

function makeNode(letter: string): RingNode {
  return {
    id: `node-${letter}`,
    letter,
    color: PALETTE[NODE_LETTERS.indexOf(letter) % PALETTE.length],
  };
}

interface VNode {
  pos: number;
  nodeId: string;
  color: string;
}

/** Vnode 0 sits exactly at the node's marker angle so vnodes=1 matches
 *  the visible "next marker clockwise" rule; extras hash off the id. */
function vnodePositions(nodes: RingNode[], vnodes: number): VNode[] {
  const out: VNode[] = [];
  for (const n of nodes) {
    out.push({ pos: hash01(n.id), nodeId: n.id, color: n.color });
    for (let i = 1; i < vnodes; i++) {
      out.push({ pos: hash01(`${n.id}#${i}`), nodeId: n.id, color: n.color });
    }
  }
  out.sort((a, b) => a.pos - b.pos);
  return out;
}

function computeOwners(nodes: RingNode[], vnodes: number, naive: boolean): string[] {
  if (naive) {
    return KEY_NAMES.map((k) => nodes[hash32(k) % nodes.length].id);
  }
  const ring = vnodePositions(nodes, vnodes);
  return KEY_POS.map((p) => {
    // first vnode clockwise (pos >= p), wrapping to the start
    let lo = 0;
    let hi = ring.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ring[mid].pos >= p) hi = mid;
      else lo = mid + 1;
    }
    return ring[lo === ring.length ? 0 : lo].nodeId;
  });
}

function initWorld(): World {
  const nodes = Array.from({ length: DEFAULT_NODE_COUNT }, (_, i) =>
    makeNode(NODE_LETTERS[i]),
  );
  return {
    nodes,
    vnodes: DEFAULT_VNODES,
    naive: false,
    owners: computeOwners(nodes, DEFAULT_VNODES, false),
    remapPct: null,
    dots: [],
    spawnAcc: 0,
    version: 0,
  };
}

/** Advances only the decorative lookup dots; ownership changes are
 *  user-driven and applied in event handlers. */
function stepWorld(w: World, dtMs: number): void {
  w.spawnAcc += (dtMs / 1000) * DOT_RATE_PER_S;
  while (w.spawnAcc >= 1) {
    w.spawnAcc -= 1;
    if (w.dots.length >= MAX_DOTS) continue;
    const key = Math.floor(Math.random() * KEY_COUNT);
    const owner = w.nodes.find((n) => n.id === w.owners[key]);
    if (!owner) continue;
    const { x, y } = ringXY(hash01(owner.id), RING_R);
    w.dots.push({ t: 0, tx: x, ty: y, color: owner.color });
  }
  for (const d of w.dots) d.t += dtMs / DOT_TRAVEL_MS;
  w.dots = w.dots.filter((d) => d.t < 1);
}

/**
 * Consistent hashing on a ring: nodes and 200 keys placed by hash angle,
 * keys tinted by owner, with virtual nodes and a naive mod-N comparison.
 * The headline readout is the % of keys remapped by the last change.
 */
export default function ConsistentHashingSim() {
  const world = useRef<World>(initWorld());
  const [playing, setPlaying] = useState(true);
  const [vnodes, setVnodes] = useState(DEFAULT_VNODES);
  const [naive, setNaive] = useState(false);
  const [, setTick] = useState(0);

  useRafLoop((dt) => {
    stepWorld(world.current, dt);
    setTick((t) => t + 1);
  }, playing);

  const changeTopology = (mutate: (w: World) => void) => {
    const w = world.current;
    const before = w.owners;
    mutate(w);
    w.owners = computeOwners(w.nodes, w.vnodes, w.naive);
    let moved = 0;
    for (let i = 0; i < KEY_COUNT; i++) {
      if (before[i] !== w.owners[i]) moved++;
    }
    w.remapPct = (moved / KEY_COUNT) * 100;
    w.dots = []; // in-flight lookups may target removed/re-owned nodes
    w.version++;
    setTick((t) => t + 1);
  };

  const addNode = () => {
    const w = world.current;
    if (w.nodes.length >= MAX_NODES) return;
    const letter = [...NODE_LETTERS].find((l) => !w.nodes.some((n) => n.letter === l));
    if (!letter) return;
    changeTopology((wd) => {
      wd.nodes.push(makeNode(letter));
    });
  };

  const removeNode = () => {
    if (world.current.nodes.length <= MIN_NODES) return;
    changeTopology((wd) => {
      wd.nodes.pop();
    });
  };

  const onVnodes = (v: number) => {
    setVnodes(v);
    changeTopology((wd) => {
      wd.vnodes = v;
    });
  };

  const onNaive = (v: boolean) => {
    setNaive(v);
    changeTopology((wd) => {
      wd.naive = v;
    });
  };

  const w = world.current;

  // Per-node key counts and load stats.
  const counts = new Map<string, number>();
  for (const n of w.nodes) counts.set(n.id, 0);
  for (const id of w.owners) counts.set(id, (counts.get(id) ?? 0) + 1);
  const shares = w.nodes.map((n) => ((counts.get(n.id) ?? 0) / KEY_COUNT) * 100);
  const largestShare = shares.length > 0 ? Math.max(...shares) : 0;
  const meanShare = 100 / Math.max(1, w.nodes.length);
  const stddev = Math.sqrt(
    shares.reduce((s, x) => s + (x - meanShare) ** 2, 0) / Math.max(1, shares.length),
  );
  const maxCount = Math.max(1, ...w.nodes.map((n) => counts.get(n.id) ?? 0));

  // Static ring geometry: only changes on topology edits, not per frame.
  const ringStatics = useMemo(() => {
    const colorById = new Map(w.nodes.map((n) => [n.id, n.color]));
    const keyTicks = KEY_POS.map((p, i) => {
      const a = ringXY(p, RING_R - 13);
      const b = ringXY(p, RING_R - 5);
      return (
        <line
          key={i}
          x1={a.x}
          y1={a.y}
          x2={b.x}
          y2={b.y}
          strokeWidth={1.5}
          style={{ stroke: colorById.get(w.owners[i]) ?? 'var(--text-muted)' }}
          opacity={0.85}
        />
      );
    });
    const vnodeTicks = w.naive
      ? []
      : vnodePositions(w.nodes, w.vnodes).map((v, i) => {
          const a = ringXY(v.pos, RING_R + 3);
          const b = ringXY(v.pos, RING_R + 9);
          return (
            <line
              key={i}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              strokeWidth={1}
              style={{ stroke: v.color }}
              opacity={0.55}
            />
          );
        });
    return { keyTicks, vnodeTicks };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, w.version]);

  const barW = 190;
  const barX = 388;
  const rowH = 34;
  const chartTop = 52;
  const evenX = barX + ((KEY_COUNT / w.nodes.length) / maxCount) * barW;

  return (
    <SimFrame
      title="The hash ring"
      playing={playing}
      onPlayPause={() => setPlaying((p) => !p)}
      onReset={() => {
        world.current = initWorld();
        setVnodes(DEFAULT_VNODES);
        setNaive(false);
        setTick((t) => t + 1);
      }}
      controls={
        <>
          <Button onClick={addNode}>Add node ({w.nodes.length}/{MAX_NODES})</Button>
          <Button onClick={removeNode}>Remove node</Button>
          <Slider label="Virtual nodes" value={vnodes} min={1} max={50} onChange={onVnodes} />
          <Toggle label="Naive mod-N" checked={naive} onChange={onNaive} />
        </>
      }
      readouts={[
        {
          label: 'keys remapped',
          value: w.remapPct === null ? '—' : `${w.remapPct.toFixed(1)}%`,
        },
        { label: 'largest share', value: `${largestShare.toFixed(1)}%` },
        { label: 'load stddev', value: `${stddev.toFixed(1)}%` },
      ]}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Consistent hash ring with ${w.nodes.length} nodes and ${KEY_COUNT} keys, plus a bar chart of keys per node`}
      >
        {/* Ring */}
        <circle cx={CX} cy={CY} r={RING_R} fill="none" strokeWidth={2} className="s-border" />
        {ringStatics.keyTicks}
        {ringStatics.vnodeTicks}

        {/* Lookup dots: ring center -> owning node marker */}
        {w.dots.map((d, i) => {
          const p = d.t * (2 - d.t); // ease-out
          return (
            <circle
              key={i}
              cx={CX + (d.tx - CX) * p}
              cy={CY + (d.ty - CY) * p}
              r={3.5}
              style={{ fill: d.color }}
              opacity={1 - d.t * 0.4}
            />
          );
        })}

        {/* Node markers */}
        {w.nodes.map((n) => {
          const { x, y } = ringXY(hash01(n.id), RING_R);
          return (
            <g key={n.id}>
              <circle cx={x} cy={y} r={10} strokeWidth={1} className="s-border" style={{ fill: n.color }} />
              <text x={x} y={y + 4} textAnchor="middle" className="svg-label small" style={{ fill: 'var(--bg)' }}>
                {n.letter}
              </text>
            </g>
          );
        })}

        {/* Center caption */}
        <text x={CX} y={CY - 4} textAnchor="middle" className="svg-label small muted">
          {w.nodes.length} nodes
        </text>
        <text x={CX} y={CY + 14} textAnchor="middle" className="svg-label small muted">
          {w.naive ? 'hash mod N' : 'ring lookup'}
        </text>

        {/* Bar chart: keys per node */}
        <text x={360} y={34} className="svg-label small muted">
          keys per node
        </text>
        <line
          x1={evenX}
          y1={chartTop - 6}
          x2={evenX}
          y2={chartTop + w.nodes.length * rowH - 10}
          strokeWidth={1}
          strokeDasharray="3 3"
          className="s-muted"
          opacity={0.6}
        />
        {w.nodes.map((n, i) => {
          const count = counts.get(n.id) ?? 0;
          const width = (count / maxCount) * barW;
          const y = chartTop + i * rowH;
          return (
            <g key={n.id}>
              <text x={364} y={y + 14} className="svg-label small muted">
                {n.letter}
              </text>
              <rect x={barX} y={y} width={Math.max(1, width)} height={18} rx={3} style={{ fill: n.color }} opacity={0.85} />
              <text x={barX + Math.max(1, width) + 6} y={y + 14} className="svg-label small">
                {count}
              </text>
            </g>
          );
        })}
      </svg>
    </SimFrame>
  );
}
