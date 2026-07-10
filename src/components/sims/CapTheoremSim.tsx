import { useRef, useState } from 'react';
import { SimFrame } from './SimFrame';
import { SegmentedControl, Slider, Toggle } from './controls';
import { useRafLoop } from './hooks/useRafLoop';

const W = 640;
const H = 340;
const NODE_R = 26;
const CLIENT_R = 16;
const TRAVEL_MS = 450;
const PULSE_MS = 320;
const SYNC_MS = 900;
const FLASH_MS = 1600;
const MAX_REQUESTS = 100;
const MAX_PULSES = 60;
const AVAIL_WINDOW = 50;

const NODES = [
  { x: 185, y: 230 },
  { x: 300, y: 85 },
  { x: 455, y: 230 },
];
const CLIENTS = [
  { x: 60, y: 230 },
  { x: 580, y: 230 },
];
/** node index pairs for the three cluster links; links touching N3 (index 2) sever under partition */
const LINKS: [number, number][] = [
  [0, 1],
  [0, 2],
  [1, 2],
];

type Mode = 'CP' | 'AP';
type Outcome = 'ok' | 'stale' | 'rejected';

interface Request {
  id: number;
  side: 0 | 1; // 0 = left client → N1, 1 = right client → N3
  kind: 'write' | 'read';
  phase: 'to' | 'back';
  t: number; // ms elapsed in current phase
  outcome: Outcome | null; // set when the node responds
}

interface Pulse {
  from: number;
  to: number;
  t: number;
}

interface World {
  /** node values; invariant: v[0] === v[1] (majority side moves together) */
  v: [number, number, number];
  base: number; // converged value when the current partition began
  majW: number; // writes accepted by N1+N2 since partition began
  minW: number; // writes accepted by N3 since partition began
  requests: Request[];
  pulses: Pulse[];
  accL: number;
  accR: number;
  nL: number;
  nR: number;
  nextId: number;
  window: number[]; // rolling 1/0 outcomes for availability
  rejected: number;
  stale: number;
  lost: number;
  sync: { t: number; fromMaj: number; fromV3: number } | null;
  lostFlash: { amount: number; t: number } | null;
}

function initWorld(): World {
  return {
    v: [0, 0, 0],
    base: 0,
    majW: 0,
    minW: 0,
    requests: [],
    pulses: [],
    accL: 0,
    accR: 0,
    nL: 0,
    nR: 0,
    nextId: 1,
    window: [],
    rejected: 0,
    stale: 0,
    lost: 0,
    sync: null,
    lostFlash: null,
  };
}

function recordCompletion(w: World, accepted: boolean) {
  w.window.push(accepted ? 1 : 0);
  if (w.window.length > AVAIL_WINDOW) w.window.shift();
}

function addPulse(w: World, from: number, to: number) {
  if (w.pulses.length < MAX_PULSES) w.pulses.push({ from, to, t: 0 });
}

/** A request has reached its node: decide the outcome and apply effects. */
function resolveAtNode(w: World, r: Request, mode: Mode, partitioned: boolean) {
  if (r.side === 0) {
    // Majority side (N1+N2): quorum 2 of 3 always holds, so both modes accept.
    if (r.kind === 'write') {
      w.v[0]++;
      w.v[1]++;
      addPulse(w, 0, 1);
      if (partitioned) {
        w.majW++;
      } else {
        w.v[2]++;
        addPulse(w, 0, 2);
      }
    }
    r.outcome = 'ok';
    recordCompletion(w, true);
    return;
  }
  // Minority side (N3)
  if (!partitioned) {
    if (r.kind === 'write') {
      w.v[0]++;
      w.v[1]++;
      w.v[2]++;
      addPulse(w, 2, 0);
      addPulse(w, 2, 1);
    }
    r.outcome = 'ok';
    recordCompletion(w, true);
    return;
  }
  if (r.kind === 'write') {
    if (mode === 'CP') {
      // No quorum reachable: refuse the write.
      r.outcome = 'rejected';
      w.rejected++;
      recordCompletion(w, false);
    } else {
      // AP: accept locally and diverge.
      w.v[2]++;
      w.minW++;
      r.outcome = 'ok';
      recordCompletion(w, true);
    }
  } else {
    // Reads are served from N3's local (frozen or diverged) value: stale.
    r.outcome = 'stale';
    w.stale++;
    recordCompletion(w, true);
  }
}

/** Partition healed: reconcile the two sides. Last-write-wins keeps the side
 *  with more accepted writes; the loser's increments since the split are lost. */
function healWorld(w: World) {
  const lost = Math.min(w.majW, w.minW);
  const converged = w.base + Math.max(w.majW, w.minW);
  w.lost += lost;
  if (lost > 0) w.lostFlash = { amount: lost, t: 0 };
  w.sync = { t: 0, fromMaj: w.v[0], fromV3: w.v[2] };
  w.v = [converged, converged, converged];
  w.majW = 0;
  w.minW = 0;
}

function spawn(w: World, side: 0 | 1) {
  if (w.requests.length >= MAX_REQUESTS) return;
  const n = side === 0 ? w.nL : w.nR;
  const kind: Request['kind'] = n % 3 === 2 ? 'read' : 'write';
  w.requests.push({ id: w.nextId++, side, kind, phase: 'to', t: 0, outcome: null });
  if (side === 0) w.nL = (w.nL + 1) % 3;
  else w.nR = (w.nR + 1) % 3;
}

function stepWorld(w: World, dtMs: number, rate: number, mode: Mode, partitioned: boolean) {
  // Animations
  if (w.sync) {
    w.sync.t += dtMs;
    if (w.sync.t >= SYNC_MS) w.sync = null;
  }
  if (w.lostFlash) {
    w.lostFlash.t += dtMs;
    if (w.lostFlash.t >= FLASH_MS) w.lostFlash = null;
  }
  for (let i = w.pulses.length - 1; i >= 0; i--) {
    w.pulses[i].t += dtMs;
    if (w.pulses[i].t >= PULSE_MS) w.pulses.splice(i, 1);
  }

  // Spawn client requests: 2 writes + 1 read per cycle, so 1.5× the write
  // rate gives `rate` writes per second per client. Independent jitter lets
  // the two sides drift apart, which is what makes AP divergence visible.
  const spawnPerMs = (rate * 1.5) / 1000;
  w.accL = Math.min(w.accL + spawnPerMs * dtMs * (0.8 + 0.4 * Math.random()), 4);
  w.accR = Math.min(w.accR + spawnPerMs * dtMs * (0.8 + 0.4 * Math.random()), 4);
  while (w.accL >= 1) {
    w.accL -= 1;
    spawn(w, 0);
  }
  while (w.accR >= 1) {
    w.accR -= 1;
    spawn(w, 1);
  }

  // Advance in-flight requests.
  for (let i = w.requests.length - 1; i >= 0; i--) {
    const r = w.requests[i];
    r.t += dtMs;
    if (r.t < TRAVEL_MS) continue;
    if (r.phase === 'to') {
      resolveAtNode(w, r, mode, partitioned);
      r.phase = 'back';
      r.t = 0;
    } else {
      w.requests.splice(i, 1);
    }
  }
}

function linkPts(a: number, b: number) {
  const A = NODES[a];
  const B = NODES[b];
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return {
    x1: A.x + ux * NODE_R,
    y1: A.y + uy * NODE_R,
    x2: B.x - ux * NODE_R,
    y2: B.y - uy * NODE_R,
  };
}

function requestPos(r: Request) {
  const node = NODES[r.side === 0 ? 0 : 2];
  const client = CLIENTS[r.side];
  const dir = r.side === 0 ? 1 : -1;
  const sx = client.x + dir * (CLIENT_R + 6);
  const ex = node.x - dir * (NODE_R + 6);
  const p = Math.min(r.t / TRAVEL_MS, 1);
  const q = r.phase === 'to' ? p : 1 - p;
  return { x: sx + (ex - sx) * q, y: node.y + (r.phase === 'to' ? -7 : 7) };
}

function requestColor(r: Request): string {
  if (r.phase === 'to' || r.outcome === null) return 'var(--text-muted)';
  if (r.outcome === 'rejected') return 'var(--danger)';
  if (r.outcome === 'stale') return 'var(--accent-2)';
  return r.kind === 'write' ? 'var(--ok)' : 'var(--accent)';
}

/**
 * CAP theorem sim: a 3-node replicated counter under partition. CP mode keeps
 * the quorum side available and rejects the minority; AP mode accepts on both
 * sides and pays for it with divergence and lost writes at heal time.
 */
export default function CapTheoremSim() {
  const world = useRef<World>(initWorld());
  const [playing, setPlaying] = useState(true);
  const [mode, setMode] = useState<Mode>('CP');
  const [partitioned, setPartitioned] = useState(false);
  const [rate, setRate] = useState(6);
  const [, setTick] = useState(0);

  useRafLoop((dt) => {
    stepWorld(world.current, dt, rate, mode, partitioned);
    setTick((t) => t + 1);
  }, playing);

  const w = world.current;

  const handlePartition = (on: boolean) => {
    const cur = world.current;
    if (on) {
      cur.base = cur.v[0];
      cur.majW = 0;
      cur.minW = 0;
      cur.sync = null;
    } else {
      healWorld(cur);
    }
    setPartitioned(on);
    setTick((t) => t + 1);
  };

  // Displayed values: lerp the badge numbers during the post-heal sync so
  // N3 visibly catches up (and the majority jumps if the minority side won).
  const sync = w.sync;
  let dMaj = w.v[0];
  let dV3 = w.v[2];
  let syncP = 1;
  if (sync) {
    syncP = Math.min(sync.t / SYNC_MS, 1);
    dMaj = Math.round(sync.fromMaj + (w.v[0] - sync.fromMaj) * syncP);
    dV3 = Math.round(sync.fromV3 + (w.v[2] - sync.fromV3) * syncP);
  }
  const display = [dMaj, dMaj, dV3];
  const divergence = Math.abs(w.v[0] - w.v[2]);

  const accepted = w.window.reduce((a, b) => a + b, 0);
  const availability =
    w.window.length > 0 ? `${Math.round((100 * accepted) / w.window.length)}%` : '—';

  return (
    <SimFrame
      title="Partition a 3-node cluster"
      playing={playing}
      onPlayPause={() => setPlaying((p) => !p)}
      onReset={() => {
        world.current = initWorld();
        setPartitioned(false);
        setTick((t) => t + 1);
      }}
      controls={
        <>
          <SegmentedControl<Mode>
            label="Mode"
            options={[
              { value: 'CP', label: 'CP (quorum)' },
              { value: 'AP', label: 'AP (accept)' },
            ]}
            value={mode}
            onChange={setMode}
          />
          <Toggle label="Partition N3" checked={partitioned} onChange={handlePartition} />
          <Slider
            label="Write rate"
            value={rate}
            min={1}
            max={20}
            format={(v) => `${v}/s`}
            onChange={setRate}
          />
        </>
      }
      readouts={[
        { label: 'availability', value: availability },
        { label: 'rejected writes', value: w.rejected },
        { label: 'stale reads', value: w.stale },
        { label: 'lost writes', value: w.lost },
      ]}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Three replicated nodes in a triangle with two clients issuing reads and writes; a partition isolates node N3"
      >
        {/* Partition cut line */}
        {partitioned && (
          <line
            x1={378}
            y1={25}
            x2={378}
            y2={315}
            strokeWidth={2}
            strokeDasharray="7 7"
            style={{ stroke: 'var(--danger)' }}
          />
        )}

        {/* Cluster links */}
        {LINKS.map(([a, b]) => {
          const p = linkPts(a, b);
          const cut = partitioned && (a === 2 || b === 2);
          return cut ? (
            <line
              key={`${a}-${b}`}
              {...p}
              strokeWidth={1.5}
              strokeDasharray="5 5"
              style={{ stroke: 'var(--danger)' }}
            />
          ) : (
            <line key={`${a}-${b}`} {...p} strokeWidth={1.5} className="s-border" />
          );
        })}

        {/* Client↔node wires */}
        <line
          x1={CLIENTS[0].x + CLIENT_R}
          y1={CLIENTS[0].y}
          x2={NODES[0].x - NODE_R}
          y2={NODES[0].y}
          className="s-border"
        />
        <line
          x1={NODES[2].x + NODE_R}
          y1={NODES[2].y}
          x2={CLIENTS[1].x - CLIENT_R}
          y2={CLIENTS[1].y}
          className="s-border"
        />

        {/* Replication pulses */}
        {w.pulses.map((p, i) => {
          const pts = linkPts(p.from, p.to);
          const q = Math.min(p.t / PULSE_MS, 1);
          return (
            <circle
              key={`p${i}`}
              cx={pts.x1 + (pts.x2 - pts.x1) * q}
              cy={pts.y1 + (pts.y2 - pts.y1) * q}
              r={3}
              className="f-ok"
            />
          );
        })}

        {/* Post-heal sync animation: pulses streaming into N3 + a fading ring */}
        {w.sync &&
          [0, 1].map((from) =>
            [0, 0.5].map((off) => {
              const pts = linkPts(from, 2);
              const q = ((w.sync as { t: number }).t / 300 + off) % 1;
              return (
                <circle
                  key={`s${from}-${off}`}
                  cx={pts.x1 + (pts.x2 - pts.x1) * q}
                  cy={pts.y1 + (pts.y2 - pts.y1) * q}
                  r={3}
                  className="f-accent"
                />
              );
            }),
          )}
        {w.sync && (
          <circle
            cx={NODES[2].x}
            cy={NODES[2].y}
            r={NODE_R + 8}
            fill="none"
            strokeWidth={2}
            style={{ stroke: 'var(--accent)', opacity: 1 - syncP }}
          />
        )}

        {/* Nodes */}
        {NODES.map((n, i) => (
          <g key={`n${i}`}>
            <circle
              cx={n.x}
              cy={n.y}
              r={NODE_R}
              className="f-inset"
              strokeWidth={2}
              style={{
                stroke: partitioned && i === 2 ? 'var(--danger)' : 'var(--accent)',
              }}
            />
            <text x={n.x} y={n.y + 5} textAnchor="middle" className="svg-label">
              N{i + 1}
            </text>
            <text
              x={n.x}
              y={i === 1 ? n.y - NODE_R - 12 : n.y + NODE_R + 20}
              textAnchor="middle"
              className="svg-label small"
              style={{
                fill:
                  partitioned && i === 2
                    ? mode === 'CP'
                      ? 'var(--text-muted)'
                      : 'var(--accent-2)'
                    : 'var(--text)',
              }}
            >
              x={display[i]}
            </text>
          </g>
        ))}

        {/* N3 status while partitioned */}
        {partitioned && (
          <text
            x={NODES[2].x}
            y={NODES[2].y + NODE_R + 38}
            textAnchor="middle"
            className="svg-label small muted"
          >
            {mode === 'CP' ? 'frozen — no quorum' : `diverged by ${divergence}`}
          </text>
        )}

        {/* Clients */}
        {CLIENTS.map((c, i) => (
          <g key={`c${i}`}>
            <circle cx={c.x} cy={c.y} r={CLIENT_R} className="f-accent-dim" />
            <circle cx={c.x} cy={c.y} r={CLIENT_R} fill="none" className="s-accent" />
            <text x={c.x} y={c.y - CLIENT_R - 8} textAnchor="middle" className="svg-label small muted">
              client {i === 0 ? 'A' : 'B'}
            </text>
          </g>
        ))}

        {/* In-flight requests */}
        {w.requests.map((r) => {
          const pos = requestPos(r);
          return <circle key={r.id} cx={pos.x} cy={pos.y} r={5} style={{ fill: requestColor(r) }} />;
        })}

        {/* Divergence indicator (AP under partition) */}
        {partitioned && mode === 'AP' && (
          <g>
            <text x={W / 2} y={22} textAnchor="middle" className="svg-label small muted">
              divergence Δ{divergence}
            </text>
            <rect
              x={W / 2 - Math.min(divergence * 4, 240) / 2}
              y={28}
              width={Math.min(divergence * 4, 240)}
              height={4}
              rx={2}
              style={{ fill: 'var(--accent-2)' }}
            />
          </g>
        )}

        {/* Lost-writes flash after an AP heal */}
        {w.lostFlash && (
          <text
            x={NODES[2].x}
            y={NODES[2].y - NODE_R - 16 - 24 * (w.lostFlash.t / FLASH_MS)}
            textAnchor="middle"
            className="svg-label"
            style={{ fill: 'var(--danger)', opacity: 1 - w.lostFlash.t / FLASH_MS }}
          >
            −{w.lostFlash.amount} writes lost
          </text>
        )}

        {/* Legend */}
        <g>
          <circle cx={24} cy={324} r={4} className="f-ok" />
          <text x={33} y={328} className="svg-label small muted">
            write
          </text>
          <circle cx={92} cy={324} r={4} className="f-accent" />
          <text x={101} y={328} className="svg-label small muted">
            read
          </text>
          <circle cx={158} cy={324} r={4} className="f-accent-2" />
          <text x={167} y={328} className="svg-label small muted">
            stale
          </text>
          <circle cx={226} cy={324} r={4} className="f-danger" />
          <text x={235} y={328} className="svg-label small muted">
            rejected
          </text>
        </g>
      </svg>
    </SimFrame>
  );
}
