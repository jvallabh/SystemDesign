import { useRef, useState, type ReactNode } from 'react';
import { SimFrame } from './SimFrame';
import { Slider, SegmentedControl, Button } from './controls';
import { useRafLoop } from './hooks/useRafLoop';

const W = 640;
const H = 340;

const LANE_IN_Y = 180; // incoming request lane
const OK_Y = 140; // accepted exit lane
const REJ_Y = 262; // rejected exit lane
const GATE_IN_X = 258; // decision point (limiter entry)
const GATE_OUT_X = 382; // limiter exit
const DOT_R = 5;
const DOT_SPEED = 0.17; // px per ms (frame-rate independent)
const WINDOW_MS = 2000; // fixed & sliding window length
const TIMELINE_MS = 4000; // sliding-window timeline display horizon
const MAX_DOTS = 240; // hard cap on in-flight dots
const MAX_DECISIONS = 100; // rolling accepted-% sample size
const MAX_LOG = 160; // sliding-window timestamp log cap
const BURST_SIZE = 20;
const DEFAULT_CAPACITY = 10;

type Algorithm = 'token' | 'leaky' | 'fixed' | 'sliding';

const ALGO_NAMES: Record<Algorithm, string> = {
  token: 'token bucket',
  leaky: 'leaky bucket',
  fixed: 'fixed window',
  sliding: 'sliding window',
};

interface Dot {
  id: number;
  x: number;
  y: number;
  phase: 'in' | 'ok' | 'rej';
}

interface World {
  simTime: number;
  nextId: number;
  dots: Dot[];
  arrivalAcc: number; // fractional pending arrivals
  tokens: number; // token bucket level
  leakAcc: number; // fractional pending leaks
  queueDepth: number; // leaky bucket queue occupancy
  windowStart: number; // fixed window start (sim time, ms)
  windowCount: number; // fixed window admissions
  slidingLog: number[]; // ascending timestamps of sliding-window admissions
  accepted: number;
  rejected: number;
  decisions: number[]; // rolling 1/0 outcomes, capped at MAX_DECISIONS
}

interface Params {
  algorithm: Algorithm;
  reqRate: number; // requests per second
  capacity: number; // bucket capacity / queue cap / window quota
  sustainedRate: number; // token refill or leak rate, per second
}

function initWorld(capacity: number): World {
  return {
    simTime: 0,
    nextId: 0,
    dots: [],
    arrivalAcc: 0,
    tokens: capacity, // start with a full bucket
    leakAcc: 0,
    queueDepth: 0,
    windowStart: 0,
    windowCount: 0,
    slidingLog: [],
    accepted: 0,
    rejected: 0,
    decisions: [],
  };
}

function slidingCount(w: World): number {
  let n = 0;
  for (let i = w.slidingLog.length - 1; i >= 0; i--) {
    if (w.simTime - w.slidingLog[i] <= WINDOW_MS) n++;
    else break;
  }
  return n;
}

function decide(w: World, p: Params): boolean {
  switch (p.algorithm) {
    case 'token':
      if (w.tokens >= 1) {
        w.tokens -= 1;
        return true;
      }
      return false;
    case 'leaky':
      if (w.queueDepth < p.capacity) {
        w.queueDepth++;
        return true;
      }
      return false;
    case 'fixed':
      if (w.windowCount < p.capacity) {
        w.windowCount++;
        return true;
      }
      return false;
    case 'sliding':
      if (slidingCount(w) < p.capacity) {
        w.slidingLog.push(w.simTime);
        if (w.slidingLog.length > MAX_LOG) w.slidingLog.shift();
        return true;
      }
      return false;
  }
}

function recordDecision(w: World, ok: boolean) {
  if (ok) w.accepted++;
  else w.rejected++;
  w.decisions.push(ok ? 1 : 0);
  if (w.decisions.length > MAX_DECISIONS) w.decisions.shift();
}

function stepWorld(w: World, dtMs: number, p: Params) {
  w.simTime += dtMs;
  const dtS = dtMs / 1000;

  // Token bucket refill; also clamps down if capacity slider shrank.
  w.tokens = Math.min(p.capacity, w.tokens + p.sustainedRate * dtS);
  // Reconcile queue with a shrunk capacity slider.
  w.queueDepth = Math.min(w.queueDepth, p.capacity);

  // Fixed window boundary reset.
  if (w.simTime - w.windowStart >= WINDOW_MS) {
    w.windowStart +=
      Math.floor((w.simTime - w.windowStart) / WINDOW_MS) * WINDOW_MS;
    w.windowCount = 0;
  }

  // Prune sliding log past the display horizon.
  while (w.slidingLog.length > 0 && w.simTime - w.slidingLog[0] > TIMELINE_MS) {
    w.slidingLog.shift();
  }

  // Steady arrivals.
  w.arrivalAcc += p.reqRate * dtS;
  let spawnI = 0;
  while (w.arrivalAcc >= 1) {
    w.arrivalAcc -= 1;
    if (w.dots.length < MAX_DOTS) {
      w.dots.push({ id: w.nextId++, x: -spawnI * 12, y: LANE_IN_Y, phase: 'in' });
      spawnI++;
    }
  }

  // Leaky bucket drains at the sustained rate; unused leak is discarded
  // (no banking), which is what makes the output steady.
  if (p.algorithm === 'leaky') {
    w.leakAcc += p.sustainedRate * dtS;
    while (w.leakAcc >= 1) {
      w.leakAcc -= 1;
      if (w.queueDepth > 0 && w.dots.length < MAX_DOTS) {
        w.queueDepth--;
        w.dots.push({ id: w.nextId++, x: GATE_OUT_X, y: LANE_IN_Y, phase: 'ok' });
      }
    }
  } else {
    w.leakAcc = 0;
  }

  // Move dots, decide at the gate, cull offscreen.
  const move = DOT_SPEED * dtMs;
  const ease = 1 - Math.exp(-dtMs / 120); // frame-rate independent lane easing
  for (let i = w.dots.length - 1; i >= 0; i--) {
    const d = w.dots[i];
    d.x += move;
    if (d.phase === 'in' && d.x >= GATE_IN_X) {
      const ok = decide(w, p);
      recordDecision(w, ok);
      if (ok && p.algorithm === 'leaky') {
        // Absorbed into the queue; re-emitted later by the drain above.
        w.dots.splice(i, 1);
        continue;
      }
      d.phase = ok ? 'ok' : 'rej';
    }
    if (d.phase === 'ok' && d.x > GATE_OUT_X) d.y += (OK_Y - d.y) * ease;
    if (d.phase === 'rej') d.y += (REJ_Y - d.y) * ease;
    if (d.x > W + DOT_R) w.dots.splice(i, 1);
  }
}

/**
 * Rate limiter lab: one limiter guarding a service. Request dots flow in
 * from the left; the limiter admits them to the accepted lane or bounces
 * them to the rejected lane. The center visual switches with the algorithm
 * to show *why* each one accepts or rejects a burst differently.
 */
export default function RateLimitingSim() {
  const world = useRef<World>(initWorld(DEFAULT_CAPACITY));
  const [playing, setPlaying] = useState(true);
  const [algorithm, setAlgorithm] = useState<Algorithm>('token');
  const [reqRate, setReqRate] = useState(8);
  const [capacity, setCapacity] = useState(DEFAULT_CAPACITY);
  const [sustainedRate, setSustainedRate] = useState(5);
  const [, setTick] = useState(0);

  useRafLoop((dt) => {
    stepWorld(world.current, dt, { algorithm, reqRate, capacity, sustainedRate });
    setTick((t) => t + 1);
  }, playing);

  const w = world.current;

  const changeCapacity = (v: number) => {
    setCapacity(v);
    // Reconcile live so levels never exceed the new cap while paused.
    world.current.tokens = Math.min(world.current.tokens, v);
    world.current.queueDepth = Math.min(world.current.queueDepth, v);
  };

  const injectBurst = () => {
    const cur = world.current;
    for (let i = 0; i < BURST_SIZE; i++) {
      if (cur.dots.length >= MAX_DOTS) break;
      cur.dots.push({
        id: cur.nextId++,
        x: GATE_IN_X - 30 - i * 9,
        y: LANE_IN_Y,
        phase: 'in',
      });
    }
    setTick((t) => t + 1);
  };

  // Readouts.
  const sampleN = w.decisions.length;
  let acceptedSum = 0;
  for (const d of w.decisions) acceptedSum += d;
  const acceptedPct =
    sampleN > 0 ? `${Math.round((100 * acceptedSum) / sampleN)}%` : '—';
  const cap = Math.max(1, capacity);
  const slidingN = slidingCount(w);
  const level =
    algorithm === 'token'
      ? { label: 'tokens', value: `${Math.floor(w.tokens)} / ${capacity}` }
      : algorithm === 'leaky'
        ? { label: 'queue depth', value: `${w.queueDepth} / ${capacity}` }
        : algorithm === 'fixed'
          ? { label: 'window count', value: `${w.windowCount} / ${capacity}` }
          : { label: 'window count', value: `${slidingN} / ${capacity}` };

  // Center visual per algorithm (occupies y 50..160, above the gate).
  let centerVisual: ReactNode;
  if (algorithm === 'token') {
    const levelH = Math.max(0, Math.min(84, (w.tokens / cap) * 84));
    centerVisual = (
      <>
        <text x={320} y={60} textAnchor="middle" className="svg-label small muted">
          token bucket
        </text>
        <rect x={288} y={68} width={64} height={88} rx={4} className="f-inset s-border" />
        {levelH > 0.5 && (
          <rect x={290} y={154 - levelH} width={60} height={levelH} className="f-accent" opacity={0.55} />
        )}
        <text x={320} y={116} textAnchor="middle" className="svg-label">
          {Math.floor(w.tokens)}
        </text>
        <line x1={320} y1={156} x2={320} y2={162} className="s-border" />
      </>
    );
  } else if (algorithm === 'leaky') {
    const visible = Math.min(w.queueDepth, 10);
    centerVisual = (
      <>
        <text x={320} y={54} textAnchor="middle" className="svg-label small muted">
          queue {w.queueDepth}/{capacity}
        </text>
        <rect x={302} y={60} width={36} height={102} className="f-inset s-border" />
        {Array.from({ length: visible }, (_, i) => (
          <circle key={i} cx={320} cy={154 - i * 10} r={4} className="f-accent" />
        ))}
        {w.queueDepth > 10 && (
          <text x={346} y={72} className="svg-label small muted">
            +{w.queueDepth - 10}
          </text>
        )}
      </>
    );
  } else if (algorithm === 'fixed') {
    const elapsed = Math.max(0, Math.min(WINDOW_MS, w.simTime - w.windowStart));
    const frac = elapsed / WINDOW_MS;
    centerVisual = (
      <>
        <text x={320} y={60} textAnchor="middle" className="svg-label small muted">
          fixed window · 2s
        </text>
        <rect x={272} y={72} width={96} height={48} rx={6} className="f-inset s-border" />
        <text x={320} y={101} textAnchor="middle" className="svg-label">
          {w.windowCount}/{capacity}
        </text>
        <line x1={272} y1={131} x2={272} y2={147} className="s-muted" />
        <line x1={368} y1={131} x2={368} y2={147} className="s-muted" />
        <rect x={272} y={135} width={96} height={8} rx={2} className="f-border" />
        {frac > 0.01 && (
          <rect x={272} y={135} width={96 * frac} height={8} rx={2} className="f-accent" opacity={0.8} />
        )}
      </>
    );
  } else {
    centerVisual = (
      <>
        <text x={320} y={60} textAnchor="middle" className="svg-label small muted">
          sliding window · last 2s
        </text>
        <rect x={320} y={78} width={60} height={44} className="f-accent-dim" />
        <line x1={260} y1={122} x2={380} y2={122} className="s-border" />
        {w.slidingLog.map((t, i) => {
          const age = w.simTime - t;
          const x = 380 - (age / TIMELINE_MS) * 120;
          if (x < 260) return null;
          const inWin = age <= WINDOW_MS;
          return (
            <circle
              key={i}
              cx={x}
              cy={100}
              r={3}
              className={inWin ? 'f-accent' : 'f-muted'}
              opacity={inWin ? 1 : 0.5}
            />
          );
        })}
        <text x={380} y={136} textAnchor="end" className="svg-label small muted">
          now
        </text>
        <text x={320} y={154} textAnchor="middle" className="svg-label">
          {slidingN}/{capacity}
        </text>
      </>
    );
  }

  return (
    <SimFrame
      title="Rate limiter lab"
      playing={playing}
      onPlayPause={() => setPlaying((p) => !p)}
      onReset={() => {
        world.current = initWorld(capacity);
        setTick((t) => t + 1);
      }}
      controls={
        <>
          <SegmentedControl<Algorithm>
            label="Algorithm"
            value={algorithm}
            onChange={setAlgorithm}
            options={[
              { value: 'token', label: 'Token bucket' },
              { value: 'leaky', label: 'Leaky bucket' },
              { value: 'fixed', label: 'Fixed window' },
              { value: 'sliding', label: 'Sliding window' },
            ]}
          />
          <Slider
            label="Request rate"
            value={reqRate}
            min={1}
            max={50}
            onChange={setReqRate}
            format={(v) => `${v}/s`}
          />
          <Slider
            label={algorithm === 'fixed' || algorithm === 'sliding' ? 'Quota (per 2s)' : 'Capacity'}
            value={capacity}
            min={5}
            max={50}
            onChange={changeCapacity}
          />
          {(algorithm === 'token' || algorithm === 'leaky') && (
            <Slider
              label={algorithm === 'token' ? 'Refill rate' : 'Leak rate'}
              value={sustainedRate}
              min={1}
              max={30}
              onChange={setSustainedRate}
              format={(v) => `${v}/s`}
            />
          )}
          <Button onClick={injectBurst}>Burst +20</Button>
        </>
      }
      readouts={[
        { label: 'accepted (rolling)', value: acceptedPct },
        { label: 'rejected total', value: w.rejected },
        { label: level.label, value: level.value },
      ]}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Rate limiter simulation: requests flow through a ${ALGO_NAMES[algorithm]} limiter into accepted and rejected lanes`}
      >
        <rect x={1} y={1} width={W - 2} height={H - 2} rx={8} fill="none" className="s-border" />

        {/* Lanes */}
        <line
          x1={8}
          y1={LANE_IN_Y}
          x2={GATE_IN_X}
          y2={LANE_IN_Y}
          className="s-border"
          strokeDasharray="4 4"
        />
        <text x={10} y={LANE_IN_Y - 12} className="svg-label small muted">
          requests →
        </text>
        <line
          x1={GATE_OUT_X + 8}
          y1={OK_Y}
          x2={W - 8}
          y2={OK_Y}
          className="s-ok"
          opacity={0.4}
          strokeDasharray="4 4"
        />
        <text
          x={W - 8}
          y={OK_Y - 10}
          textAnchor="end"
          className="svg-label small"
          style={{ fill: 'var(--ok)' }}
        >
          accepted
        </text>
        <line
          x1={GATE_OUT_X + 8}
          y1={REJ_Y}
          x2={W - 8}
          y2={REJ_Y}
          className="s-danger"
          opacity={0.4}
          strokeDasharray="4 4"
        />
        <text
          x={W - 8}
          y={REJ_Y - 10}
          textAnchor="end"
          className="svg-label small"
          style={{ fill: 'var(--danger)' }}
        >
          rejected
        </text>

        {/* Limiter gate */}
        <rect
          x={GATE_IN_X}
          y={162}
          width={GATE_OUT_X - GATE_IN_X}
          height={36}
          rx={8}
          className="f-inset s-border"
        />

        {centerVisual}

        {/* Request dots */}
        {w.dots.map((d) => (
          <circle
            key={d.id}
            cx={d.x}
            cy={d.y}
            r={DOT_R}
            style={{
              fill:
                d.phase === 'ok'
                  ? 'var(--ok)'
                  : d.phase === 'rej'
                    ? 'var(--danger)'
                    : 'var(--accent-2)',
            }}
          />
        ))}
      </svg>
    </SimFrame>
  );
}
