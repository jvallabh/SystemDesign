import { useRef, useState } from 'react';
import { SimFrame } from './SimFrame';
import { Slider, SegmentedControl } from './controls';
import { useRafLoop } from './hooks/useRafLoop';

const W = 640;
const H = 340;

// Layout anchors
const APP_OUT = { x: 96, y: 178 };
const CACHE_IN = { x: 148, y: 178 };
const CACHE_OUT = { x: 420, y: 178 };
const DB_IN = { x: 528, y: 178 };
const GRID_X = 156;
const GRID_Y = 96;
const GRID_W = 256;
const GRID_H = 164;

// Tuning
const KEYSPACE = 50;
const FAST = 0.4; // px/ms
const SLOW = 0.04; // px/ms — ~10x slower on the trip to the DB
const HIT_LAT = 2;
const DB_LAT = 60;
const MISS_LAT = HIT_LAT + DB_LAT;
const REQ_RATE = 2; // req/s
const SCAN_RATE = 7; // req/s during a scan burst
const SCAN_COUNT = 12;
const SCAN_EVERY_MS = 15000;
const WRITE_FRAC = 0.2;
const FLUSH_RATE = 0.3; // flushes/s for write-behind drain
const FLASH_MS = 350;
const GHOST_MS = 500;
const WINDOW = 100;
const MAX_DOTS = 48;
const MAX_GHOSTS = 8;

type Eviction = 'LRU' | 'LFU' | 'FIFO';
type Strategy = 'aside' | 'through' | 'behind';
type DotKind = 'read' | 'scan' | 'write' | 'flush';
type Phase = 'appToCache' | 'crossPanel' | 'cacheToDb' | 'dbReturn' | 'cacheReturn';

interface Params {
  capacity: number;
  skew: number; // 0..1
  eviction: Eviction;
  strategy: Strategy;
}

interface Slot {
  key: string;
  freq: number;
  lastUsed: number;
  insertedAt: number;
  dirty: boolean;
  flash: number;
  flashWrite: boolean;
}

interface Dot {
  kind: DotKind;
  strategy: Strategy;
  key: string;
  phase: Phase;
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  t: number;
  durMs: number;
  arc: number;
  jitter: number;
}

interface Ghost {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  age: number;
}

interface World {
  simTime: number;
  rngState: number;
  slots: Slot[];
  dots: Dot[];
  ghosts: Ghost[];
  hitWindow: number[];
  latWindow: number[];
  evictions: number;
  pending: number;
  spawnAcc: number;
  flushAcc: number;
  scanLeft: number;
  scanSeq: number;
  nextScanAt: number;
  scanLabelUntil: number;
}

function initWorld(): World {
  return {
    simTime: 0,
    rngState: 0x9e3779b9,
    slots: [],
    dots: [],
    ghosts: [],
    hitWindow: [],
    latWindow: [],
    evictions: 0,
    pending: 0,
    spawnAcc: 0,
    flushAcc: 0,
    scanLeft: 0,
    scanSeq: 0,
    nextScanAt: SCAN_EVERY_MS,
    scanLabelUntil: 0,
  };
}

// mulberry32 — deterministic PRNG, state lives in the world
function rand(w: World): number {
  w.rngState = (w.rngState + 0x6d2b79f5) | 0; // keep state a 32-bit int forever
  let t = w.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Zipf-ish sample over KEYSPACE keys; skew 0 = uniform, 1 = heavy head
function sampleKey(w: World, skew: number): string {
  const s = skew * 1.4;
  let total = 0;
  for (let i = 0; i < KEYSPACE; i++) total += 1 / Math.pow(i + 1, s);
  let r = rand(w) * total;
  for (let i = 0; i < KEYSPACE; i++) {
    r -= 1 / Math.pow(i + 1, s);
    if (r <= 0) return `K${i}`;
  }
  return `K${KEYSPACE - 1}`;
}

function pushCap(arr: number[], v: number): void {
  arr.push(v);
  if (arr.length > WINDOW) arr.shift();
}

function recordRead(w: World, hit: number, lat: number): void {
  pushCap(w.hitWindow, hit);
  pushCap(w.latWindow, lat);
}

function layout(capacity: number) {
  const cols = capacity <= 8 ? 4 : 8;
  const rows = Math.max(1, Math.ceil(capacity / cols));
  const cellW = GRID_W / cols;
  const cellH = Math.min(GRID_H / rows, 52);
  const oy = GRID_Y + (GRID_H - rows * cellH) / 2;
  return { cols, cellW, cellH, ox: GRID_X, oy };
}

function gridPos(i: number, capacity: number) {
  const g = layout(capacity);
  return {
    x: g.ox + (i % g.cols) * g.cellW,
    y: g.oy + Math.floor(i / g.cols) * g.cellH,
    w: g.cellW,
    h: g.cellH,
  };
}

function addGhost(w: World, slot: Slot, index: number, capacity: number): void {
  const p = gridPos(index, capacity);
  w.ghosts.push({ key: slot.key, x: p.x, y: p.y, w: p.w, h: p.h, age: 0 });
  if (w.ghosts.length > MAX_GHOSTS) w.ghosts.shift();
}

function victimIndex(w: World, policy: Eviction): number {
  let best = 0;
  for (let i = 1; i < w.slots.length; i++) {
    const a = w.slots[i];
    const b = w.slots[best];
    if (policy === 'LRU') {
      if (a.lastUsed < b.lastUsed) best = i;
    } else if (policy === 'LFU') {
      if (a.freq < b.freq || (a.freq === b.freq && a.lastUsed < b.lastUsed)) best = i;
    } else {
      if (a.insertedAt < b.insertedAt) best = i;
    }
  }
  return best;
}

// Swap-remove so every surviving slot keeps its grid cell
function removeAt(w: World, i: number): void {
  w.slots[i] = w.slots[w.slots.length - 1];
  w.slots.pop();
}

function evictOne(w: World, p: Params): void {
  if (w.slots.length === 0) return;
  const i = victimIndex(w, p.eviction);
  // Position the ghost with the layout the slot was actually rendered under:
  // during a capacity shrink, slots.length still reflects the old (larger) grid.
  addGhost(w, w.slots[i], i, Math.max(p.capacity, w.slots.length));
  removeAt(w, i);
  w.evictions++;
}

// Insert or refresh a key; dirty=true marks a write-behind write
function upsert(w: World, key: string, dirty: boolean, isWrite: boolean, p: Params): void {
  const slot = w.slots.find((s) => s.key === key);
  if (slot) {
    slot.freq++;
    slot.lastUsed = w.simTime;
    slot.flash = FLASH_MS;
    slot.flashWrite = isWrite;
    if (dirty && !slot.dirty) {
      slot.dirty = true;
      w.pending++;
    }
    return;
  }
  const fresh: Slot = {
    key,
    freq: 1,
    lastUsed: w.simTime,
    insertedAt: w.simTime,
    dirty,
    flash: FLASH_MS,
    flashWrite: isWrite,
  };
  while (w.slots.length > p.capacity) evictOne(w, p);
  if (w.slots.length >= p.capacity && w.slots.length > 0) {
    // Replace the victim in place so the new key visibly fills the vacated slot
    const i = victimIndex(w, p.eviction);
    addGhost(w, w.slots[i], i, p.capacity);
    w.slots[i] = fresh;
    w.evictions++;
  } else {
    w.slots.push(fresh);
  }
  if (dirty) w.pending++;
}

function invalidate(w: World, key: string, p: Params): void {
  const i = w.slots.findIndex((s) => s.key === key);
  if (i < 0) return;
  addGhost(w, w.slots[i], i, p.capacity);
  removeAt(w, i);
}

function clearOldestDirty(w: World): void {
  let idx = -1;
  for (let i = 0; i < w.slots.length; i++) {
    const s = w.slots[i];
    if (s.dirty && (idx < 0 || s.lastUsed < w.slots[idx].lastUsed)) idx = i;
  }
  if (idx >= 0) w.slots[idx].dirty = false;
}

function send(
  d: Dot,
  phase: Phase,
  from: { x: number; y: number },
  to: { x: number; y: number },
  speed: number,
  arc: number,
): void {
  d.phase = phase;
  d.fx = from.x;
  d.fy = from.y;
  d.tx = to.x;
  d.ty = to.y;
  d.t = 0;
  const dist = Math.max(1, Math.hypot(to.x - from.x, to.y - from.y));
  d.durMs = dist / speed;
  d.arc = arc;
}

function spawnDot(w: World, kind: DotKind, key: string, strategy: Strategy): void {
  const d: Dot = {
    kind,
    strategy,
    key,
    phase: 'appToCache',
    fx: 0,
    fy: 0,
    tx: 0,
    ty: 0,
    t: 0,
    durMs: 1,
    arc: 0,
    jitter: (rand(w) * 2 - 1) * 7,
  };
  send(d, 'appToCache', APP_OUT, CACHE_IN, FAST, 0);
  w.dots.push(d);
}

// Reconcile cache contents with a (possibly shrunk) capacity, per policy
function reconcileCapacity(w: World, capacity: number, eviction: Eviction): void {
  const p: Params = { capacity, eviction, skew: 0, strategy: 'aside' };
  while (w.slots.length > capacity) evictOne(w, p);
}

function stepWorld(w: World, dtMs: number, p: Params): void {
  w.simTime += dtMs;

  reconcileCapacity(w, p.capacity, p.eviction);

  // Decay flashes and ghosts
  for (const s of w.slots) s.flash = Math.max(0, s.flash - dtMs);
  for (const g of w.ghosts) g.age += dtMs;
  w.ghosts = w.ghosts.filter((g) => g.age < GHOST_MS);

  // Periodic scan burst of one-off keys
  if (w.simTime >= w.nextScanAt) {
    w.scanLeft = SCAN_COUNT;
    w.nextScanAt = w.simTime + SCAN_EVERY_MS;
    w.scanLabelUntil = w.simTime + 2600;
  }

  // Spawn requests
  const rate = w.scanLeft > 0 ? SCAN_RATE : REQ_RATE;
  w.spawnAcc = Math.min(3, w.spawnAcc + (dtMs * rate) / 1000);
  while (w.spawnAcc >= 1) {
    w.spawnAcc -= 1;
    if (w.dots.length >= MAX_DOTS) continue;
    if (w.scanLeft > 0) {
      w.scanLeft--;
      spawnDot(w, 'scan', `S${w.scanSeq}`, p.strategy);
      w.scanSeq = (w.scanSeq + 1) % 1000;
    } else if (rand(w) < WRITE_FRAC) {
      spawnDot(w, 'write', sampleKey(w, p.skew), p.strategy);
    } else {
      spawnDot(w, 'read', sampleKey(w, p.skew), p.strategy);
    }
  }

  // Advance dots and run arrival transitions
  const survivors: Dot[] = [];
  for (const d of w.dots) {
    d.t += dtMs / d.durMs;
    if (d.t < 1) {
      survivors.push(d);
      continue;
    }
    switch (d.phase) {
      case 'appToCache': {
        if (d.kind === 'read' || d.kind === 'scan') {
          const slot = w.slots.find((s) => s.key === d.key);
          if (slot) {
            slot.freq++;
            slot.lastUsed = w.simTime;
            slot.flash = FLASH_MS;
            slot.flashWrite = false;
            recordRead(w, 1, HIT_LAT);
            send(d, 'cacheReturn', CACHE_IN, APP_OUT, FAST, 34);
          } else {
            recordRead(w, 0, MISS_LAT);
            send(d, 'crossPanel', CACHE_IN, CACHE_OUT, FAST, 0);
          }
          survivors.push(d);
        } else if (d.kind === 'write') {
          if (d.strategy === 'aside') {
            // Write DB directly, invalidate any cached copy
            pushCap(w.latWindow, DB_LAT);
            invalidate(w, d.key, p);
            send(d, 'crossPanel', CACHE_IN, CACHE_OUT, FAST, 0);
            survivors.push(d);
          } else if (d.strategy === 'through') {
            // Write cache, then synchronously write DB
            pushCap(w.latWindow, MISS_LAT);
            upsert(w, d.key, false, true, p);
            send(d, 'crossPanel', CACHE_IN, CACHE_OUT, FAST, 0);
            survivors.push(d);
          } else {
            // Write-behind: cache only, fast ack, flush later
            pushCap(w.latWindow, HIT_LAT);
            upsert(w, d.key, true, true, p);
            send(d, 'cacheReturn', CACHE_IN, APP_OUT, FAST, 34);
            survivors.push(d);
          }
        }
        break;
      }
      case 'crossPanel':
        send(d, 'cacheToDb', CACHE_OUT, DB_IN, SLOW, 0);
        survivors.push(d);
        break;
      case 'cacheToDb':
        if (d.kind === 'flush') {
          w.pending = Math.max(0, w.pending - 1);
          clearOldestDirty(w);
        } else if (d.kind === 'read' || d.kind === 'scan') {
          upsert(w, d.key, false, false, p);
          send(d, 'dbReturn', DB_IN, APP_OUT, FAST, 108);
          survivors.push(d);
        }
        // writes (aside / through) complete at the DB
        break;
      case 'dbReturn':
      case 'cacheReturn':
        break; // done
    }
  }
  w.dots = survivors;

  // Write-behind drain: slowly flush dirty entries to the DB
  w.flushAcc = Math.min(2, w.flushAcc + (dtMs * FLUSH_RATE) / 1000);
  while (w.flushAcc >= 1) {
    w.flushAcc -= 1;
    const inFlight = w.dots.reduce((n, d) => n + (d.kind === 'flush' ? 1 : 0), 0);
    if (w.pending > inFlight && w.dots.length < MAX_DOTS) {
      const d: Dot = {
        kind: 'flush',
        strategy: 'behind',
        key: '',
        phase: 'cacheToDb',
        fx: 0,
        fy: 0,
        tx: 0,
        ty: 0,
        t: 0,
        durMs: 1,
        arc: 0,
        jitter: (rand(w) * 2 - 1) * 7,
      };
      send(d, 'cacheToDb', CACHE_OUT, DB_IN, SLOW, 0);
      w.dots.push(d);
    }
  }
}

function dotXY(d: Dot): { x: number; y: number } {
  const x = d.fx + (d.tx - d.fx) * d.t;
  const y = d.fy + (d.ty - d.fy) * d.t - Math.sin(Math.PI * d.t) * d.arc + d.jitter;
  return { x, y };
}

const DOT_VAR: Record<DotKind, string> = {
  read: 'var(--accent)',
  scan: 'var(--danger)',
  write: 'var(--accent-2)',
  flush: 'var(--text-muted)',
};

/**
 * Cache hit-rate lab: a request stream flows from an app through a cache to a
 * slow database. Compare eviction policies (LRU / LFU / FIFO) and write
 * strategies (cache-aside / write-through / write-behind) while periodic scan
 * bursts pollute the cache with one-off keys.
 */
export default function CachingSim() {
  const world = useRef<World>(initWorld());
  const [playing, setPlaying] = useState(true);
  const [eviction, setEviction] = useState<Eviction>('LRU');
  const [strategy, setStrategy] = useState<Strategy>('aside');
  const [capacity, setCapacity] = useState(12);
  const [skew, setSkew] = useState(50);
  const [, setTick] = useState(0);

  useRafLoop((dt) => {
    stepWorld(world.current, dt, { capacity, skew: skew / 100, eviction, strategy });
    setTick((t) => t + 1);
  }, playing);

  const w = world.current;

  const hits = w.hitWindow.reduce((a, b) => a + b, 0);
  const hitRate = w.hitWindow.length > 0 ? `${Math.round((100 * hits) / w.hitWindow.length)}%` : '—';
  const avgLat =
    w.latWindow.length > 0
      ? `${(w.latWindow.reduce((a, b) => a + b, 0) / w.latWindow.length).toFixed(0)} ms`
      : '—';

  const readouts: { label: string; value: string | number }[] = [
    { label: 'hit rate (last 100)', value: hitRate },
    { label: 'avg latency', value: avgLat },
    { label: 'evictions', value: w.evictions },
  ];
  if (strategy === 'behind') readouts.push({ label: 'dirty pending', value: w.pending });

  const scanActive = w.simTime > 0 && w.simTime < w.scanLabelUntil;
  const cells: { x: number; y: number; w: number; h: number }[] = [];
  for (let i = 0; i < capacity; i++) cells.push(gridPos(i, capacity));

  return (
    <SimFrame
      title="Cache hit-rate lab"
      playing={playing}
      onPlayPause={() => setPlaying((p) => !p)}
      onReset={() => {
        world.current = initWorld();
        setTick((t) => t + 1);
      }}
      controls={
        <>
          <SegmentedControl<Eviction>
            label="Eviction"
            value={eviction}
            onChange={setEviction}
            options={[
              { value: 'LRU', label: 'LRU' },
              { value: 'LFU', label: 'LFU' },
              { value: 'FIFO', label: 'FIFO' },
            ]}
          />
          <SegmentedControl<Strategy>
            label="Write strategy"
            value={strategy}
            onChange={setStrategy}
            options={[
              { value: 'aside', label: 'Cache-aside' },
              { value: 'through', label: 'Write-through' },
              { value: 'behind', label: 'Write-behind' },
            ]}
          />
          <Slider
            label="Cache size"
            value={capacity}
            min={4}
            max={32}
            onChange={(v) => {
              reconcileCapacity(world.current, v, eviction);
              setCapacity(v);
            }}
          />
          <Slider
            label="Access skew"
            value={skew}
            min={0}
            max={100}
            step={5}
            format={(v) => `${v}%`}
            onChange={setSkew}
          />
        </>
      }
      readouts={readouts}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Requests flowing from an app through a cache of key slots to a slow database, with hits returning quickly and misses crawling to the database"
      >
        {/* App */}
        <rect x={16} y={146} width={80} height={64} rx={8} className="f-inset s-border" />
        <text x={56} y={175} textAnchor="middle" className="svg-label">
          App
        </text>
        <text x={56} y={194} textAnchor="middle" className="svg-label small muted">
          reads+writes
        </text>

        {/* Cache panel */}
        <text x={148} y={80} className="svg-label muted">
          Cache · 2 ms
        </text>
        <rect x={148} y={88} width={272} height={180} rx={8} className="f-inset s-border" />

        {/* DB */}
        <rect x={528} y={146} width={88} height={64} rx={8} className="f-inset s-border" />
        <text x={572} y={175} textAnchor="middle" className="svg-label">
          DB
        </text>
        <text x={572} y={194} textAnchor="middle" className="svg-label small muted">
          60 ms
        </text>

        {/* Lanes */}
        <line x1={96} y1={178} x2={148} y2={178} className="s-border" strokeDasharray="3 4" />
        <line x1={420} y1={178} x2={528} y2={178} className="s-border" strokeDasharray="3 4" />

        {/* Cache slots */}
        {cells.map((c, i) => {
          const slot = i < w.slots.length ? w.slots[i] : null;
          if (!slot) {
            return (
              <rect
                key={`e${i}`}
                x={c.x + 3}
                y={c.y + 3}
                width={c.w - 6}
                height={c.h - 6}
                rx={4}
                fill="none"
                className="s-border"
                strokeDasharray="4 4"
                opacity={0.55}
              />
            );
          }
          const rec = Math.max(0, 1 - (w.simTime - slot.lastUsed) / 10000);
          return (
            <g key={slot.key}>
              <rect
                x={c.x + 3}
                y={c.y + 3}
                width={c.w - 6}
                height={c.h - 6}
                rx={4}
                className="f-raised s-border"
              />
              {slot.flash > 0 && (
                <rect
                  x={c.x + 3}
                  y={c.y + 3}
                  width={c.w - 6}
                  height={c.h - 6}
                  rx={4}
                  style={{ fill: slot.flashWrite ? 'var(--accent-2)' : 'var(--ok)' }}
                  opacity={(slot.flash / FLASH_MS) * 0.5}
                />
              )}
              {/* recency bar */}
              <rect
                x={c.x + 5}
                y={c.y + 5}
                width={Math.max(0, (c.w - 10) * rec)}
                height={2}
                className="f-accent"
                opacity={0.9}
              />
              <text x={c.x + c.w / 2} y={c.y + c.h / 2 + 2} textAnchor="middle" className="svg-label small">
                {slot.key}
              </text>
              {/* frequency badge */}
              <text
                x={c.x + c.w / 2}
                y={c.y + c.h - 7}
                textAnchor="middle"
                className="svg-label small muted"
              >
                ×{Math.min(slot.freq, 999)}
              </text>
              {slot.dirty && (
                <circle cx={c.x + c.w - 9} cy={c.y + 10} r={3.5} style={{ fill: 'var(--danger)' }} />
              )}
            </g>
          );
        })}

        {/* Evicted / invalidated slots falling out */}
        {w.ghosts.map((g, i) => {
          const life = Math.max(0, 1 - g.age / GHOST_MS);
          return (
            <g key={`g${i}`} opacity={life * 0.7} transform={`translate(0 ${(1 - life) * 16})`}>
              <rect
                x={g.x + 3}
                y={g.y + 3}
                width={g.w - 6}
                height={g.h - 6}
                rx={4}
                fill="none"
                className="s-danger"
              />
              <text x={g.x + g.w / 2} y={g.y + g.h / 2 + 2} textAnchor="middle" className="svg-label small muted">
                {g.key}
              </text>
            </g>
          );
        })}

        {/* Request dots */}
        {w.dots.map((d, i) => {
          const p = dotXY(d);
          return (
            <circle
              key={`d${i}`}
              cx={p.x}
              cy={p.y}
              r={d.kind === 'flush' ? 3.5 : 5}
              style={{ fill: DOT_VAR[d.kind] }}
            />
          );
        })}

        {/* Scan burst banner */}
        {scanActive && (
          <text x={284} y={288} textAnchor="middle" className="svg-label" style={{ fill: 'var(--danger)' }}>
            SCAN burst — one-off keys
          </text>
        )}

        {/* Legend */}
        <g>
          <circle cx={120} cy={314} r={5} className="f-accent" />
          <text x={130} y={318} className="svg-label small muted">
            read
          </text>
          <circle cx={210} cy={314} r={5} className="f-accent-2" />
          <text x={220} y={318} className="svg-label small muted">
            write
          </text>
          <circle cx={300} cy={314} r={5} className="f-danger" />
          <text x={310} y={318} className="svg-label small muted">
            scan
          </text>
          <circle cx={390} cy={314} r={3.5} className="f-muted" />
          <text x={400} y={318} className="svg-label small muted">
            flush
          </text>
          <circle cx={480} cy={314} r={3.5} style={{ fill: 'var(--danger)' }} />
          <text x={490} y={318} className="svg-label small muted">
            dirty
          </text>
        </g>
      </svg>
    </SimFrame>
  );
}
