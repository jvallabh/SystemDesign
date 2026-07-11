import { useRef, useState } from 'react';
import { SimFrame } from './SimFrame';
import { SegmentedControl, Toggle } from './controls';
import { useRafLoop } from './hooks/useRafLoop';

const W = 640;
const H = 340;
const CARD_W = 148;
const CARD_H = 212;
const CARD_Y = 10;
const BAR_W = 128;
const HUB_X = 320;
const HUB_Y = 286;
const DOT_END_Y = CARD_Y + CARD_H + 8;
const MAX_DOTS = 16;
const SPAWN_MS = 240;
const DOT_FLIGHT_MS = 900;

type Workload = 'relational' | 'keyvalue' | 'timeseries' | 'documents';
type ScaleTier = 'gb' | 'tb' | 'ptb';

interface StoreDef {
  name: string;
  kind: string;
  why: string;
}

const STORES: StoreDef[] = [
  { name: 'PostgreSQL', kind: 'relational', why: 'joins, ad-hoc SQL, and true multi-row ACID in one engine' },
  { name: 'MongoDB', kind: 'document', why: 'flexible JSON documents evolve without migrations' },
  { name: 'DynamoDB', kind: 'key-value', why: 'predictable low-latency key lookups at managed, massive scale' },
  { name: 'Cassandra', kind: 'wide-column', why: 'log-structured writes scale linearly for append-heavy loads' },
];

// Score components per store, index order: [PostgreSQL, MongoDB, DynamoDB, Cassandra]
const WORKLOAD_FIT: Record<Workload, [number, number, number, number]> = {
  relational: [95, 55, 30, 25],
  keyvalue: [60, 65, 95, 80],
  timeseries: [55, 50, 70, 95],
  documents: [65, 95, 60, 40],
};

const SCALE_FIT: Record<ScaleTier, [number, number, number, number]> = {
  gb: [100, 95, 85, 70],
  tb: [85, 90, 95, 90],
  ptb: [35, 70, 100, 100],
};

// Multi-row transaction capability (DynamoDB/Cassandra: single-item focus).
const TXN_FIT: [number, number, number, number] = [100, 70, 40, 25];

const BAR_LABELS = ['workload', 'scale', 'txn'] as const;

const DEFAULTS = {
  workload: 'relational' as Workload,
  scale: 'gb' as ScaleTier,
  acid: false,
};

interface Targets {
  comps: number[][]; // [store][workload, scale, txn]
  totals: number[];
}

function computeTargets(workload: Workload, scale: ScaleTier, acid: boolean): Targets {
  const comps: number[][] = [];
  const totals: number[] = [];
  for (let i = 0; i < STORES.length; i++) {
    const wl = WORKLOAD_FIT[workload][i];
    const sc = SCALE_FIT[scale][i];
    const tx = TXN_FIT[i];
    comps.push([wl, sc, tx]);
    // Scale keeps its 0.3 weight in both branches so toggling ACID never
    // dilutes the huge-scale penalty on single-node Postgres.
    totals.push(acid ? 0.45 * wl + 0.3 * sc + 0.25 * tx : 0.7 * wl + 0.3 * sc);
  }
  return { comps, totals };
}

function rankOf(totals: number[]): number[] {
  return totals
    .map((_, i) => i)
    .sort((a, b) => totals[b] - totals[a]);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Dot {
  id: number;
  t: number; // flight progress 0..1
  tx: number; // destination x (winner card center at spawn time)
  wob: number; // lateral wobble, -1..1
}

interface World {
  comps: number[][]; // eased component scores
  totals: number[]; // eased total scores
  dots: Dot[];
  spawnAcc: number;
  nextDotId: number;
  rand: () => number;
}

function initWorld(): World {
  const t = computeTargets(DEFAULTS.workload, DEFAULTS.scale, DEFAULTS.acid);
  return {
    comps: t.comps.map((c) => [...c]),
    totals: [...t.totals],
    dots: [],
    spawnAcc: 0,
    nextDotId: 1,
    rand: mulberry32(42),
  };
}

function stepWorld(w: World, dtMs: number, target: Targets, winnerX: number) {
  // Frame-rate-independent exponential easing toward targets.
  const k = 1 - Math.exp(-dtMs / 140);
  for (let i = 0; i < w.comps.length; i++) {
    for (let j = 0; j < w.comps[i].length; j++) {
      w.comps[i][j] += (target.comps[i][j] - w.comps[i][j]) * k;
    }
    w.totals[i] += (target.totals[i] - w.totals[i]) * k;
  }

  // Decorative request dots streaming toward the current winner.
  w.spawnAcc += dtMs;
  while (w.spawnAcc >= SPAWN_MS) {
    w.spawnAcc -= SPAWN_MS;
    if (w.dots.length < MAX_DOTS) {
      w.dots.push({ id: w.nextDotId++, t: 0, tx: winnerX, wob: w.rand() * 2 - 1 });
    }
  }
  const dp = dtMs / DOT_FLIGHT_MS;
  for (const d of w.dots) d.t += dp;
  w.dots = w.dots.filter((d) => d.t < 1);
}

function cardX(i: number): number {
  return 10 + i * 156;
}

function barFill(v: number): string {
  if (v >= 70) return 'var(--ok)';
  if (v >= 40) return 'var(--accent)';
  return 'var(--danger)';
}

/**
 * Store picker: an animated scorecard comparing PostgreSQL, MongoDB,
 * DynamoDB, and Cassandra for a chosen workload, scale, and transaction
 * requirement. Scores are a deterministic fit matrix; bars ease toward
 * targets and decorative request dots stream toward the current winner.
 */
export default function SqlNosqlSim() {
  const world = useRef<World>(initWorld());
  const [playing, setPlaying] = useState(true);
  const [workload, setWorkload] = useState<Workload>(DEFAULTS.workload);
  const [scale, setScale] = useState<ScaleTier>(DEFAULTS.scale);
  const [acid, setAcid] = useState(DEFAULTS.acid);
  const [, setTick] = useState(0);

  const targets = computeTargets(workload, scale, acid);
  const rank = rankOf(targets.totals);
  const winner = rank[0];
  const runnerUp = rank[1];

  useRafLoop((dt) => {
    stepWorld(world.current, dt, targets, cardX(winner) + CARD_W / 2);
    setTick((t) => t + 1);
  }, playing);

  const w = world.current;

  return (
    <SimFrame
      title="Store picker"
      playing={playing}
      onPlayPause={() => setPlaying((p) => !p)}
      onReset={() => {
        world.current = initWorld();
        setWorkload(DEFAULTS.workload);
        setScale(DEFAULTS.scale);
        setAcid(DEFAULTS.acid);
        setTick((t) => t + 1);
      }}
      controls={
        <>
          <SegmentedControl<Workload>
            label="Workload"
            value={workload}
            onChange={setWorkload}
            options={[
              { value: 'relational', label: 'Relational + ad-hoc queries' },
              { value: 'keyvalue', label: 'Key lookups at scale' },
              { value: 'timeseries', label: 'Write-heavy time-series' },
              { value: 'documents', label: 'Flexible nested docs' },
            ]}
          />
          <SegmentedControl<ScaleTier>
            label="Scale"
            value={scale}
            onChange={setScale}
            options={[
              { value: 'gb', label: '1 GB' },
              { value: 'tb', label: '1 TB' },
              { value: 'ptb', label: '100+ TB' },
            ]}
          />
          <Toggle label="need multi-row ACID transactions" checked={acid} onChange={setAcid} />
        </>
      }
      readouts={[
        { label: 'recommended', value: STORES[winner].name },
        { label: 'fit score', value: `${Math.round(targets.totals[winner])} / 100` },
        { label: 'runner-up', value: STORES[runnerUp].name },
      ]}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Scorecard comparing PostgreSQL, MongoDB, DynamoDB, and Cassandra for the selected workload, scale, and transaction needs"
      >
        {STORES.map((s, i) => {
          const x = cardX(i);
          const isWin = i === winner;
          return (
            <g key={s.name}>
              <rect
                x={x}
                y={CARD_Y}
                width={CARD_W}
                height={CARD_H}
                rx={8}
                className="f-inset"
                style={{
                  stroke: isWin ? 'var(--accent)' : 'var(--border)',
                  strokeWidth: isWin ? 2 : 1,
                }}
              />
              <text
                x={x + 10}
                y={34}
                className="svg-label"
                style={isWin ? { fill: 'var(--accent)' } : undefined}
              >
                {s.name}
              </text>
              <text x={x + 10} y={50} className="svg-label small muted">
                {s.kind}
              </text>
              {BAR_LABELS.map((lab, j) => {
                const v = w.comps[i][j];
                const labelY = 74 + j * 34;
                const trackY = 80 + j * 34;
                const fillW = Math.max(0, Math.min(BAR_W, (v / 100) * BAR_W));
                return (
                  <g key={lab} opacity={lab === 'txn' && !acid ? 0.4 : 1}>
                    <text x={x + 10} y={labelY} className="svg-label small muted">
                      {lab}
                    </text>
                    <text x={x + 10 + BAR_W} y={labelY} textAnchor="end" className="svg-label small muted">
                      {Math.round(v)}
                    </text>
                    <rect x={x + 10} y={trackY} width={BAR_W} height={7} rx={3} className="f-border" />
                    <rect
                      x={x + 10}
                      y={trackY}
                      width={fillW}
                      height={7}
                      rx={3}
                      style={{ fill: barFill(v) }}
                    />
                  </g>
                );
              })}
              <text
                x={x + 10}
                y={196}
                className="svg-label"
                style={{ fontSize: '24px', ...(isWin ? { fill: 'var(--accent)' } : {}) }}
              >
                {Math.round(w.totals[i])}
              </text>
              <text x={x + 10} y={212} className="svg-label small muted">
                fit / 100
              </text>
            </g>
          );
        })}

        <circle cx={HUB_X} cy={HUB_Y} r={5} className="f-accent" />
        <text x={HUB_X} y={HUB_Y + 18} textAnchor="middle" className="svg-label small muted">
          incoming requests
        </text>
        {w.dots.map((d) => {
          const x = HUB_X + (d.tx - HUB_X) * d.t + Math.sin(Math.PI * d.t) * d.wob * 14;
          const y = HUB_Y + (DOT_END_Y - HUB_Y) * d.t;
          return <circle key={d.id} cx={x} cy={y} r={3} opacity={0.8} className="f-accent" />;
        })}

        <text x={W / 2} y={330} textAnchor="middle" className="svg-label small">
          {STORES[winner].name} — {STORES[winner].why}
        </text>
      </svg>
    </SimFrame>
  );
}
