import { useRef, useState } from 'react';
import { SimFrame } from './SimFrame';
import { Slider, SegmentedControl } from './controls';
import { useRafLoop } from './hooks/useRafLoop';

const W = 640;
const H = 340;
const LB_X = 260;
const LB_Y = H / 2;
const LB_R = 20;
const SPAWN_X = 10;
const SERVER_X = 480;
const SERVER_W = 140;
const QUEUE_CAP = 20;
const BASE_SERVICE = 8; // jobs/s for a ×1.00 server
const DOT_SPEED = 0.35; // px per ms
const RATE_MULS = [1.0, 0.8, 1.25, 0.9, 1.3, 0.85, 1.1, 0.95];
const FADE_MS = 600;
const MAX_DOTS = 250;
const MAX_FADES = 80;
const MAX_SAMPLES = 400;
const WAIT_WINDOW_MS = 3000;
const TPUT_WINDOW_MS = 2000;

type Strategy = 'rr' | 'lc' | 'rand' | 'p2c';

interface Server {
  id: number;
  rateMul: number;
  alive: boolean;
  /** Arrival timestamps (world clock ms) of queued requests, head first. */
  queue: number[];
  /** Fractional progress on the job at the head of the queue. */
  progress: number;
}

interface Dot {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  elapsedMs: number;
  durationMs: number;
  phase: 'toBalancer' | 'toServer';
  targetId: number;
}

interface Fade {
  x: number;
  y: number;
  ageMs: number;
  kind: 'done' | 'dropped';
}

interface World {
  clockMs: number;
  spawnInMs: number;
  rrIndex: number;
  servers: Server[];
  dots: Dot[];
  fades: Fade[];
  dropped: number;
  /** Completion timestamps (world clock ms) for rolling throughput. */
  completions: number[];
  /** Completed-request waits for the rolling avg-wait window. */
  waits: { t: number; wait: number }[];
}

function makeServer(i: number): Server {
  return {
    id: i,
    rateMul: RATE_MULS[i % RATE_MULS.length] ?? 1,
    alive: true,
    queue: [],
    progress: 0,
  };
}

/** Deterministic — identical markup on server and client. */
function initWorld(serverCount: number): World {
  return {
    clockMs: 0,
    spawnInMs: 200,
    rrIndex: -1,
    servers: Array.from({ length: serverCount }, (_, i) => makeServer(i)),
    dots: [],
    fades: [],
    dropped: 0,
    completions: [],
    waits: [],
  };
}

function serverSlot(i: number, n: number) {
  const margin = 16;
  const slotH = (H - 2 * margin) / Math.max(n, 1);
  const boxH = Math.min(44, slotH - 6);
  const y = margin + i * slotH + (slotH - boxH) / 2;
  return { y, h: boxH, cy: y + boxH / 2 };
}

/** Grow or shrink the server pool in place; ids are stable indexes. */
function reconcileServers(w: World, n: number) {
  if (w.servers.length === n) return;
  while (w.servers.length < n) w.servers.push(makeServer(w.servers.length));
  if (w.servers.length > n) {
    for (let i = n; i < w.servers.length; i++) w.dropped += w.servers[i]?.queue.length ?? 0;
    w.servers.length = n;
  }
  if (w.rrIndex >= n) w.rrIndex = -1;
  // Slot geometry changed: re-aim in-flight dots at their target's new center.
  for (const d of w.dots) {
    if (d.phase === 'toServer' && d.targetId >= 0 && d.targetId < n) {
      d.toY = serverSlot(d.targetId, n).cy;
    }
  }
}

/**
 * Requests assigned to a server and not yet completed: queued plus dots
 * still flying toward it. Routing on queue length alone herds bursts onto
 * one server, because the balancer→server flight delay hides decisions
 * already made.
 */
function loadOf(w: World, s: Server): number {
  let n = s.queue.length;
  for (const d of w.dots) {
    if (d.phase === 'toServer' && d.targetId === s.id && d.elapsedMs < d.durationMs) n++;
  }
  return n;
}

function pushFade(w: World, x: number, y: number, kind: Fade['kind']) {
  if (w.fades.length >= MAX_FADES) w.fades.shift();
  w.fades.push({ x, y, ageMs: 0, kind });
}

function pickServer(w: World, strategy: Strategy): Server | null {
  const alive = w.servers.filter((s) => s.alive);
  if (alive.length === 0) return null;
  switch (strategy) {
    case 'rr': {
      const n = w.servers.length;
      for (let k = 1; k <= n; k++) {
        const idx = (w.rrIndex + k) % n;
        const s = w.servers[idx];
        if (s && s.alive) {
          w.rrIndex = idx;
          return s;
        }
      }
      return null;
    }
    case 'lc': {
      let best = alive[0] as Server;
      let bestLoad = loadOf(w, best);
      for (const s of alive) {
        const load = loadOf(w, s);
        if (load < bestLoad) {
          best = s;
          bestLoad = load;
        }
      }
      return best;
    }
    case 'rand':
      return alive[Math.floor(Math.random() * alive.length)] as Server;
    case 'p2c': {
      if (alive.length === 1) return alive[0] as Server;
      const i = Math.floor(Math.random() * alive.length);
      let j = Math.floor(Math.random() * (alive.length - 1));
      if (j >= i) j++;
      const a = alive[i] as Server;
      const b = alive[j] as Server;
      return loadOf(w, a) <= loadOf(w, b) ? a : b;
    }
  }
}

function stepWorld(
  w: World,
  dtMs: number,
  rate: number,
  serverCount: number,
  strategy: Strategy,
) {
  reconcileServers(w, serverCount);
  w.clockMs += dtMs;

  // Spawn requests with Poisson-ish (exponential) inter-arrival gaps.
  if (rate > 0) {
    w.spawnInMs -= dtMs;
    while (w.spawnInMs <= 0) {
      if (w.dots.length < MAX_DOTS) {
        const y = LB_Y + (Math.random() * 2 - 1) * 55;
        const toX = LB_X - LB_R;
        const dist = Math.max(Math.hypot(toX - SPAWN_X, LB_Y - y), 1);
        w.dots.push({
          fromX: SPAWN_X,
          fromY: y,
          toX,
          toY: LB_Y,
          elapsedMs: 0,
          durationMs: dist / DOT_SPEED,
          phase: 'toBalancer',
          targetId: -1,
        });
      }
      const gap = -Math.log(1 - Math.random()) * (1000 / rate);
      w.spawnInMs += Math.max(gap, 2);
    }
  }

  // Move dots; route at the balancer, enqueue (or drop) at the server.
  const survivors: Dot[] = [];
  for (const d of w.dots) {
    d.elapsedMs += dtMs;
    if (d.elapsedMs < d.durationMs) {
      survivors.push(d);
      continue;
    }
    if (d.phase === 'toBalancer') {
      const target = pickServer(w, strategy);
      if (!target) {
        w.dropped++;
        pushFade(w, LB_X, LB_Y, 'dropped');
        continue;
      }
      const slot = serverSlot(target.id, w.servers.length);
      const fromX = LB_X + LB_R;
      const toX = SERVER_X - 6;
      const dist = Math.max(Math.hypot(toX - fromX, slot.cy - LB_Y), 1);
      d.fromX = fromX;
      d.fromY = LB_Y;
      d.toX = toX;
      d.toY = slot.cy;
      d.elapsedMs = 0;
      d.durationMs = dist / DOT_SPEED;
      d.phase = 'toServer';
      d.targetId = target.id;
      survivors.push(d);
    } else {
      const s = w.servers.find((sv) => sv.id === d.targetId);
      if (!s || !s.alive || s.queue.length >= QUEUE_CAP) {
        w.dropped++;
        pushFade(w, d.toX, d.toY, 'dropped');
      } else {
        s.queue.push(w.clockMs);
      }
    }
  }
  w.dots = survivors;

  // Drain queues at each server's service rate.
  for (let i = 0; i < w.servers.length; i++) {
    const s = w.servers[i] as Server;
    if (!s.alive || s.queue.length === 0) {
      s.progress = 0;
      continue;
    }
    s.progress += s.rateMul * BASE_SERVICE * (dtMs / 1000);
    while (s.progress >= 1 && s.queue.length > 0) {
      s.progress -= 1;
      const arrival = s.queue.shift();
      if (arrival !== undefined) {
        if (w.waits.length >= MAX_SAMPLES) w.waits.shift();
        w.waits.push({ t: w.clockMs, wait: w.clockMs - arrival });
        if (w.completions.length >= MAX_SAMPLES) w.completions.shift();
        w.completions.push(w.clockMs);
        const slot = serverSlot(i, w.servers.length);
        pushFade(w, SERVER_X + SERVER_W + 8, slot.cy, 'done');
      }
    }
    if (s.queue.length === 0) s.progress = 0;
  }

  // Prune rolling windows.
  const tputCut = w.clockMs - TPUT_WINDOW_MS;
  while (w.completions.length > 0 && (w.completions[0] ?? 0) < tputCut) w.completions.shift();
  const waitCut = w.clockMs - WAIT_WINDOW_MS;
  while (w.waits.length > 0 && (w.waits[0]?.t ?? 0) < waitCut) w.waits.shift();

  // Age fade-outs.
  const fades: Fade[] = [];
  for (const f of w.fades) {
    f.ageMs += dtMs;
    if (f.ageMs < FADE_MS) fades.push(f);
  }
  w.fades = fades;
}

const STRATEGY_OPTIONS: { value: Strategy; label: string }[] = [
  { value: 'rr', label: 'Round robin' },
  { value: 'lc', label: 'Least connections' },
  { value: 'rand', label: 'Random' },
  { value: 'p2c', label: '2 random choices' },
];

/**
 * Load balancer race: request dots arrive from the left, get routed by the
 * chosen strategy to servers with different service rates, and queue up.
 * Click a server to kill or revive it.
 */
export default function LoadBalancingSim() {
  const world = useRef<World>(initWorld(4));
  const [playing, setPlaying] = useState(true);
  const [strategy, setStrategy] = useState<Strategy>('rr');
  const [rate, setRate] = useState(30);
  const [serverCount, setServerCount] = useState(4);
  const [, setTick] = useState(0);

  useRafLoop((dt) => {
    stepWorld(world.current, dt, rate, serverCount, strategy);
    setTick((t) => t + 1);
  }, playing);

  const toggleServer = (id: number) => {
    const s = world.current.servers.find((sv) => sv.id === id);
    if (!s) return;
    if (s.alive) {
      s.alive = false;
      world.current.dropped += s.queue.length;
      s.queue = [];
      s.progress = 0;
    } else {
      s.alive = true;
    }
    setTick((t) => t + 1);
  };

  const w = world.current;

  const tputWindow = Math.min(TPUT_WINDOW_MS, Math.max(w.clockMs, 500));
  const throughput = w.completions.length / (tputWindow / 1000);
  const avgWait =
    w.waits.length > 0 ? w.waits.reduce((sum, s) => sum + s.wait, 0) / w.waits.length : 0;
  const aliveLoads = w.servers.filter((s) => s.alive).map((s) => loadOf(w, s));
  let imbalance = '—';
  if (aliveLoads.length >= 2) {
    const max = Math.max(...aliveLoads);
    const min = Math.min(...aliveLoads);
    imbalance = max === 0 ? '1.0×' : `${(max / Math.max(min, 1)).toFixed(1)}×`;
  }

  return (
    <SimFrame
      title="Load balancer race"
      playing={playing}
      onPlayPause={() => setPlaying((p) => !p)}
      onReset={() => {
        world.current = initWorld(serverCount);
        setTick((t) => t + 1);
      }}
      controls={
        <>
          <SegmentedControl
            label="Strategy"
            options={STRATEGY_OPTIONS}
            value={strategy}
            onChange={setStrategy}
          />
          <Slider
            label="Req rate"
            value={rate}
            min={5}
            max={100}
            step={5}
            format={(v) => `${v}/s`}
            onChange={setRate}
          />
          <Slider
            label="Servers"
            value={serverCount}
            min={2}
            max={8}
            onChange={(v) => {
              setServerCount(v);
              reconcileServers(world.current, v);
              setTick((t) => t + 1);
            }}
          />
        </>
      }
      readouts={[
        { label: 'throughput', value: `${throughput.toFixed(1)}/s` },
        { label: 'avg wait', value: `${Math.round(avgWait)} ms` },
        { label: 'dropped', value: w.dropped },
        { label: 'imbalance', value: imbalance },
      ]}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Requests flowing from clients through a load balancer to a row of servers with queues"
      >
        <text x={SPAWN_X} y={LB_Y - 68} className="svg-label small muted">
          clients
        </text>

        {/* Balancer node */}
        <circle
          cx={LB_X}
          cy={LB_Y}
          r={LB_R}
          className="f-inset s-accent"
          strokeWidth={1.5}
        />
        <text x={LB_X} y={LB_Y + 4} textAnchor="middle" className="svg-label small">
          LB
        </text>

        {/* Servers */}
        {w.servers.map((s) => {
          const slot = serverSlot(s.id, w.servers.length);
          const barMaxH = slot.h - 8;
          const qFrac = Math.min(s.queue.length / QUEUE_CAP, 1);
          const barH = qFrac * barMaxH;
          return (
            <g
              key={s.id}
              onClick={() => toggleServer(s.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggleServer(s.id);
                }
              }}
              tabIndex={0}
              role="button"
              aria-label={`Server ${s.id + 1}, ${s.alive ? 'alive' : 'dead'}. Press to toggle.`}
              style={{ cursor: 'pointer' }}
            >
              <g opacity={s.alive ? 1 : 0.45}>
                <rect
                  x={SERVER_X}
                  y={slot.y}
                  width={SERVER_W}
                  height={slot.h}
                  rx={6}
                  className="f-inset"
                  style={{
                    stroke: s.alive ? 'var(--border)' : 'var(--danger)',
                    strokeWidth: 1,
                  }}
                />
                <text x={SERVER_X + 10} y={slot.cy + 4} className="svg-label small">
                  {`S${s.id + 1} ×${s.rateMul.toFixed(2)}`}
                </text>
                <text
                  x={SERVER_X + SERVER_W - 22}
                  y={slot.cy + 4}
                  textAnchor="end"
                  className="svg-label small muted"
                >
                  {s.queue.length}
                </text>
                <rect
                  x={SERVER_X + SERVER_W - 16}
                  y={slot.y + 4}
                  width={8}
                  height={barMaxH}
                  rx={2}
                  className="f-border"
                />
                {barH > 0 && (
                  <rect
                    x={SERVER_X + SERVER_W - 16}
                    y={slot.y + 4 + (barMaxH - barH)}
                    width={8}
                    height={barH}
                    rx={2}
                    style={{ fill: qFrac >= 0.9 ? 'var(--danger)' : 'var(--accent)' }}
                  />
                )}
              </g>
              {!s.alive && (
                <g style={{ stroke: 'var(--danger)', strokeWidth: 2 }}>
                  <line
                    x1={SERVER_X + 6}
                    y1={slot.y + 6}
                    x2={SERVER_X + SERVER_W - 6}
                    y2={slot.y + slot.h - 6}
                  />
                  <line
                    x1={SERVER_X + SERVER_W - 6}
                    y1={slot.y + 6}
                    x2={SERVER_X + 6}
                    y2={slot.y + slot.h - 6}
                  />
                </g>
              )}
            </g>
          );
        })}

        {/* In-flight requests */}
        {w.dots.map((d, i) => {
          const t = Math.min(d.elapsedMs / d.durationMs, 1);
          const x = d.fromX + (d.toX - d.fromX) * t;
          const y = d.fromY + (d.toY - d.fromY) * t;
          return <circle key={i} cx={x} cy={y} r={4} className="f-accent-2" />;
        })}

        {/* Completed / dropped fade-outs */}
        {w.fades.map((f, i) => (
          <circle
            key={i}
            cx={f.x}
            cy={f.y}
            r={4}
            style={{
              fill: f.kind === 'done' ? 'var(--ok)' : 'var(--danger)',
              opacity: Math.max(1 - f.ageMs / FADE_MS, 0),
            }}
          />
        ))}
      </svg>
    </SimFrame>
  );
}
