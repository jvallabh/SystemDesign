import { useRef, useState } from 'react';
import { SimFrame } from './SimFrame';
import { Slider } from './controls';
import { useRafLoop } from './hooks/useRafLoop';

const W = 640;
const H = 340;
const X0 = 88; // timeline left edge (lane labels live to the left)
const X1 = 628; // timeline right edge = "now"
const WINDOW_MS = 20000; // visible history
const PX_PER_MS = (X1 - X0) / WINDOW_MS;

const EV_Y = 52; // shared event source lane
const SP_Y = 124; // short polling lane
const LP_Y = 196; // long polling lane
const WS_Y = 268; // websocket lane
const AXIS_Y = 306;

const LP_TIMEOUT_MS = 15000; // idle long-poll re-request
const LP_GAP_MS = 250; // blind window between response and re-ask
const SP_PAIR_BYTES = 700; // headers per poll request/response pair
const LP_CYCLE_BYTES = 700; // headers per completed long-poll cycle
const WS_FRAME_BYTES = 6; // frame header + tiny payload
const WS_HANDSHAKE_BYTES = 1000; // one-time upgrade cost

const RATE_WIN_MS = 20000; // rolling window for req/min and bytes/s
const MAX_LATS = 30; // rolling latency sample size per lane
const MAX_EVENTS = 240;
const MAX_POLLS = 160;
const MAX_SEGMENTS = 80;
const MAX_DELIVERIES = 240;
const MAX_BYTE_EVTS = 400;

interface SimEvent {
  t: number; // when the server produced it
}

interface Poll {
  t: number; // response time
  hit: boolean; // carried at least one event
}

interface Delivery {
  eventT: number; // when the event fired
  t: number; // when the client learned of it
  lat: number; // t - eventT
}

interface LpSegment {
  start: number;
  end: number | null; // null = still held open
  byEvent: boolean; // completed by a delivery (vs idle timeout)
}

interface ByteEvt {
  t: number;
  b: number;
}

interface Params {
  eventRate: number; // events per second
  pollIntervalS: number; // short-poll interval, seconds
}

interface World {
  simTime: number;
  events: SimEvent[];
  // short polling
  lastPollAt: number;
  spCursor: number; // events up to here already delivered by polls
  polls: Poll[];
  spDeliveries: Delivery[];
  // long polling
  lpOpenSince: number | null;
  lpReopenAt: number;
  lpCursor: number;
  lpSegments: LpSegment[];
  lpDeliveries: Delivery[];
  // websocket
  wsCursor: number;
  wsDeliveries: Delivery[];
  // rolling stats
  httpReqs: number[]; // timestamps of HTTP request cycles (polls + long-poll opens)
  spBytes: ByteEvt[];
  lpBytes: ByteEvt[];
  wsBytes: ByteEvt[];
  spLats: number[];
  lpLats: number[];
  wsLats: number[];
}

// Deterministic: no Math.random here so SSR and hydration markup match.
function initWorld(): World {
  return {
    simTime: 0,
    events: [],
    lastPollAt: 0,
    spCursor: 0,
    polls: [],
    spDeliveries: [],
    lpOpenSince: 0,
    lpReopenAt: 0,
    lpCursor: 0,
    lpSegments: [{ start: 0, end: null, byEvent: false }],
    lpDeliveries: [],
    wsCursor: 0,
    wsDeliveries: [],
    httpReqs: [0], // the initial long-poll request
    spBytes: [],
    lpBytes: [],
    wsBytes: [{ t: 0, b: WS_HANDSHAKE_BYTES }], // upgrade handshake
    spLats: [],
    lpLats: [],
    wsLats: [],
  };
}

function pushCap(arr: number[], v: number, cap: number) {
  arr.push(v);
  if (arr.length > cap) arr.shift();
}

function pruneBefore<T>(arr: T[], key: (x: T) => number, cutoff: number, cap: number) {
  while (arr.length > 0 && key(arr[0]) < cutoff) arr.shift();
  while (arr.length > cap) arr.shift();
}

function stepWorld(w: World, dtMs: number, p: Params) {
  w.simTime += dtMs;
  const now = w.simTime;
  const dtS = dtMs / 1000;

  // Server events: Poisson approximation (dt is small relative to 1/rate).
  if (p.eventRate > 0 && Math.random() < p.eventRate * dtS && w.events.length < MAX_EVENTS) {
    w.events.push({ t: now });
  }

  // --- Short polling: fixed-cadence request/response pairs ---
  const intMs = Math.max(100, p.pollIntervalS * 1000);
  let guard = 0;
  while (w.lastPollAt + intMs <= now && guard++ < 60) {
    const pt = w.lastPollAt + intMs;
    w.lastPollAt = pt;
    let hit = false;
    for (const e of w.events) {
      if (e.t > w.spCursor && e.t <= pt) {
        hit = true;
        const lat = pt - e.t;
        w.spDeliveries.push({ eventT: e.t, t: pt, lat });
        pushCap(w.spLats, lat, MAX_LATS);
      }
    }
    w.spCursor = pt;
    w.polls.push({ t: pt, hit });
    w.httpReqs.push(pt);
    w.spBytes.push({ t: pt, b: SP_PAIR_BYTES });
  }

  // --- Long polling: held-open request completes on event or idle timeout ---
  guard = 0;
  while (guard++ < 40) {
    if (w.lpOpenSince === null) {
      if (now < w.lpReopenAt) break;
      w.lpOpenSince = w.lpReopenAt;
      w.lpSegments.push({ start: w.lpOpenSince, end: null, byEvent: false });
      w.httpReqs.push(w.lpOpenSince);
      continue;
    }
    const open = w.lpOpenSince;
    let firstPending: SimEvent | null = null;
    for (const e of w.events) {
      if (e.t > w.lpCursor) {
        firstPending = e;
        break;
      }
    }
    const timeoutAt = open + LP_TIMEOUT_MS;
    // Events buffered during the blind gap complete the request the moment it opens.
    const trigger = firstPending ? Math.max(firstPending.t, open) : Infinity;
    const seg = w.lpSegments[w.lpSegments.length - 1];
    if (trigger <= now && trigger <= timeoutAt) {
      const respLat = 25 + Math.random() * 35; // response travel time, ms
      const deliveredAt = trigger + respLat;
      for (const e of w.events) {
        if (e.t > w.lpCursor && e.t <= trigger) {
          w.lpDeliveries.push({ eventT: e.t, t: deliveredAt, lat: deliveredAt - e.t });
          pushCap(w.lpLats, deliveredAt - e.t, MAX_LATS);
        }
      }
      w.lpCursor = trigger;
      seg.end = deliveredAt;
      seg.byEvent = true;
      w.lpBytes.push({ t: deliveredAt, b: LP_CYCLE_BYTES });
      w.lpOpenSince = null;
      w.lpReopenAt = deliveredAt + LP_GAP_MS;
    } else if (timeoutAt <= now) {
      seg.end = timeoutAt;
      seg.byEvent = false;
      w.lpBytes.push({ t: timeoutAt, b: LP_CYCLE_BYTES }); // empty cycle, same header cost
      w.lpOpenSince = null;
      w.lpReopenAt = timeoutAt + LP_GAP_MS;
    } else {
      break;
    }
  }

  // --- WebSocket: push a frame the instant an event fires ---
  for (const e of w.events) {
    if (e.t > w.wsCursor && e.t <= now) {
      const lat = 8 + Math.random() * 14; // one-way frame travel, ms
      w.wsDeliveries.push({ eventT: e.t, t: e.t + lat, lat });
      pushCap(w.wsLats, lat, MAX_LATS);
      w.wsBytes.push({ t: e.t, b: WS_FRAME_BYTES });
      w.wsCursor = e.t;
    }
  }

  // --- Prune everything to the visible / rolling windows ---
  const cut = now - WINDOW_MS - 1500;
  pruneBefore(w.events, (e) => e.t, cut, MAX_EVENTS);
  pruneBefore(w.polls, (x) => x.t, cut, MAX_POLLS);
  pruneBefore(w.spDeliveries, (d) => d.t, cut, MAX_DELIVERIES);
  pruneBefore(w.lpDeliveries, (d) => d.t, cut, MAX_DELIVERIES);
  pruneBefore(w.wsDeliveries, (d) => d.t, cut, MAX_DELIVERIES);
  while (
    w.lpSegments.length > 1 &&
    w.lpSegments[0].end !== null &&
    w.lpSegments[0].end < cut
  ) {
    w.lpSegments.shift();
  }
  while (w.lpSegments.length > MAX_SEGMENTS) w.lpSegments.shift();
  const cutR = now - RATE_WIN_MS;
  while (w.httpReqs.length > 0 && w.httpReqs[0] < cutR) w.httpReqs.shift();
  while (w.httpReqs.length > MAX_BYTE_EVTS) w.httpReqs.shift();
  pruneBefore(w.spBytes, (b) => b.t, cutR, MAX_BYTE_EVTS);
  pruneBefore(w.lpBytes, (b) => b.t, cutR, MAX_BYTE_EVTS);
  pruneBefore(w.wsBytes, (b) => b.t, cutR, MAX_BYTE_EVTS);
}

function tToX(t: number, now: number): number {
  return X1 - (now - t) * PX_PER_MS;
}

function fmtLat(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function avgOrDash(arr: number[]): string {
  if (arr.length === 0) return '—';
  let sum = 0;
  for (const v of arr) sum += v;
  return fmtLat(sum / arr.length);
}

function fmtBps(v: number): string {
  if (v >= 995) return `${(v / 1000).toFixed(1)}k`;
  if (v >= 10) return String(Math.round(v));
  return v.toFixed(1);
}

function bytesPerSec(arr: ByteEvt[], winS: number): number {
  let sum = 0;
  for (const b of arr) sum += b.b;
  return sum / winS;
}

/** Latency labels for a lane, skipping any that would overlap the previous one. */
function laneLabels(deliveries: Delivery[], now: number): { x: number; text: string }[] {
  const out: { x: number; text: string }[] = [];
  let lastX = -Infinity;
  for (const d of deliveries) {
    const x = tToX(d.t, now);
    if (x < X0) continue;
    if (x - lastX >= 48) {
      out.push({ x: Math.min(x, X1 - 16), text: fmtLat(d.lat) });
      lastX = x;
    }
  }
  return out;
}

/**
 * Realtime delivery race: one Poisson event source feeds three delivery
 * mechanisms — short polling, long polling, and a WebSocket — drawn as
 * scrolling timeline lanes. Each lane shows when its client actually
 * learns of each event, making the latency/overhead trade-off visible.
 */
export default function PollingWebSocketsSim() {
  const world = useRef<World>(initWorld());
  const [playing, setPlaying] = useState(true);
  const [eventRate, setEventRate] = useState(0.6);
  const [pollIntervalS, setPollIntervalS] = useState(2);
  const [, setTick] = useState(0);

  useRafLoop((dt) => {
    stepWorld(world.current, dt, { eventRate, pollIntervalS });
    setTick((t) => t + 1);
  }, playing);

  const w = world.current;
  const now = w.simTime;

  // Readouts over the rolling window (guard the cold start against tiny denominators).
  const winMs = Math.min(Math.max(now, 1), RATE_WIN_MS);
  const warm = now >= 500;
  const winS = winMs / 1000;
  const reqPerMin = warm ? String(Math.round((w.httpReqs.length * 60000) / winMs)) : '—';
  const overhead = warm
    ? `${fmtBps(bytesPerSec(w.spBytes, winS))} · ${fmtBps(bytesPerSec(w.lpBytes, winS))} · ${fmtBps(bytesPerSec(w.wsBytes, winS))}`
    : '—';

  // 5-second grid lines inside the visible window.
  const grid: number[] = [];
  for (let t = Math.max(0, Math.ceil((now - WINDOW_MS) / 5000) * 5000); t <= now; t += 5000) {
    grid.push(t);
  }

  const handshakeX = tToX(0, now);
  const spLabels = laneLabels(w.spDeliveries, now);
  const lpLabels = laneLabels(w.lpDeliveries, now);
  const wsLabels = laneLabels(w.wsDeliveries, now);

  return (
    <SimFrame
      title="Realtime delivery race"
      playing={playing}
      onPlayPause={() => setPlaying((p) => !p)}
      onReset={() => {
        world.current = initWorld();
        setTick((t) => t + 1);
      }}
      controls={
        <>
          <Slider
            label="Event rate"
            value={eventRate}
            min={0.1}
            max={3}
            step={0.1}
            onChange={setEventRate}
            format={(v) => `${v.toFixed(1)}/s`}
          />
          <Slider
            label="Poll interval"
            value={pollIntervalS}
            min={0.5}
            max={5}
            step={0.5}
            onChange={setPollIntervalS}
            format={(v) => `${v.toFixed(1)} s`}
          />
        </>
      }
      readouts={[
        { label: 'short-poll avg latency', value: avgOrDash(w.spLats) },
        { label: 'long-poll avg latency', value: avgOrDash(w.lpLats) },
        { label: 'websocket avg latency', value: avgOrDash(w.wsLats) },
        { label: 'HTTP req/min', value: reqPerMin },
        { label: 'overhead B/s (sp · lp · ws)', value: overhead },
      ]}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Delivery race: server events on a shared timeline, with short polling, long polling, and WebSocket lanes showing when each client learns of every event"
      >
        <rect x={1} y={1} width={W - 2} height={H - 2} rx={8} fill="none" className="s-border" />

        {/* Scrolling time grid */}
        {grid.map((t) => {
          const x = tToX(t, now);
          if (x < X0) return null;
          return (
            <g key={t}>
              <line x1={x} y1={36} x2={x} y2={AXIS_Y - 6} className="s-border" strokeDasharray="2 6" />
              <text
                x={Math.min(x, X1 - 14)}
                y={AXIS_Y + 16}
                textAnchor="middle"
                className="svg-label small muted"
              >
                {t / 1000}s
              </text>
            </g>
          );
        })}
        <line x1={X0} y1={AXIS_Y} x2={X1} y2={AXIS_Y} className="s-border" />
        <text x={X1} y={30} textAnchor="end" className="svg-label small muted">
          now →
        </text>

        {/* Lane labels + baselines */}
        <text x={8} y={EV_Y + 4} className="svg-label small muted">
          events
        </text>
        <text x={8} y={SP_Y + 4} className="svg-label small muted">
          short poll
        </text>
        <text x={8} y={LP_Y + 4} className="svg-label small muted">
          long poll
        </text>
        <text x={8} y={WS_Y + 4} className="svg-label small muted">
          websocket
        </text>
        <line x1={X0} y1={EV_Y} x2={X1} y2={EV_Y} className="s-border" strokeDasharray="2 4" />
        <line x1={X0} y1={SP_Y} x2={X1} y2={SP_Y} className="s-border" strokeDasharray="2 4" />
        <line x1={X0} y1={LP_Y} x2={X1} y2={LP_Y} className="s-border" strokeDasharray="2 4" />

        {/* Server events: ticks on the shared source lane + faint guides down the lanes */}
        {w.events.map((e) => {
          const x = tToX(e.t, now);
          if (x < X0) return null;
          return (
            <g key={e.t}>
              <line x1={x} y1={EV_Y - 8} x2={x} y2={EV_Y + 8} className="s-accent-2" strokeWidth={2} />
              <line
                x1={x}
                y1={EV_Y + 10}
                x2={x}
                y2={WS_Y + 10}
                className="s-accent-2"
                opacity={0.12}
              />
            </g>
          );
        })}

        {/* Short polling: waiting segments (event → delivering poll), poll ticks, deliveries */}
        {w.spDeliveries.map((d) => {
          const x2 = tToX(d.t, now);
          if (x2 < X0) return null;
          const x1 = Math.max(X0, tToX(d.eventT, now));
          return (
            <line
              key={d.eventT}
              x1={x1}
              y1={SP_Y}
              x2={x2}
              y2={SP_Y}
              className="s-danger"
              strokeWidth={2}
              opacity={0.55}
            />
          );
        })}
        {w.polls.map((p) => {
          const x = tToX(p.t, now);
          if (x < X0) return null;
          return (
            <line
              key={p.t}
              x1={x}
              y1={SP_Y - 8}
              x2={x}
              y2={SP_Y + 8}
              className={p.hit ? 's-accent' : 's-muted'}
              strokeWidth={p.hit ? 2 : 1.5}
              opacity={p.hit ? 1 : 0.55}
            />
          );
        })}
        {w.spDeliveries.map((d) => {
          const x = tToX(d.t, now);
          if (x < X0) return null;
          return <circle key={d.eventT} cx={x} cy={SP_Y} r={4} className="f-ok" />;
        })}
        {spLabels.map((l) => (
          <text key={l.x} x={l.x} y={SP_Y - 13} textAnchor="middle" className="svg-label small">
            {l.text}
          </text>
        ))}

        {/* Long polling: held-open request bars; timeout ends get a muted tick */}
        {w.lpSegments.map((s) => {
          const end = s.end ?? now;
          const x2 = tToX(end, now);
          if (x2 < X0) return null;
          const x1 = Math.max(X0, tToX(s.start, now));
          return (
            <g key={s.start}>
              <line
                x1={x1}
                y1={LP_Y}
                x2={x2}
                y2={LP_Y}
                className="s-muted"
                strokeWidth={1.5}
                strokeDasharray="4 4"
              />
              {s.end !== null && !s.byEvent && (
                <line x1={x2} y1={LP_Y - 6} x2={x2} y2={LP_Y + 6} className="s-muted" strokeWidth={1.5} />
              )}
            </g>
          );
        })}
        {w.lpDeliveries.map((d) => {
          const x = tToX(d.t, now);
          if (x < X0) return null;
          return <circle key={d.eventT} cx={x} cy={LP_Y} r={4} className="f-ok" />;
        })}
        {lpLabels.map((l) => (
          <text key={l.x} x={l.x} y={LP_Y - 13} textAnchor="middle" className="svg-label small">
            {l.text}
          </text>
        ))}

        {/* WebSocket: persistent connection with handshake marker; events arrive as frames */}
        {handshakeX < X1 && (
          <line
            x1={Math.max(X0, handshakeX)}
            y1={WS_Y}
            x2={X1}
            y2={WS_Y}
            className="s-accent"
            strokeWidth={2}
          />
        )}
        {handshakeX >= X0 && (
          <g>
            <rect x={handshakeX - 3} y={WS_Y - 7} width={6} height={14} rx={1} className="f-accent-2" />
            {handshakeX < X1 - 80 && (
              <text x={handshakeX + 7} y={WS_Y - 12} className="svg-label small muted">
                handshake
              </text>
            )}
          </g>
        )}
        {w.wsDeliveries.map((d) => {
          const x = tToX(d.t, now);
          if (x < X0) return null;
          return <circle key={d.eventT} cx={x} cy={WS_Y} r={3.5} className="f-ok" />;
        })}
        {wsLabels.map((l) => (
          <text key={l.x} x={l.x} y={WS_Y - 13} textAnchor="middle" className="svg-label small">
            {l.text}
          </text>
        ))}
      </svg>
    </SimFrame>
  );
}
