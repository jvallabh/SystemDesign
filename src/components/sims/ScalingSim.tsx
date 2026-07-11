import { useRef, useState } from 'react';
import { SimFrame } from './SimFrame';
import { SegmentedControl, Slider } from './controls';
import { useRafLoop } from './hooks/useRafLoop';

const W = 640;
const H = 340;
const CY = 175; // vertical center of the fleet area
const V_CX = 310; // center of the single vertical-scaling server
const GRID_CX = 330; // center of the horizontal instance grid
const CEIL_Y = 108; // hard-ceiling annotation line (just above the tier-4 box)
const LB = { x: 142, y: 157, w: 34, h: 36 };
const CHART = { x: 480, y: 70, w: 130, h: 130 };
const CURVE_MAX_MS = 420; // latency cap for the chart's y scale
const BASE_MS = 20; // service time at zero contention
const PER_RPS = 100; // capacity of one horizontal instance
const MAX_DOTS = 90;

type Mode = 'vertical' | 'horizontal';

const TIERS = [
  { cap: 100, cost: 1 },
  { cap: 180, cost: 3 },
  { cap: 300, cost: 8 },
  { cap: 420, cost: 20 },
];

interface Dot {
  x: number;
  y: number;
  leg: 0 | 1; // 0 = heading to LB (or straight to server), 1 = LB -> instance
  inst: number; // stable pick, mapped onto live instances via modulo
  jy: number; // -1..1 vertical jitter fraction
  v: number; // px per second
  failed: boolean;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface World {
  dots: Dot[];
  spawnAcc: number;
  dispUtil: number; // eased utilization, drives fills + chart marker
  dispLat: number; // eased latency, drives the readout
}

interface Model {
  capacity: number;
  util: number;
  latency: number;
  errors: number;
  cost: number;
}

interface StepParams {
  mode: Mode;
  load: number;
  capacity: number;
  util: number;
  latency: number;
  boxes: Box[];
}

function modelOf(mode: Mode, load: number, tier: number, n: number): Model {
  const t = TIERS[Math.min(TIERS.length - 1, Math.max(0, tier - 1))];
  const capacity =
    mode === 'vertical' ? t.cap : n * PER_RPS * (1 - 0.03 * (n - 1));
  const util = load / Math.max(1, capacity);
  const latency = BASE_MS / Math.max(0.02, 1 - util); // M/M/1; self-caps at 1000ms
  const errors = Math.max(0, load - capacity);
  const cost = mode === 'vertical' ? t.cost : n + 0.5;
  return { capacity, util, latency, errors, cost };
}

function fleetBoxes(mode: Mode, tier: number, n: number): Box[] {
  if (mode === 'vertical') {
    const t = Math.min(4, Math.max(1, tier));
    const bw = 70 + (t - 1) * 26;
    const bh = 56 + (t - 1) * 22;
    return [{ x: V_CX - bw / 2, y: CY - bh / 2, w: bw, h: bh }];
  }
  const count = Math.min(10, Math.max(1, n));
  const bw = 44;
  const bh = 32;
  const gx = 8;
  const gy = 14;
  const rows = count <= 5 ? 1 : 2;
  const cols = Math.ceil(count / rows);
  const x0 = GRID_CX - (cols * bw + (cols - 1) * gx) / 2;
  const y0 = CY - (rows * bh + (rows - 1) * gy) / 2;
  const out: Box[] = [];
  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    out.push({ x: x0 + c * (bw + gx), y: y0 + r * (bh + gy), w: bw, h: bh });
  }
  return out;
}

function initWorld(m: { util: number; latency: number }): World {
  return { dots: [], spawnAcc: 0, dispUtil: m.util, dispLat: m.latency };
}

function dotTarget(d: Dot, mode: Mode, boxes: Box[]): { x: number; y: number } {
  if (mode === 'horizontal' && d.leg === 0) {
    return { x: LB.x + LB.w + 4, y: LB.y + LB.h / 2 + d.jy * 10 };
  }
  const b = boxes[d.inst % boxes.length];
  return { x: b.x - 5, y: b.y + b.h / 2 + d.jy * (b.h / 2 - 8) };
}

function stepWorld(w: World, dtMs: number, p: StepParams) {
  // Ease displayed utilization/latency toward targets (frame-rate independent).
  const k = 1 - Math.exp(-dtMs / 180);
  w.dispUtil += (p.util - w.dispUtil) * k;
  w.dispLat += (p.latency - w.dispLat) * k;

  // Spawn request dots; density follows offered load.
  const failFrac = p.load > 0 ? Math.max(0, (p.load - p.capacity) / p.load) : 0;
  w.spawnAcc += (2 + p.load / 25) * (dtMs / 1000);
  while (w.spawnAcc >= 1) {
    w.spawnAcc -= 1;
    if (w.dots.length >= MAX_DOTS) continue;
    w.dots.push({
      x: 16,
      y: CY + (Math.random() - 0.5) * 90,
      leg: 0,
      inst: (Math.random() * 1024) | 0,
      jy: Math.random() * 2 - 1,
      v: 150 + Math.random() * 70,
      failed: Math.random() < failFrac,
    });
  }

  // Move dots toward their (live, layout-aware) targets.
  for (let i = w.dots.length - 1; i >= 0; i--) {
    const d = w.dots[i];
    const t = dotTarget(d, p.mode, p.boxes);
    const dx = t.x - d.x;
    const dy = t.y - d.y;
    const dist = Math.hypot(dx, dy);
    const step = d.v * (dtMs / 1000);
    if (dist <= Math.max(step, 2)) {
      if (p.mode === 'horizontal' && d.leg === 0) {
        d.leg = 1;
        d.x = t.x;
        d.y = t.y;
      } else {
        w.dots.splice(i, 1);
      }
    } else {
      d.x += (dx / dist) * step;
      d.y += (dy / dist) * step;
    }
  }
}

function utilFill(u: number): string {
  // Stay green until ~40% utilization, then ease into danger near 100%.
  const t = Math.min(1, Math.max(0, (u - 0.4) / 0.6));
  const pct = Math.round(t * t * 100);
  return `color-mix(in srgb, var(--danger) ${pct}%, var(--ok))`;
}

// The M/M/1 hockey-stick curve, precomputed (deterministic, safe for SSR).
const CURVE_PATH = (() => {
  const cmds: string[] = [];
  for (let i = 0; i <= 50; i++) {
    const u = i / 50;
    const lat = Math.min(BASE_MS / Math.max(0.02, 1 - u), CURVE_MAX_MS);
    const x = CHART.x + u * CHART.w;
    const y = CHART.y + CHART.h - (lat / CURVE_MAX_MS) * CHART.h;
    cmds.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return cmds.join(' ');
})();

const D_MODE: Mode = 'vertical';
const D_LOAD = 120;
const D_TIER = 2;
const D_N = 3;

/**
 * Scale-up vs scale-out: push offered load against one growing machine or a
 * fleet of small ones. Shows the M/M/1 latency hockey stick (latency explodes
 * before capacity runs out), vertical's hard ceiling at the top tier, and
 * horizontal's diminishing per-instance returns with linear cost.
 */
export default function ScalingSim() {
  const world = useRef<World>(initWorld(modelOf(D_MODE, D_LOAD, D_TIER, D_N)));
  const [playing, setPlaying] = useState(true);
  const [mode, setMode] = useState<Mode>(D_MODE);
  const [load, setLoad] = useState(D_LOAD);
  const [tier, setTier] = useState(D_TIER);
  const [n, setN] = useState(D_N);
  const [, setTick] = useState(0);

  const m = modelOf(mode, load, tier, n);
  const boxes = fleetBoxes(mode, tier, n);
  const over = m.util >= 1;
  const fleetCx = mode === 'vertical' ? V_CX : GRID_CX;

  useRafLoop((dt) => {
    stepWorld(world.current, dt, {
      mode,
      load,
      capacity: m.capacity,
      util: m.util,
      latency: m.latency,
      boxes,
    });
    setTick((t) => t + 1);
  }, playing);

  const wd = world.current;
  const fillLevel = Math.min(1, Math.max(0, wd.dispUtil));

  // Chart marker rides the curve at the eased utilization.
  const mu = Math.min(1, Math.max(0, wd.dispUtil));
  const mLat = Math.min(BASE_MS / Math.max(0.02, 1 - mu), CURVE_MAX_MS);
  const mx = CHART.x + mu * CHART.w;
  const my = CHART.y + CHART.h - (mLat / CURVE_MAX_MS) * CHART.h;

  return (
    <SimFrame
      title="Scale-up vs scale-out"
      playing={playing}
      onPlayPause={() => setPlaying((p) => !p)}
      onReset={() => {
        world.current = initWorld(m);
        setTick((t) => t + 1);
      }}
      controls={
        <>
          <SegmentedControl
            label="Mode"
            value={mode}
            options={[
              { value: 'vertical', label: 'Vertical' },
              { value: 'horizontal', label: 'Horizontal' },
            ]}
            onChange={setMode}
          />
          <Slider
            label="Offered load"
            value={load}
            min={10}
            max={1000}
            step={10}
            format={(v) => `${v} rps`}
            onChange={setLoad}
          />
          {mode === 'vertical' ? (
            <Slider
              label="Machine tier"
              value={tier}
              min={1}
              max={4}
              format={(v) => `T${v} · ${TIERS[v - 1].cap} rps`}
              onChange={setTier}
            />
          ) : (
            <Slider label="Instances" value={n} min={1} max={10} onChange={setN} />
          )}
        </>
      }
      readouts={[
        { label: 'capacity', value: `${Math.round(m.capacity)} rps` },
        { label: 'p50 latency', value: `${Math.round(wd.dispLat)} ms` },
        { label: 'errors/s', value: Math.round(m.errors) },
        { label: 'cost units', value: mode === 'vertical' ? String(m.cost) : m.cost.toFixed(1) },
      ]}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Request dots flowing into either one large server or a fleet of small servers behind a load balancer, next to a latency versus utilization curve showing the queueing hockey stick"
      >
        {/* incoming traffic */}
        <text x={12} y={118} className="svg-label small muted">
          clients
        </text>
        {wd.dots.map((d, i) => (
          <circle
            key={i}
            cx={d.x}
            cy={d.y}
            r={3}
            style={{ fill: d.failed ? 'var(--danger)' : 'var(--accent)' }}
          />
        ))}

        {/* vertical hard ceiling annotation */}
        {mode === 'vertical' && (
          <g>
            <line
              x1={210}
              x2={410}
              y1={CEIL_Y}
              y2={CEIL_Y}
              strokeDasharray="5 4"
              style={{
                stroke: tier === 4 && over ? 'var(--danger)' : 'var(--text-muted)',
                strokeWidth: 1.5,
              }}
            />
            <text x={V_CX} y={CEIL_Y - 8} textAnchor="middle" className="svg-label small muted">
              hard ceiling — no bigger machine
            </text>
          </g>
        )}

        {/* load balancer (horizontal only) */}
        {mode === 'horizontal' && (
          <g>
            <rect
              x={LB.x}
              y={LB.y}
              width={LB.w}
              height={LB.h}
              rx={5}
              className="f-inset s-border"
            />
            <text
              x={LB.x + LB.w / 2}
              y={LB.y + LB.h / 2 + 4}
              textAnchor="middle"
              className="svg-label small"
            >
              LB
            </text>
          </g>
        )}

        {/* fleet */}
        {boxes.map((b, i) => {
          const fh = fillLevel * (b.h - 6);
          return (
            <g key={i}>
              <rect
                x={b.x}
                y={b.y}
                width={b.w}
                height={b.h}
                rx={5}
                className="f-inset"
                style={{
                  stroke: over ? 'var(--danger)' : 'var(--border)',
                  strokeWidth: 1.5,
                }}
              />
              <rect
                x={b.x + 3}
                y={b.y + b.h - 3 - fh}
                width={b.w - 6}
                height={fh}
                rx={2}
                fillOpacity={0.85}
                style={{ fill: utilFill(wd.dispUtil) }}
              />
            </g>
          );
        })}
        {mode === 'vertical' && (
          <text x={V_CX} y={CY + 5} textAnchor="middle" className="svg-label">
            {Math.round(Math.min(1, m.util) * 100)}%
          </text>
        )}

        {/* fleet caption + error annotation */}
        <text x={fleetCx} y={296} textAnchor="middle" className="svg-label small muted">
          {mode === 'vertical'
            ? `tier ${tier} machine — ${Math.round(m.capacity)} rps capacity`
            : `${n} × ${PER_RPS} rps — ${Math.round(m.capacity)} rps effective (coordination overhead)`}
        </text>
        {m.errors > 0.5 && (
          <text
            x={fleetCx}
            y={316}
            textAnchor="middle"
            className="svg-label small"
            style={{ fill: 'var(--danger)' }}
          >
            {Math.round(m.errors)} rps failing — over capacity
          </text>
        )}

        {/* latency hockey-stick chart */}
        <text x={CHART.x - 2} y={CHART.y - 14} className="svg-label small muted">
          latency vs utilization
        </text>
        <line
          x1={CHART.x}
          y1={CHART.y}
          x2={CHART.x}
          y2={CHART.y + CHART.h}
          className="s-border"
        />
        <line
          x1={CHART.x}
          y1={CHART.y + CHART.h}
          x2={CHART.x + CHART.w}
          y2={CHART.y + CHART.h}
          className="s-border"
        />
        <line
          x1={CHART.x + CHART.w}
          y1={CHART.y}
          x2={CHART.x + CHART.w}
          y2={CHART.y + CHART.h}
          strokeDasharray="4 4"
          opacity={0.6}
          className="s-danger"
        />
        <path d={CURVE_PATH} fill="none" strokeWidth={2} className="s-accent-2" />
        <circle
          cx={mx}
          cy={my}
          r={4.5}
          style={{ fill: over ? 'var(--danger)' : 'var(--accent)' }}
        />
        <text
          x={CHART.x}
          y={CHART.y + CHART.h + 16}
          textAnchor="middle"
          className="svg-label small muted"
        >
          0
        </text>
        <text
          x={CHART.x + CHART.w}
          y={CHART.y + CHART.h + 16}
          textAnchor="middle"
          className="svg-label small muted"
        >
          100%
        </text>
        <text
          x={CHART.x + CHART.w / 2}
          y={CHART.y + CHART.h + 32}
          textAnchor="middle"
          className="svg-label small muted"
        >
          utilization →
        </text>
      </svg>
    </SimFrame>
  );
}
