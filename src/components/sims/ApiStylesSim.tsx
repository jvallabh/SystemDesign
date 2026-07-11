import { useRef, useState } from 'react';
import { SimFrame } from './SimFrame';
import { Slider, SegmentedControl } from './controls';
import { useRafLoop } from './hooks/useRafLoop';

const W = 640;
const H = 340;
const LANE_TOP0 = 10;
const LANE_H = 78;
const CLIENT_X = 8;
const SERVER_X = 568;
const BOX_W = 64;
const BOX_H = 34;
const WIRE_X0 = CLIENT_X + BOX_W;
const WIRE_X1 = SERVER_X;
const MSG_X0 = 84; // message-center travel range
const MSG_X1 = 556;
const RACE_GAP_MS = 700; // idle pause between races (anim ms)
const PAR_STAGGER_MS = 60; // visual stagger for multiplexed calls
const BYTES_PER_MS = 1000; // payload factor: ~1 KB per simulated ms

const STYLES = ['REST', 'GraphQL', 'gRPC', 'tRPC'] as const;
type ApiStyle = (typeof STYLES)[number];
type Scenario = 'nested' | 'crud' | 's2s' | 'realtime';

interface Call {
  req: number; // request bytes (illustrative)
  resp: number; // response bytes (illustrative)
  label?: string; // endpoint shown above the request (REST nested)
}

interface LanePlan {
  /** seq = sequential round trips; par = concurrent calls muxed on one connection. */
  mode: 'seq' | 'par';
  calls: Call[];
  /** Server-pushed messages after the handshake (streaming / subscriptions). */
  pushes?: { count: number; bytes: number; gapMs: number };
}

interface Trip {
  t0: number; // anim ms within the race cycle
  t1: number;
  dir: 1 | -1; // 1 = client→server
  kind: 'req' | 'resp' | 'query' | 'frame';
  w: number;
  h: number;
  header: boolean; // REST's fat header block
  label?: string; // endpoint shown above the message
}

interface LaneSpec {
  style: ApiStyle;
  trips: Trip[]; // fixed-size (≤12), rebuilt from params — never grows
  endMs: number; // anim ms when this lane finishes
  rt: number;
  bytes: number;
  timeMs: number; // simulated time-to-complete: rt × latency + bytes payload factor
  annot: string;
}

interface World {
  raceMs: number; // anim clock within the current race cycle
  races: number;
}

const call = (req: number, resp: number): Call => ({ req, resp });
const rep = (n: number, req: number, resp: number): Call[] =>
  Array.from({ length: n }, () => ({ req, resp }));

/** Illustrative message plans. Byte counts are for intuition, not benchmarks. */
const PLAN: Record<Scenario, Record<ApiStyle, LanePlan>> = {
  nested: {
    REST: {
      mode: 'seq',
      calls: [
        { req: 700, resp: 13300, label: '/user' },
        { req: 700, resp: 13300, label: '/orders' },
        { req: 700, resp: 13300, label: '/items' },
      ],
    },
    GraphQL: { mode: 'seq', calls: [call(600, 2000)] },
    gRPC: { mode: 'seq', calls: rep(3, 120, 400) },
    tRPC: { mode: 'seq', calls: [call(400, 2800)] },
  },
  crud: {
    REST: { mode: 'seq', calls: [call(500, 700)] },
    GraphQL: { mode: 'seq', calls: [call(500, 600)] },
    gRPC: { mode: 'seq', calls: [call(100, 250)] },
    tRPC: { mode: 'seq', calls: [call(350, 500)] },
  },
  s2s: {
    REST: { mode: 'seq', calls: rep(3, 700, 2000) },
    GraphQL: { mode: 'seq', calls: rep(3, 400, 900) },
    gRPC: { mode: 'par', calls: rep(3, 100, 300) },
    tRPC: { mode: 'seq', calls: [call(600, 1800)] },
  },
  realtime: {
    REST: { mode: 'seq', calls: rep(6, 700, 400) },
    GraphQL: { mode: 'seq', calls: [call(600, 200)], pushes: { count: 4, bytes: 300, gapMs: 430 } },
    gRPC: { mode: 'seq', calls: [call(100, 100)], pushes: { count: 10, bytes: 160, gapMs: 170 } },
    tRPC: { mode: 'seq', calls: [call(400, 200)], pushes: { count: 4, bytes: 350, gapMs: 430 } },
  },
};

const ANNOT: Record<Scenario, Record<ApiStyle, string>> = {
  nested: {
    REST: '3 dependent fetches · whole resources',
    GraphQL: 'one query names exactly the fields needed',
    gRPC: '3 dependent unary calls · protobuf',
    tRPC: 'one typed procedure · JSON response',
  },
  crud: {
    REST: 'one verb, one resource · HTTP-cacheable',
    GraphQL: 'query via single /graphql endpoint',
    gRPC: 'unary call · binary protobuf',
    tRPC: 'typed procedure call · JSON',
  },
  s2s: {
    REST: 'JSON + full headers on every call',
    GraphQL: 'one query per downstream call',
    gRPC: '3 calls muxed on one HTTP/2 channel',
    tRPC: 'batched procedures · one round trip',
  },
  realtime: {
    REST: 'polling · repeated request/response',
    GraphQL: 'subscription · pushed updates',
    gRPC: 'server streaming · continuous frames',
    tRPC: 'subscription · pushed updates',
  },
};

/** Honest best-fit matrix — not always the fastest wire. */
const BEST_FIT: Record<Scenario, { lane: ApiStyle; why: string }> = {
  nested: { lane: 'GraphQL', why: 'one round trip, exact fields' },
  crud: { lane: 'REST', why: 'cacheable + universal clients' },
  s2s: { lane: 'gRPC', why: 'binary + multiplexed channel' },
  realtime: { lane: 'gRPC', why: 'native server streaming' },
};

const SCENARIO_OPTIONS: { value: Scenario; label: string }[] = [
  { value: 'nested', label: 'Nested page data' },
  { value: 'crud', label: 'Simple CRUD' },
  { value: 's2s', label: 'Service-to-service' },
  { value: 'realtime', label: 'Realtime updates' },
];

/** Deterministic — identical markup on server and client. */
function initWorld(): World {
  return { raceMs: 0, races: 0 };
}

function stepWorld(w: World, dtMs: number, totalMs: number) {
  w.raceMs += dtMs;
  if (totalMs <= 0) return;
  if (w.raceMs >= totalMs) {
    // Modulo, not a loop: a mid-race latency drop can shrink the cycle far
    // below the stale raceMs, and that should count one finished race — the
    // loop would credit several phantom races in a single frame.
    w.raceMs %= totalMs;
    w.races++;
  }
}

function reqTrip(style: ApiStyle, t0: number, oneWay: number, c: Call): Trip {
  const t1 = t0 + oneWay;
  if (style === 'gRPC') return { t0, t1, dir: 1, kind: 'frame', w: 7, h: 7, header: false };
  if (style === 'GraphQL') return { t0, t1, dir: 1, kind: 'query', w: 16, h: 12, header: false };
  return {
    t0,
    t1,
    dir: 1,
    kind: 'req',
    w: Math.min(20, 8 + c.req / 60),
    h: 8,
    header: style === 'REST',
    label: c.label,
  };
}

function respTrip(style: ApiStyle, t0: number, durMs: number, respB: number): Trip {
  const t1 = t0 + durMs;
  if (style === 'gRPC') return { t0, t1, dir: -1, kind: 'frame', w: 7, h: 7, header: false };
  return {
    t0,
    t1,
    dir: -1,
    kind: 'resp',
    w: Math.min(44, Math.max(10, 8 + respB / 400)),
    h: 10,
    header: style === 'REST',
  };
}

/**
 * Builds a lane's animation schedule and stats from the scenario plan.
 * Animation time is a readability-scaled proxy for the simulated math:
 * one-way hop = 260 + 2·latency anim ms; big payloads travel longer.
 */
function buildLane(style: ApiStyle, scenario: Scenario, latencyMs: number): LaneSpec {
  const plan = PLAN[scenario][style];
  const oneWay = 260 + latencyMs * 2;
  const trips: Trip[] = [];
  let bytes = 0;
  let endMs = 0;

  if (plan.mode === 'par') {
    plan.calls.forEach((c, i) => {
      const start = i * PAR_STAGGER_MS;
      trips.push(reqTrip(style, start, oneWay, c));
      const respDur = oneWay + c.resp / 500;
      trips.push(respTrip(style, start + oneWay, respDur, c.resp));
      endMs = Math.max(endMs, start + oneWay + respDur);
      bytes += c.req + c.resp;
    });
  } else {
    let t = 0;
    for (const c of plan.calls) {
      trips.push(reqTrip(style, t, oneWay, c));
      t += oneWay;
      const respDur = oneWay + c.resp / 500;
      trips.push(respTrip(style, t, respDur, c.resp));
      t += respDur;
      bytes += c.req + c.resp;
    }
    endMs = t;
    if (plan.pushes) {
      const { count, bytes: pb, gapMs } = plan.pushes;
      for (let k = 0; k < count; k++) {
        const t0 = t + k * gapMs;
        trips.push(
          style === 'gRPC'
            ? { t0, t1: t0 + oneWay, dir: -1, kind: 'frame', w: 7, h: 7, header: false }
            : {
                t0,
                t1: t0 + oneWay,
                dir: -1,
                kind: 'resp',
                w: Math.min(16, 6 + pb / 50),
                h: 8,
                header: false,
              },
        );
        bytes += pb;
      }
      endMs = t + (count - 1) * gapMs + oneWay;
    }
  }

  const rt = plan.mode === 'par' ? 1 : plan.calls.length;
  const timeMs = rt * latencyMs + bytes / BYTES_PER_MS;
  return { style, trips, endMs, rt, bytes, timeMs, annot: ANNOT[scenario][style] };
}

function fmtBytes(b: number): string {
  if (b >= 1000) return `~${(b / 1000).toFixed(1).replace(/\.0$/, '')} KB`;
  return `~${b} B`;
}

/**
 * API style racer: REST, GraphQL, gRPC and tRPC lanes run the same workload
 * side by side, animating each style's wire pattern — REST's sequential
 * header-heavy round trips, GraphQL's single tailored query, gRPC's compact
 * frames on a persistent channel, tRPC's typed procedure call.
 */
export default function ApiStylesSim() {
  const world = useRef<World>(initWorld());
  const [playing, setPlaying] = useState(true);
  const [scenario, setScenario] = useState<Scenario>('nested');
  const [latency, setLatency] = useState(80);
  const [, setTick] = useState(0);

  const lanes = STYLES.map((s) => buildLane(s, scenario, latency));
  const fastest = lanes.reduce((a, b) => (b.timeMs < a.timeMs ? b : a));
  const totalMs = Math.max(...lanes.map((l) => l.endMs)) + RACE_GAP_MS;
  const bestFit = BEST_FIT[scenario];

  useRafLoop((dt) => {
    stepWorld(world.current, dt, totalMs);
    setTick((t) => t + 1);
  }, playing);

  const p = world.current.raceMs;

  return (
    <SimFrame
      title="API style racer"
      playing={playing}
      onPlayPause={() => setPlaying((v) => !v)}
      onReset={() => {
        world.current = initWorld();
        setTick((t) => t + 1);
      }}
      controls={
        <>
          <SegmentedControl
            label="Scenario"
            options={SCENARIO_OPTIONS}
            value={scenario}
            onChange={(s) => {
              // Restart the race phase so the new schedule plays from the top
              // (otherwise a stale raceMs can exceed the new, shorter cycle).
              world.current.raceMs = 0;
              setScenario(s);
            }}
          />
          <Slider
            label="Latency"
            value={latency}
            min={10}
            max={200}
            step={10}
            format={(v) => `${v} ms`}
            onChange={setLatency}
          />
        </>
      }
      readouts={[
        { label: 'fastest wire', value: `${fastest.style} · ${Math.round(fastest.timeMs)} ms` },
        { label: 'best fit', value: bestFit.lane },
        { label: 'why', value: bestFit.why },
        { label: 'tRPC', value: 'best DX in full-TS stacks' },
        { label: 'races', value: world.current.races },
      ]}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Four lanes racing the same workload: REST, GraphQL, gRPC and tRPC clients exchanging their message patterns with servers"
      >
        <text x={CLIENT_X + BOX_W / 2} y={9} textAnchor="middle" className="svg-label small muted">
          client
        </text>
        <text x={SERVER_X + BOX_W / 2} y={9} textAnchor="middle" className="svg-label small muted">
          server
        </text>

        {lanes.map((lane, i) => {
          const top = LANE_TOP0 + i * LANE_H;
          const wy = top + 33;
          const finished = p >= lane.endMs;
          const isFastest = lane.style === fastest.style;
          return (
            <g key={lane.style}>
              {/* Wire (gRPC gets a persistent-channel band) */}
              <line x1={WIRE_X0} y1={wy} x2={WIRE_X1} y2={wy} className="s-border" />
              {lane.style === 'gRPC' && (
                <rect x={WIRE_X0 + 2} y={wy - 5} width={WIRE_X1 - WIRE_X0 - 4} height={10} rx={5} className="f-accent-dim" />
              )}

              {/* tRPC shared-types badge linking client and server code */}
              {lane.style === 'tRPC' && (
                <g>
                  <line
                    x1={280}
                    y1={top + 9}
                    x2={WIRE_X0}
                    y2={top + 18}
                    className="s-accent-2"
                    strokeDasharray="3 3"
                    opacity={0.55}
                  />
                  <line
                    x1={360}
                    y1={top + 9}
                    x2={SERVER_X}
                    y2={top + 18}
                    className="s-accent-2"
                    strokeDasharray="3 3"
                    opacity={0.55}
                  />
                  <rect x={276} y={top + 2} width={88} height={14} rx={7} className="f-inset s-accent-2" />
                  <text
                    x={320}
                    y={top + 12}
                    textAnchor="middle"
                    className="svg-label small"
                    style={{ fill: 'var(--accent-2)' }}
                  >
                    shared types
                  </text>
                </g>
              )}

              {/* Client box (highlighted when this lane has the fastest wire time) */}
              <rect
                x={CLIENT_X}
                y={top + 16}
                width={BOX_W}
                height={BOX_H}
                rx={6}
                className="f-inset"
                style={{
                  stroke: isFastest ? 'var(--accent)' : 'var(--border)',
                  strokeWidth: isFastest ? 1.5 : 1,
                }}
              />
              <text
                x={CLIENT_X + BOX_W / 2}
                y={wy + 4}
                textAnchor="middle"
                className="svg-label small"
                style={isFastest ? { fill: 'var(--accent)' } : undefined}
              >
                {lane.style}
              </text>

              {/* Server box (border turns green when this lane's race is done) */}
              <rect
                x={SERVER_X}
                y={top + 16}
                width={BOX_W}
                height={BOX_H}
                rx={6}
                className="f-inset"
                style={{ stroke: finished ? 'var(--ok)' : 'var(--border)', strokeWidth: 1 }}
              />
              <text
                x={SERVER_X + BOX_W / 2}
                y={wy + 4}
                textAnchor="middle"
                className="svg-label small muted"
              >
                server
              </text>

              {/* In-flight messages (schedules are fixed-size; ≤12 trips per lane) */}
              {lane.trips.map((t, j) => {
                if (p < t.t0 || p >= t.t1) return null;
                const prog = Math.min(Math.max((p - t.t0) / (t.t1 - t.t0), 0), 1);
                const span = MSG_X1 - MSG_X0;
                const cx = t.dir === 1 ? MSG_X0 + span * prog : MSG_X1 - span * prog;
                if (t.kind === 'frame') {
                  // Short train of dots: compact binary frames on the channel.
                  const cls = t.dir === 1 ? 'f-accent-2' : 'f-accent';
                  return (
                    <g key={j}>
                      {[0, 11, 22].map((off) => {
                        const dx = cx - off * t.dir;
                        if (dx < MSG_X0 || dx > MSG_X1) return null;
                        return <circle key={off} cx={dx} cy={wy} r={3.5} className={cls} />;
                      })}
                    </g>
                  );
                }
                const bodyClass = t.dir === 1 ? 'f-accent-2' : 'f-accent';
                const totalW = t.header ? t.w + 7 : t.w;
                const x0 = cx - totalW / 2;
                return (
                  <g key={j}>
                    {t.header && (
                      <rect x={x0} y={wy - t.h / 2} width={7} height={t.h} rx={1.5} className="f-muted" />
                    )}
                    <rect
                      x={t.header ? x0 + 7 : x0}
                      y={wy - t.h / 2}
                      width={t.w}
                      height={t.h}
                      rx={2}
                      className={bodyClass}
                    />
                    {t.kind === 'query' && (
                      <g className="s-border" strokeWidth={1.2}>
                        <line x1={cx - 4} y1={wy - 2.5} x2={cx + 4} y2={wy - 2.5} />
                        <line x1={cx - 4} y1={wy + 0.5} x2={cx + 2} y2={wy + 0.5} />
                        <line x1={cx - 4} y1={wy + 3.5} x2={cx + 3} y2={wy + 3.5} />
                      </g>
                    )}
                    {t.label && (
                      <text x={cx} y={wy - 9} textAnchor="middle" className="svg-label small muted">
                        {t.label}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* Per-lane annotation + mini readouts */}
              <text x={320} y={top + 62} textAnchor="middle" className="svg-label small muted">
                {lane.annot}
              </text>
              <text x={320} y={top + 75} textAnchor="middle" className="svg-label small">
                {`${lane.rt} RT · ${fmtBytes(lane.bytes)} · ${Math.round(lane.timeMs)} ms`}
              </text>
            </g>
          );
        })}

        <text x={W - 8} y={H - 3} textAnchor="end" className="svg-label small muted">
          byte counts illustrative
        </text>
      </svg>
    </SimFrame>
  );
}
