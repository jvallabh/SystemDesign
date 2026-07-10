import { useRef, useState, type ReactNode } from 'react';
import { SimFrame } from './SimFrame';
import { Button, Slider } from './controls';
import { useRafLoop } from './hooks/useRafLoop';

const W = 640;
const H = 340;

const COLS = 32;
const CELL = 17;
const PITCH = 19;
const GRID_X = (W - COLS * PITCH + (PITCH - CELL)) / 2;
const GRID_Y = 96;

const KEY_X = W / 2;
const KEY_Y = 38;
const LINES_Y = 46;

/** How long the hash lines / cell highlight / FP flash stay visible. */
const FLASH_MS = 1100;

/** Auto-mode event periods (ms). */
const INSERT_EVERY_MS = 1000;
const GHOST_EVERY_MS = 500;
const SEEN_EVERY_MS = 3000;

/** Hard cap on the inserted-key list; the filter saturates long before this. */
const MAX_INSERTED = 1024;

type EventKind = 'insert' | 'absent' | 'present' | 'fp';

interface SimEvent {
  kind: EventKind;
  key: string;
  cells: number[];
  ageMs: number;
}

interface Stats {
  unseenQueries: number;
  falsePositives: number;
}

interface World {
  m: number;
  k: number;
  bits: Uint8Array;
  bitsSet: number;
  inserted: string[];
  nextUserId: number;
  nextGhostId: number;
  stats: Stats;
  lastEvent: SimEvent | null;
  insertAccumMs: number;
  ghostAccumMs: number;
  seenAccumMs: number;
}

/**
 * 32-bit FNV-1a with a seed folded into the offset basis, plus an
 * avalanche finalizer (murmur3 fmix32). The finalizer matters: raw
 * FNV-1a's low bit is linear in the seed (xor flips parity, the odd
 * prime multiply preserves it), and `% m` with power-of-two m keeps
 * only low bits — without mixing, the k seeded hashes have fixed
 * parity relationships and the observed FP rate runs ~2x predicted.
 */
function fnv1a(str: string, seed: number): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** The k target bit indices for a key: FNV-1a under k seed variants. */
function hashIndices(key: string, k: number, m: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < k; i++) {
    out.push(fnv1a(key, Math.imul(i + 1, 0x9e3779b9) >>> 0) % m);
  }
  return out;
}

function initWorld(m: number, k: number): World {
  return {
    m,
    k,
    bits: new Uint8Array(m),
    bitsSet: 0,
    inserted: [],
    nextUserId: 1,
    nextGhostId: 1,
    stats: { unseenQueries: 0, falsePositives: 0 },
    lastEvent: null,
    insertAccumMs: 0,
    ghostAccumMs: 0,
    seenAccumMs: 0,
  };
}

/** Resize m/k in place: fresh bit array, reinsert every tracked key. */
function rebuildFilter(w: World, m: number, k: number): void {
  w.m = m;
  w.k = k;
  w.bits = new Uint8Array(m);
  w.bitsSet = 0;
  for (const key of w.inserted) {
    for (const c of hashIndices(key, k, m)) {
      if (!w.bits[c]) {
        w.bits[c] = 1;
        w.bitsSet++;
      }
    }
  }
  // Observed-FP stats were sampled under the old geometry; restart the sample.
  w.stats.unseenQueries = 0;
  w.stats.falsePositives = 0;
  // Old event cell indices are meaningless against the new array.
  w.lastEvent = null;
}

function insertKey(w: World): void {
  if (w.inserted.length >= MAX_INSERTED) return;
  const key = `user-${w.nextUserId++}`;
  const cells = hashIndices(key, w.k, w.m);
  for (const c of cells) {
    if (!w.bits[c]) {
      w.bits[c] = 1;
      w.bitsSet++;
    }
  }
  w.inserted.push(key);
  w.lastEvent = { kind: 'insert', key, cells, ageMs: 0 };
}

/**
 * Query a key from the ghost-* namespace, which is disjoint from user-*
 * and therefore guaranteed never inserted: any "all bits set" answer
 * is a genuine false positive.
 */
function queryGhost(w: World): void {
  const key = `ghost-${w.nextGhostId++}`;
  const cells = hashIndices(key, w.k, w.m);
  const allSet = cells.every((c) => w.bits[c] === 1);
  w.stats.unseenQueries++;
  if (allSet) w.stats.falsePositives++;
  w.lastEvent = { kind: allSet ? 'fp' : 'absent', key, cells, ageMs: 0 };
}

/**
 * Re-query a key we really did insert, so the "present (was inserted)"
 * outcome is visible too. Not counted in the unseen-query stats.
 */
function querySeen(w: World): void {
  if (w.inserted.length === 0) return;
  const key = w.inserted[Math.floor(Math.random() * w.inserted.length)];
  const cells = hashIndices(key, w.k, w.m);
  w.lastEvent = { kind: 'present', key, cells, ageMs: 0 };
}

function stepWorld(w: World, dtMs: number): void {
  if (w.lastEvent) w.lastEvent.ageMs += dtMs;

  w.insertAccumMs += dtMs;
  while (w.insertAccumMs >= INSERT_EVERY_MS) {
    w.insertAccumMs -= INSERT_EVERY_MS;
    insertKey(w);
  }

  w.ghostAccumMs += dtMs;
  while (w.ghostAccumMs >= GHOST_EVERY_MS) {
    w.ghostAccumMs -= GHOST_EVERY_MS;
    queryGhost(w);
  }

  w.seenAccumMs += dtMs;
  while (w.seenAccumMs >= SEEN_EVERY_MS) {
    w.seenAccumMs -= SEEN_EVERY_MS;
    querySeen(w);
  }
}

const KIND_COLOR: Record<EventKind, string> = {
  insert: 'var(--accent-2)',
  absent: 'var(--text-muted)',
  present: 'var(--ok)',
  fp: 'var(--danger)',
};

function eventText(e: SimEvent): string {
  switch (e.kind) {
    case 'insert':
      return `inserted ${e.key}`;
    case 'absent':
      return `queried ${e.key} → definitely absent`;
    case 'present':
      return `queried ${e.key} → present (was inserted)`;
    case 'fp':
      return `queried ${e.key} → MAYBE present — FALSE POSITIVE`;
  }
}

function cellCenterX(i: number): number {
  return GRID_X + (i % COLS) * PITCH + CELL / 2;
}

function cellTopY(i: number): number {
  return GRID_Y + Math.floor(i / COLS) * PITCH;
}

/**
 * Bloom filter false-positive hunt: an m-bit array you can interrogate.
 * Inserts land k hashed bits; queries against a never-inserted "ghost"
 * namespace expose false positives as the array fills, making the
 * m/k/n trade-off visible.
 */
export default function BloomFiltersSim() {
  const world = useRef<World>(initWorld(128, 4));
  const [playing, setPlaying] = useState(true);
  const [m, setM] = useState(128);
  const [k, setK] = useState(4);
  const [, setTick] = useState(0);

  useRafLoop((dt) => {
    stepWorld(world.current, dt);
    setTick((t) => t + 1);
  }, playing);

  const w = world.current;
  const bump = () => setTick((t) => t + 1);

  const n = w.inserted.length;
  const bitsSetPct = (w.bitsSet / w.m) * 100;
  const predictedPct = Math.pow(1 - Math.exp((-w.k * n) / w.m), w.k) * 100;
  const { unseenQueries, falsePositives } = w.stats;
  const observed =
    unseenQueries > 0 ? `${((falsePositives / unseenQueries) * 100).toFixed(1)}%` : '—';

  const ev = w.lastEvent;
  const flashOn = ev !== null && ev.ageMs < FLASH_MS;
  const flashAlpha = ev ? Math.max(0, 1 - ev.ageMs / FLASH_MS) : 0;
  const evColor = ev ? KIND_COLOR[ev.kind] : 'var(--text-muted)';
  const fpCells = ev && ev.kind === 'fp' && flashOn ? new Set(ev.cells) : null;
  const hotCells = ev && flashOn ? new Set(ev.cells) : null;

  const rows = w.m / COLS;
  const gridBottom = GRID_Y + rows * PITCH;

  const cells: ReactNode[] = [];
  for (let i = 0; i < w.m; i++) {
    const set = w.bits[i] === 1;
    const isFp = fpCells !== null && fpCells.has(i);
    const isHot = hotCells !== null && hotCells.has(i);
    cells.push(
      <rect
        key={i}
        x={GRID_X + (i % COLS) * PITCH}
        y={cellTopY(i)}
        width={CELL}
        height={CELL}
        rx={3}
        className={isFp ? undefined : set ? 'f-accent' : 'f-inset'}
        style={
          isFp
            ? { fill: 'var(--danger)', stroke: evColor, strokeWidth: 2, strokeOpacity: flashAlpha }
            : isHot
              ? { stroke: evColor, strokeWidth: 2, strokeOpacity: flashAlpha }
              : undefined
        }
      />,
    );
  }

  return (
    <SimFrame
      title="Bloom filter false-positive hunt"
      playing={playing}
      onPlayPause={() => setPlaying((p) => !p)}
      onReset={() => {
        world.current = initWorld(m, k);
        bump();
      }}
      controls={
        <>
          <Slider
            label="bits m"
            value={m}
            min={32}
            max={256}
            step={32}
            onChange={(v) => {
              setM(v);
              rebuildFilter(world.current, v, k);
              bump();
            }}
          />
          <Slider
            label="hash functions k"
            value={k}
            min={1}
            max={8}
            onChange={(v) => {
              setK(v);
              rebuildFilter(world.current, m, v);
              bump();
            }}
          />
          <Button
            onClick={() => {
              insertKey(world.current);
              bump();
            }}
          >
            Insert random key
          </Button>
          <Button
            onClick={() => {
              queryGhost(world.current);
              bump();
            }}
          >
            Query unseen key
          </Button>
        </>
      }
      readouts={[
        { label: 'inserted n', value: n },
        { label: 'bits set', value: `${bitsSetPct.toFixed(0)}%` },
        { label: 'predicted FP', value: `${predictedPct.toFixed(1)}%` },
        { label: 'observed FP', value: observed },
        { label: 'false positives', value: falsePositives },
      ]}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Bloom filter bit array with hash lines from the current key and a query result log"
      >
        <rect x={1} y={1} width={W - 2} height={H - 2} rx={8} fill="none" className="s-border" />

        {/* Key currently being processed */}
        <text x={KEY_X} y={KEY_Y - 18} textAnchor="middle" className="svg-label small muted">
          processing
        </text>
        {ev ? (
          <text x={KEY_X} y={KEY_Y} textAnchor="middle" className="svg-label" style={{ fill: evColor }}>
            {ev.key}
          </text>
        ) : (
          <text x={KEY_X} y={KEY_Y} textAnchor="middle" className="svg-label muted">
            idle
          </text>
        )}

        {/* Bit array */}
        {cells}

        {/* k hash lines from the key to its target cells */}
        {ev && flashOn &&
          ev.cells.map((c, i) => (
            <line
              key={`${ev.key}-${i}`}
              x1={KEY_X}
              y1={LINES_Y}
              x2={cellCenterX(c)}
              y2={cellTopY(c)}
              style={{ stroke: evColor, strokeWidth: 1.5, opacity: flashAlpha }}
            />
          ))}

        <text x={GRID_X} y={gridBottom + 20} className="svg-label small muted">
          {w.m} bits · {w.k} hashes per key · ghost-* keys are never inserted
        </text>

        {/* Event log: last result */}
        {ev ? (
          <text x={GRID_X} y={H - 14} className="svg-label small" style={{ fill: evColor }}>
            {eventText(ev)}
          </text>
        ) : (
          <text x={GRID_X} y={H - 14} className="svg-label small muted">
            press play or use the buttons — watch for false positives as the array fills
          </text>
        )}
      </svg>
    </SimFrame>
  );
}
