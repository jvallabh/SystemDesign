import { useRef, useState } from 'react';
import { SimFrame } from './SimFrame';
import { Button, SegmentedControl, Slider } from './controls';
import { useRafLoop } from './hooks/useRafLoop';

const W = 640;
const H = 340;
const MARGIN = 16;
const GAP = 10;
const BOX_TOP = 205;
const BOX_H = 115;
const BAR_BOTTOM = BOX_TOP + BOX_H - 4; // 316
const BAR_MAX_H = 76;
const FALL_Y0 = 26;
const DELIVER_Y = BOX_TOP - 8;
const BURST_Y = BOX_TOP - 6;

const MAX_SHARDS = 8;
const CAP_KEYS = 400; // stored keys are FIFO-evicted past this
const PRELOAD = 120;
const RATE = 7; // writes per second
const FALL_MS = 900;
const BURST_MS = 620;
const MAX_FALLING = 22;
const MAX_BURSTS = 40;
const KEY_SPACE = 100000;

type Scheme = 'range' | 'hash';
type Pattern = 'uniform' | 'skewed' | 'sequential';

interface StoredKey {
  name: string;
  hash: number;
  sortVal: number;
  shard: number;
}

interface FallingKey {
  name: string;
  hash: number;
  sortVal: number;
  x: number;
  y: number;
  t: number;
}

interface Burst {
  x0: number;
  x1: number;
  arc: number;
  t: number; // starts negative for stagger
}

interface World {
  n: number;
  scheme: Scheme;
  /** n-1 ascending range cut points; shard i holds [cuts[i-1], cuts[i]), last shard unbounded above. */
  cuts: number[];
  keys: StoredKey[];
  counts: number[];
  /** Per-shard exponentially-decayed write counter (~writes/sec over a 1s window). */
  heat: number[];
  falling: FallingKey[];
  bursts: Burst[];
  seq: number;
  spawnAcc: number;
  lastMovedPct: number | null;
  rng: () => number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Zipf-ish hot set: key k gets weight 1/(k+1); 80% of skewed writes hit this set.
const HOT_IDS = [8412, 23077, 41250, 56901, 73344, 91580];
const HOT_CUM = (() => {
  const wts = HOT_IDS.map((_, i) => 1 / (i + 1));
  const sum = wts.reduce((a, b) => a + b, 0);
  let acc = 0;
  return wts.map((x) => (acc += x / sum));
})();

function evenCuts(n: number): number[] {
  return Array.from({ length: n - 1 }, (_, i) => (i + 1) / n);
}

function rangeIndex(cuts: number[], v: number): number {
  for (let i = 0; i < cuts.length; i++) {
    if (v < cuts[i]) return i;
  }
  return cuts.length;
}

function shardOf(w: World, hash: number, sortVal: number): number {
  return w.scheme === 'hash' ? hash % w.n : rangeIndex(w.cuts, sortVal);
}

function shardRect(n: number, i: number): { x: number; bw: number } {
  const bw = (W - 2 * MARGIN - (n - 1) * GAP) / n;
  return { x: MARGIN + i * (bw + GAP), bw };
}

function shardCenterX(n: number, i: number): number {
  const { x, bw } = shardRect(n, i);
  return x + bw / 2;
}

function genKey(w: World, pattern: Pattern): { name: string; hash: number; sortVal: number } {
  let name: string;
  let sortVal: number;
  if (pattern === 'sequential') {
    w.seq += 1;
    name = `evt_${String(w.seq).padStart(6, '0')}`;
    // Monotonic sort value above every range cut => always the last shard.
    sortVal = 1 + w.seq * 0.001;
  } else {
    let id: number;
    if (pattern === 'skewed' && w.rng() < 0.8) {
      const r = w.rng();
      let idx = HOT_IDS.length - 1;
      for (let i = 0; i < HOT_CUM.length; i++) {
        if (r < HOT_CUM[i]) {
          idx = i;
          break;
        }
      }
      id = HOT_IDS[idx];
    } else {
      id = Math.floor(w.rng() * KEY_SPACE);
    }
    name = `u_${String(id).padStart(5, '0')}`;
    sortVal = id / KEY_SPACE;
  }
  return { name, hash: fnv1a(name), sortVal };
}

function deliver(w: World, k: { name: string; hash: number; sortVal: number }): void {
  const shard = shardOf(w, k.hash, k.sortVal);
  w.keys.push({ name: k.name, hash: k.hash, sortVal: k.sortVal, shard });
  w.counts[shard] += 1;
  w.heat[shard] += 1;
  while (w.keys.length > CAP_KEYS) {
    const old = w.keys.shift();
    if (old) w.counts[old.shard] -= 1;
  }
}

function reassignAll(w: World): void {
  w.counts = new Array<number>(w.n).fill(0);
  for (const k of w.keys) {
    k.shard = shardOf(w, k.hash, k.sortVal);
    w.counts[k.shard] += 1;
  }
}

function initWorld(n: number, scheme: Scheme, pattern: Pattern): World {
  const w: World = {
    n,
    scheme,
    cuts: evenCuts(n),
    keys: [],
    counts: new Array<number>(n).fill(0),
    heat: new Array<number>(n).fill(0),
    falling: [],
    bursts: [],
    seq: 0,
    spawnAcc: 0,
    lastMovedPct: null,
    rng: mulberry32(0xc0ffee),
  };
  for (let i = 0; i < PRELOAD; i++) {
    deliver(w, genKey(w, pattern));
  }
  w.heat.fill(0); // preloaded data is "at rest", not recent writes
  return w;
}

function stepWorld(w: World, dtMs: number, pattern: Pattern): void {
  const decay = Math.exp(-dtMs / 1000);
  for (let i = 0; i < w.n; i++) w.heat[i] *= decay;

  w.spawnAcc += (RATE * dtMs) / 1000;
  while (w.spawnAcc >= 1) {
    w.spawnAcc -= 1;
    if (w.falling.length >= MAX_FALLING) {
      const oldest = w.falling.shift();
      if (oldest) deliver(w, oldest);
    }
    const k = genKey(w, pattern);
    w.falling.push({ ...k, x: W / 2 + (w.rng() - 0.5) * 240, y: FALL_Y0, t: 0 });
  }

  const still: FallingKey[] = [];
  for (const fk of w.falling) {
    fk.t += dtMs / FALL_MS;
    // Home toward the current owner shard so live param changes retarget mid-flight.
    const cx = shardCenterX(w.n, shardOf(w, fk.hash, fk.sortVal));
    fk.x += (cx - fk.x) * (1 - Math.exp(-dtMs / 160));
    const e = Math.min(1, fk.t);
    fk.y = FALL_Y0 + (DELIVER_Y - FALL_Y0) * e * e;
    if (fk.t >= 1) deliver(w, fk);
    else still.push(fk);
  }
  w.falling = still;

  const alive: Burst[] = [];
  for (const b of w.bursts) {
    b.t += dtMs / BURST_MS;
    if (b.t < 1) alive.push(b);
  }
  w.bursts = alive;
}

/** Slider-driven shard count change: even ranges, everything reassigned, no "moved" stat. */
function reconcileShards(w: World, n: number): void {
  w.n = n;
  w.cuts = evenCuts(n);
  w.heat = Array.from({ length: n }, (_, i) => w.heat[i] ?? 0);
  w.bursts = [];
  reassignAll(w);
}

/**
 * Reshard N -> N+1. Range: split the fullest shard at the median of its stored
 * keys (only that shard's upper half moves). Hash: rehash everything mod N+1
 * (roughly N/(N+1) of keys move).
 */
function reshard(w: World): void {
  if (w.n >= MAX_SHARDS) return;
  const total = w.keys.length;
  const oldShard = w.keys.map((k) => k.shard);
  let splitIdx = 0;

  if (w.scheme === 'range') {
    for (let i = 1; i < w.n; i++) {
      if (w.counts[i] > w.counts[splitIdx]) splitIdx = i;
    }
    const lo = splitIdx === 0 ? 0 : w.cuts[splitIdx - 1];
    const hi = splitIdx === w.n - 1 ? Number.POSITIVE_INFINITY : w.cuts[splitIdx];
    const vals = w.keys
      .filter((k) => k.shard === splitIdx)
      .map((k) => k.sortVal)
      .sort((a, b) => a - b);
    let cut: number;
    if (vals.length > 0) {
      cut = vals[Math.floor(vals.length / 2)];
      if (cut <= lo || cut >= hi) {
        cut = (lo + (Number.isFinite(hi) ? hi : vals[vals.length - 1] + 1)) / 2;
      }
    } else {
      cut = (lo + (Number.isFinite(hi) ? hi : lo + 1)) / 2;
    }
    w.cuts.splice(splitIdx, 0, cut);
    w.n += 1;
    w.heat.splice(splitIdx + 1, 0, 0);
  } else {
    w.n += 1;
    w.cuts = evenCuts(w.n);
    w.heat.push(0);
  }

  let moved = 0;
  const bursts: Burst[] = [];
  w.keys.forEach((k, i) => {
    const ns = shardOf(w, k.hash, k.sortVal);
    const os = oldShard[i];
    // Range: shards above the split only get renumbered; data doesn't move.
    const didMove = w.scheme === 'range' ? os === splitIdx && ns === splitIdx + 1 : ns !== os;
    k.shard = ns;
    if (didMove) {
      moved += 1;
      if (bursts.length < MAX_BURSTS) {
        bursts.push({
          x0: shardCenterX(w.n, w.scheme === 'range' ? splitIdx : os) + (w.rng() - 0.5) * 20,
          x1: shardCenterX(w.n, ns) + (w.rng() - 0.5) * 20,
          arc: 55 + w.rng() * 50,
          t: -w.rng() * 0.35,
        });
      }
    }
  });
  w.counts = new Array<number>(w.n).fill(0);
  for (const k of w.keys) w.counts[k.shard] += 1;
  w.bursts = bursts;
  w.lastMovedPct = total > 0 ? (moved / total) * 100 : 0;
}

function fmtCut(v: number): string {
  return v >= 10 ? v.toFixed(0) : v.toFixed(2);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const DEFAULT_SHARDS = 4;
const DEFAULT_SCHEME: Scheme = 'range';
const DEFAULT_PATTERN: Pattern = 'uniform';

/**
 * Shard hot-spot lab: keys fall from a write stream into range- or
 * hash-partitioned shards. Sequential keys pile onto the last range shard,
 * hashing spreads them, skewed (zipf-ish) keys stay hot even under hash,
 * and resharding shows range splits moving far fewer keys than a rehash.
 */
export default function ShardingSim() {
  const world = useRef<World>(initWorld(DEFAULT_SHARDS, DEFAULT_SCHEME, DEFAULT_PATTERN));
  const [playing, setPlaying] = useState(true);
  const [scheme, setScheme] = useState<Scheme>(DEFAULT_SCHEME);
  const [pattern, setPattern] = useState<Pattern>(DEFAULT_PATTERN);
  const [shards, setShards] = useState(DEFAULT_SHARDS);
  const [, setTick] = useState(0);

  useRafLoop((dt) => {
    stepWorld(world.current, dt, pattern);
    setTick((t) => t + 1);
  }, playing);

  const w = world.current;

  const changeScheme = (v: Scheme) => {
    w.scheme = v;
    reassignAll(w);
    setScheme(v);
    setTick((t) => t + 1);
  };

  const changeShards = (v: number) => {
    reconcileShards(w, v);
    setShards(v);
    setTick((t) => t + 1);
  };

  const handleReshard = () => {
    if (w.n >= MAX_SHARDS) return;
    reshard(w);
    setShards(w.n);
    setTick((t) => t + 1);
  };

  // Readouts
  const heatSum = w.heat.reduce((a, b) => a + b, 0);
  const heatMax = w.heat.reduce((a, b) => Math.max(a, b), 0);
  const hotShare = heatSum > 0.05 ? `${Math.round((heatMax / heatSum) * 100)}%` : '—';
  const maxCount = w.counts.reduce((a, b) => Math.max(a, b), 0);
  const avgCount = w.n > 0 ? w.keys.length / w.n : 0;
  const imbalance = avgCount > 0 ? `${(maxCount / avgCount).toFixed(2)}×` : '—';
  const movedStr = w.lastMovedPct === null ? '—' : `${Math.round(w.lastMovedPct)}%`;

  const capPerShard = Math.max(1, Math.round((CAP_KEYS * 1.5) / w.n));

  return (
    <SimFrame
      title="Shard hot-spot lab"
      playing={playing}
      onPlayPause={() => setPlaying((p) => !p)}
      onReset={() => {
        world.current = initWorld(shards, scheme, pattern);
        setTick((t) => t + 1);
      }}
      controls={
        <>
          <SegmentedControl<Scheme>
            label="Scheme"
            value={scheme}
            options={[
              { value: 'range', label: 'Range' },
              { value: 'hash', label: 'Hash' },
            ]}
            onChange={changeScheme}
          />
          <SegmentedControl<Pattern>
            label="Key pattern"
            value={pattern}
            options={[
              { value: 'uniform', label: 'Uniform' },
              { value: 'skewed', label: 'Skewed' },
              { value: 'sequential', label: 'Sequential' },
            ]}
            onChange={setPattern}
          />
          <Slider label="Shards" value={shards} min={2} max={MAX_SHARDS} onChange={changeShards} />
          <Button onClick={handleReshard}>Reshard +1</Button>
        </>
      }
      readouts={[
        { label: 'hottest write share', value: hotShare },
        { label: 'imbalance (max/avg)', value: imbalance },
        { label: 'last reshard moved', value: movedStr },
        { label: 'keys stored', value: w.keys.length },
      ]}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Keys falling from a write stream into shard boxes; bar height shows stored keys and red tint shows write heat"
      >
        <rect x="1" y="1" width={W - 2} height={H - 2} rx="8" fill="none" className="s-border" />
        <text x={MARGIN} y={16} className="svg-label small muted">
          write stream
        </text>

        {/* Shards */}
        {Array.from({ length: w.n }, (_, i) => {
          const { x, bw } = shardRect(w.n, i);
          const share = heatSum > 0.5 ? w.heat[i] / heatSum : 1 / w.n;
          const heatFrac = Math.max(0, Math.min(1, (share - 1 / w.n) / (1 - 1 / w.n)));
          const barH = Math.min(1, w.counts[i] / capPerShard) * BAR_MAX_H;
          const lo = i === 0 ? 0 : w.cuts[i - 1];
          const sub =
            w.scheme === 'range'
              ? `${fmtCut(lo)}–${i === w.n - 1 ? '∞' : fmtCut(w.cuts[i])}`
              : `h%${w.n}=${i}`;
          return (
            <g key={i}>
              <rect
                x={x}
                y={BOX_TOP}
                width={bw}
                height={BOX_H}
                rx="6"
                style={{
                  fill: `color-mix(in srgb, var(--danger) ${Math.round(heatFrac * 35)}%, var(--bg-inset))`,
                  stroke: `color-mix(in srgb, var(--danger) ${Math.round(heatFrac * 80)}%, var(--border))`,
                }}
              />
              <text x={x + bw / 2} y={BOX_TOP + 15} textAnchor="middle" className="svg-label small">
                S{i}
              </text>
              <text
                x={x + bw / 2}
                y={BOX_TOP + 29}
                textAnchor="middle"
                className="svg-label small muted"
              >
                {sub}
              </text>
              <rect
                x={x + 4}
                y={BAR_BOTTOM - barH}
                width={bw - 8}
                height={barH}
                rx="2"
                style={{
                  fill: `color-mix(in srgb, var(--danger) ${Math.round(heatFrac * 100)}%, var(--accent))`,
                  opacity: 0.85,
                }}
              />
              <text
                x={x + bw / 2}
                y={BOX_TOP + BOX_H + 14}
                textAnchor="middle"
                className="svg-label small muted"
              >
                {w.counts[i]}
              </text>
            </g>
          );
        })}

        {/* Falling keys */}
        {w.falling.map((fk, i) => {
          const fade = fk.t > 0.85 ? Math.max(0, (1 - fk.t) / 0.15) : 1;
          return (
            <g key={`${fk.name}-${i}`} opacity={fade}>
              <circle cx={fk.x} cy={fk.y} r="3" className="f-accent" />
              <text x={fk.x} y={fk.y - 6} textAnchor="middle" className="svg-label small">
                {fk.name}
              </text>
            </g>
          );
        })}

        {/* Reshard migration burst */}
        {w.bursts.map((b, i) => {
          if (b.t <= 0) return null;
          const e = Math.min(1, b.t);
          const bx = b.x0 + (b.x1 - b.x0) * e;
          const by = BURST_Y - b.arc * 4 * e * (1 - e);
          return <circle key={i} cx={bx} cy={by} r="3" className="f-accent-2" />;
        })}
      </svg>
    </SimFrame>
  );
}
