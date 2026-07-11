import { useRef, useState } from 'react';
import { SimFrame } from './SimFrame';
import { Slider, Toggle, Button } from './controls';
import { useRafLoop } from './hooks/useRafLoop';

const W = 640;
const H = 340;

// Producers (left).
const PROD_X = 36;
const PRODUCER_YS = [104, 170, 236];

// Queue channel (center). Head is at the right end, nearest the consumers.
const QX0 = 122;
const QX1 = 440;
const QY = 153;
const QH = 34;
const QMID = QY + QH / 2;

// Consumers (right).
const CONS_X = 496;
const CONS_W = 128;
const CONS_H = 30;
const CONS_AREA_Y = 26;
const CONS_AREA_H = 290;

// Message squares.
const SQ = 8;
const PER_ROW = 30;
const COL_SP = 10;
const MAX_RENDERED = 60; // at most ~60 squares drawn; beyond that "+N more"

// Tunables / caps — every accumulating array is bounded.
const QUEUE_CAP = 50; // bounded-mode capacity
const MAX_STORE = 200; // materialized queue entries; excess tracked as a count
const MAX_FLY = 120;
const MAX_FADES = 40;
const MAX_DONE_LOG = 400;
const FLIGHT_MS = 350;
const VIS_TIMEOUT_MS = 800; // crashed consumer's message returns after this
const SPIKE_MS = 3000;
const SPIKE_MULT = 5;
const THROUGHPUT_WIN_MS = 2000;
const FADE_MS = 450;
const DEFAULT_CONSUMERS = 3;

interface Message {
  id: number;
  enqueuedAt: number; // sim time at admission
  redelivered: boolean;
}

interface Flight {
  id: number;
  msg: Message;
  sy: number; // producer y it launched from
  t: number; // 0..1 flight progress
}

interface Fade {
  id: number;
  kind: 'done' | 'drop';
  x: number;
  y: number;
  age: number;
}

interface Consumer {
  id: number;
  alive: boolean;
  current: Message | null;
  progress: number; // 0..1 of current message
  visTimer: number; // ms until a crashed consumer's message is requeued
}

interface World {
  simTime: number;
  spawnAcc: number; // fractional pending message spawns
  nextId: number;
  nextFadeId: number;
  nextConsumerId: number;
  producerTurn: number; // round-robin producer picker
  queue: Message[]; // head at index 0; capped at MAX_STORE
  extraTail: number; // admitted-but-not-materialized tail messages
  extraT0: number; // enqueue time of the oldest unmaterialized tail message
  extraT1: number; // enqueue time of the newest unmaterialized tail message
  flying: Flight[];
  fades: Fade[];
  doneLog: number[]; // completion timestamps within the rolling window
  consumers: Consumer[];
  dropped: number;
  redeliveries: number;
  spikeUntil: number;
  flashUntil: number;
}

interface Params {
  rate: number; // producer msg/s
  processingMs: number; // per-message processing time
  bounded: boolean;
}

function makeConsumer(id: number): Consumer {
  return { id, alive: true, current: null, progress: 0, visTimer: 0 };
}

function initWorld(consumerCount: number): World {
  return {
    simTime: 0,
    spawnAcc: 0,
    nextId: 0,
    nextFadeId: 0,
    nextConsumerId: consumerCount,
    producerTurn: 0,
    queue: [],
    extraTail: 0,
    extraT0: 0,
    extraT1: 0,
    flying: [],
    fades: [],
    doneLog: [],
    consumers: Array.from({ length: consumerCount }, (_, i) => makeConsumer(i)),
    dropped: 0,
    redeliveries: 0,
    spikeUntil: -1,
    flashUntil: -1,
  };
}

/** Top-left of queue slot i (0 = head, rightmost). Two rows of PER_ROW. */
function slotPos(i: number): { x: number; y: number } {
  const col = i % PER_ROW;
  const row = Math.min(1, Math.floor(i / PER_ROW));
  return { x: QX1 - 18 - col * COL_SP, y: row === 0 ? 172 : 158 };
}

/** Top y of consumer box i when n consumers share the right rail. */
function consumerTop(n: number, i: number): number {
  const slot = CONS_AREA_H / Math.max(1, n);
  return CONS_AREA_Y + i * slot + (slot - CONS_H) / 2;
}

function pushFade(w: World, kind: Fade['kind'], x: number, y: number) {
  w.fades.push({ id: w.nextFadeId++, kind, x, y, age: 0 });
  if (w.fades.length > MAX_FADES) w.fades.shift();
}

/** Enqueue at the tail, or reject with a flash when bounded and full. */
function admit(w: World, msg: Message, p: Params) {
  const depth = w.queue.length + w.extraTail;
  if (p.bounded && depth >= QUEUE_CAP) {
    w.dropped++;
    w.flashUntil = w.simTime + 300;
    const pos = slotPos(Math.min(depth, MAX_RENDERED - 1));
    pushFade(w, 'drop', pos.x, pos.y);
    return;
  }
  msg.enqueuedAt = w.simTime;
  if (w.queue.length < MAX_STORE) {
    w.queue.push(msg);
  } else {
    if (w.extraTail === 0) w.extraT0 = msg.enqueuedAt;
    w.extraT1 = msg.enqueuedAt;
    w.extraTail++;
  }
}

function dequeueHead(w: World): Message | null {
  const msg = w.queue.shift() ?? null;
  // Materialize one overflow-tracked tail message to keep the store full.
  // Its enqueue time is interpolated across the unmaterialized span so the
  // oldest-age readout keeps climbing honestly during deep overload.
  if (msg && w.extraTail > 0) {
    w.queue.push({ id: w.nextId++, enqueuedAt: w.extraT0, redelivered: false });
    if (w.extraTail > 1) w.extraT0 += (w.extraT1 - w.extraT0) / (w.extraTail - 1);
    w.extraTail--;
  }
  return msg;
}

/** Return a message to the head (redelivery); never rejected. */
function requeueHead(w: World, msg: Message) {
  w.queue.unshift(msg);
  if (w.queue.length > MAX_STORE) {
    const popped = w.queue.pop();
    if (popped) {
      // The popped tail is older than everything in the unmaterialized span.
      if (w.extraTail === 0) w.extraT1 = popped.enqueuedAt;
      w.extraT0 = popped.enqueuedAt;
      w.extraTail++;
    }
  }
}

function stepWorld(w: World, dtMs: number, p: Params) {
  w.simTime += dtMs;
  const dtS = dtMs / 1000;
  const spiking = w.simTime < w.spikeUntil;
  const rate = p.rate * (spiking ? SPIKE_MULT : 1);

  // Producers emit messages (round-robin), flying toward the queue tail.
  w.spawnAcc += rate * dtS;
  while (w.spawnAcc >= 1) {
    w.spawnAcc -= 1;
    const msg: Message = { id: w.nextId++, enqueuedAt: w.simTime, redelivered: false };
    const sy = PRODUCER_YS[w.producerTurn % PRODUCER_YS.length];
    w.producerTurn++;
    if (w.flying.length < MAX_FLY) {
      w.flying.push({ id: msg.id, msg, sy, t: 0 });
    } else {
      admit(w, msg, p); // too many in flight: enqueue directly
    }
  }

  // Flights arrive at the tail and get admitted (or rejected).
  for (let i = w.flying.length - 1; i >= 0; i--) {
    const f = w.flying[i];
    f.t += dtMs / FLIGHT_MS;
    if (f.t >= 1) {
      w.flying.splice(i, 1);
      admit(w, f.msg, p);
    }
  }

  // Consumers pull from the head and process; crashed ones hold their
  // in-flight message until the visibility timeout, then it is redelivered.
  for (let i = 0; i < w.consumers.length; i++) {
    const c = w.consumers[i];
    if (!c.alive) {
      if (c.current) {
        c.visTimer -= dtMs;
        if (c.visTimer <= 0) {
          c.current.redelivered = true;
          w.redeliveries++;
          requeueHead(w, c.current);
          c.current = null;
          c.progress = 0;
        }
      }
      continue;
    }
    if (!c.current) {
      c.current = dequeueHead(w);
      c.progress = 0;
    }
    if (!c.current) continue;
    c.progress += dtMs / Math.max(1, p.processingMs);
    while (c.current && c.progress >= 1) {
      const top = consumerTop(w.consumers.length, i);
      pushFade(w, 'done', CONS_X + 34, top + CONS_H / 2 - SQ / 2);
      w.doneLog.push(w.simTime);
      if (w.doneLog.length > MAX_DONE_LOG) w.doneLog.shift();
      c.progress -= 1;
      c.current = dequeueHead(w);
    }
    if (!c.current) c.progress = 0;
  }

  // Prune the rolling throughput window.
  while (w.doneLog.length > 0 && w.doneLog[0] < w.simTime - THROUGHPUT_WIN_MS) {
    w.doneLog.shift();
  }

  // Age out fade effects.
  for (let i = w.fades.length - 1; i >= 0; i--) {
    w.fades[i].age += dtMs;
    if (w.fades[i].age >= FADE_MS) w.fades.splice(i, 1);
  }
}

/**
 * Queue backpressure lab: producers emit messages into a queue drained by a
 * pool of consumers. Push the producer rate past consumers x (1000 / processing
 * ms) and watch depth and age climb — or drops mount when the queue is bounded.
 * Click a consumer to crash it and see its message redelivered.
 */
export default function MessageQueuesSim() {
  const world = useRef<World>(initWorld(DEFAULT_CONSUMERS));
  const [playing, setPlaying] = useState(true);
  const [rate, setRate] = useState(8);
  const [consumerCount, setConsumerCount] = useState(DEFAULT_CONSUMERS);
  const [processingMs, setProcessingMs] = useState(300);
  const [bounded, setBounded] = useState(false);
  const [, setTick] = useState(0);

  useRafLoop((dt) => {
    stepWorld(world.current, dt, { rate, processingMs, bounded });
    setTick((t) => t + 1);
  }, playing);

  const w = world.current;
  const depth = w.queue.length + w.extraTail;
  const spiking = w.simTime < w.spikeUntil;
  const flashing = w.simTime < w.flashUntil;
  const oldestS = w.queue.length > 0 ? (w.simTime - w.queue[0].enqueuedAt) / 1000 : 0;
  // Denominator ramps up during the first window so early readings aren't inflated.
  const winS = Math.min(THROUGHPUT_WIN_MS / 1000, Math.max(0.5, w.simTime / 1000));
  const throughput = w.doneLog.length / winS;

  const changeConsumers = (n: number) => {
    setConsumerCount(n);
    const cur = world.current;
    while (cur.consumers.length < n) {
      cur.consumers.push(makeConsumer(cur.nextConsumerId++));
    }
    while (cur.consumers.length > n) {
      const c = cur.consumers.pop();
      if (c && c.current) {
        // A scaled-down consumer's in-flight message goes back for redelivery.
        c.current.redelivered = true;
        cur.redeliveries++;
        requeueHead(cur, c.current);
      }
    }
    setTick((t) => t + 1);
  };

  const toggleConsumer = (i: number) => {
    const c = world.current.consumers[i];
    if (!c) return;
    c.alive = !c.alive;
    if (!c.alive && c.current) c.visTimer = VIS_TIMEOUT_MS;
    setTick((t) => t + 1);
  };

  const triggerSpike = () => {
    const cur = world.current;
    cur.spikeUntil = cur.simTime + SPIKE_MS;
    setTick((t) => t + 1);
  };

  // Flights home toward the current tail slot.
  const tailPos = slotPos(Math.min(depth, MAX_RENDERED - 1));
  const nConsumers = w.consumers.length;

  return (
    <SimFrame
      title="Queue backpressure lab"
      playing={playing}
      onPlayPause={() => setPlaying((p) => !p)}
      onReset={() => {
        world.current = initWorld(consumerCount);
        setTick((t) => t + 1);
      }}
      controls={
        <>
          <Slider
            label="Producer rate"
            value={rate}
            min={1}
            max={50}
            onChange={setRate}
            format={(v) => `${v}/s`}
          />
          <Slider
            label="Consumers"
            value={consumerCount}
            min={1}
            max={8}
            onChange={changeConsumers}
          />
          <Slider
            label="Processing time"
            value={processingMs}
            min={50}
            max={1000}
            step={50}
            onChange={setProcessingMs}
            format={(v) => `${v} ms`}
          />
          <Button onClick={triggerSpike}>Traffic spike</Button>
          <Toggle label="Bounded queue (cap 50)" checked={bounded} onChange={setBounded} />
        </>
      }
      readouts={[
        { label: 'queue depth', value: depth },
        { label: 'oldest age', value: `${oldestS.toFixed(1)}s` },
        { label: 'throughput', value: `${throughput.toFixed(1)}/s` },
        { label: 'dropped', value: w.dropped },
        { label: 'redeliveries', value: w.redeliveries },
      ]}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Message queue simulation: producer dots on the left send message squares into a horizontal queue that consumer boxes on the right drain"
      >
        <rect x={1} y={1} width={W - 2} height={H - 2} rx={8} fill="none" className="s-border" />

        {/* Producers */}
        <text x={PROD_X} y={66} textAnchor="middle" className="svg-label small muted">
          producers
        </text>
        {PRODUCER_YS.map((py, i) => (
          <g key={i}>
            <circle cx={PROD_X} cy={py} r={10} className="f-accent-2" opacity={0.9} />
            {spiking && (
              <circle
                cx={PROD_X}
                cy={py}
                r={14 + 3 * Math.sin(w.simTime / 90 + i * 2)}
                fill="none"
                style={{ stroke: 'var(--accent-2)' }}
                opacity={0.6}
              />
            )}
          </g>
        ))}
        {spiking && (
          <text
            x={PROD_X}
            y={286}
            textAnchor="middle"
            className="svg-label small"
            style={{ fill: 'var(--accent-2)' }}
          >
            5× spike
          </text>
        )}

        {/* Queue channel */}
        <text x={QX0} y={146} className="svg-label small muted">
          tail
        </text>
        <text x={(QX0 + QX1) / 2} y={146} textAnchor="middle" className="svg-label small muted">
          queue
        </text>
        <text x={QX1} y={146} textAnchor="end" className="svg-label small muted">
          head →
        </text>
        <rect
          x={QX0}
          y={QY}
          width={QX1 - QX0}
          height={QH}
          rx={6}
          className="f-inset"
          style={{
            stroke: flashing ? 'var(--danger)' : 'var(--border)',
            strokeWidth: flashing ? 2 : 1,
          }}
        />
        <line
          x1={QX1 + 4}
          y1={QMID}
          x2={CONS_X - 6}
          y2={QMID}
          className="s-border"
          strokeDasharray="4 4"
        />

        {/* Bounded-mode capacity bar */}
        {bounded && (
          <>
            <rect x={QX0} y={QY + QH + 4} width={QX1 - QX0} height={3} className="f-border" opacity={0.6} />
            {depth > 0 && (
              <rect
                x={QX0}
                y={QY + QH + 4}
                width={(QX1 - QX0) * Math.min(1, depth / QUEUE_CAP)}
                height={3}
                style={{ fill: depth >= QUEUE_CAP ? 'var(--danger)' : 'var(--accent)' }}
              />
            )}
            <text
              x={QX1}
              y={203}
              textAnchor="end"
              className="svg-label small"
              style={{ fill: depth >= QUEUE_CAP ? 'var(--danger)' : 'var(--text-muted)' }}
            >
              cap {QUEUE_CAP}
            </text>
          </>
        )}
        {depth > MAX_RENDERED && (
          <text x={QX0} y={203} className="svg-label small muted">
            +{depth - MAX_RENDERED} more
          </text>
        )}

        {/* Queued messages: oldest (head) at the right, up to MAX_RENDERED */}
        {w.queue.slice(0, MAX_RENDERED).map((m, i) => {
          const pos = slotPos(i);
          return (
            <g key={m.id}>
              <rect x={pos.x} y={pos.y} width={SQ} height={SQ} rx={1.5} className="f-accent" />
              {m.redelivered && (
                <circle cx={pos.x + SQ} cy={pos.y} r={2.5} className="f-accent-2" />
              )}
            </g>
          );
        })}

        {/* Messages in flight from producers to the tail */}
        {w.flying.map((f) => {
          const t = Math.min(1, f.t);
          const e = t * t * (3 - 2 * t); // smoothstep
          const x = 44 + (tailPos.x - 44) * e;
          const y0 = f.sy - SQ / 2;
          const y = y0 + (tailPos.y - y0) * e;
          return (
            <rect key={f.id} x={x} y={y} width={SQ} height={SQ} rx={1.5} className="f-accent" opacity={0.9} />
          );
        })}

        {/* Fading effects: completions drift up green, rejections fall red */}
        {w.fades.map((f) => {
          const k = Math.max(0, 1 - f.age / FADE_MS);
          const y = f.kind === 'drop' ? f.y + f.age * 0.09 : f.y - f.age * 0.05;
          return (
            <rect
              key={f.id}
              x={f.x}
              y={y}
              width={SQ}
              height={SQ}
              rx={1.5}
              opacity={k}
              style={{ fill: f.kind === 'drop' ? 'var(--danger)' : 'var(--ok)' }}
            />
          );
        })}

        {/* Consumers */}
        <text x={CONS_X + CONS_W} y={16} textAnchor="end" className="svg-label small muted">
          consumers · click to crash
        </text>
        {w.consumers.map((c, i) => {
          const top = consumerTop(nConsumers, i);
          const mid = top + CONS_H / 2;
          return (
            <g
              key={c.id}
              onClick={() => toggleConsumer(i)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggleConsumer(i);
                }
              }}
              tabIndex={0}
              role="button"
              aria-label={`Consumer ${i + 1}: ${c.alive ? 'alive' : 'crashed'}. Press to toggle.`}
              style={{ cursor: 'pointer' }}
              opacity={c.alive ? 1 : 0.55}
            >
              <rect
                x={CONS_X}
                y={top}
                width={CONS_W}
                height={CONS_H}
                rx={6}
                className="f-inset"
                style={{ stroke: c.alive ? 'var(--border)' : 'var(--text-muted)' }}
              />
              <text x={CONS_X + 8} y={mid + 4} className="svg-label small">
                C{i + 1}
              </text>
              {c.current && (
                <g>
                  <rect
                    x={CONS_X + 34}
                    y={mid - SQ / 2}
                    width={SQ}
                    height={SQ}
                    rx={1.5}
                    style={{ fill: c.alive ? 'var(--accent)' : 'var(--accent-2)' }}
                  />
                  {c.current.redelivered && (
                    <circle cx={CONS_X + 34 + SQ} cy={mid - SQ / 2} r={2.5} className="f-accent-2" />
                  )}
                </g>
              )}
              {c.alive ? (
                <>
                  <rect
                    x={CONS_X + 50}
                    y={mid - 3}
                    width={66}
                    height={6}
                    rx={3}
                    className="f-border"
                    opacity={0.6}
                  />
                  {c.current && c.progress > 0.02 && (
                    <rect
                      x={CONS_X + 50}
                      y={mid - 3}
                      width={66 * Math.min(1, c.progress)}
                      height={6}
                      rx={3}
                      className="f-accent"
                    />
                  )}
                </>
              ) : (
                <>
                  <line
                    x1={CONS_X + 52}
                    y1={top + 6}
                    x2={CONS_X + CONS_W - 10}
                    y2={top + CONS_H - 6}
                    style={{ stroke: 'var(--text-muted)' }}
                    strokeWidth={2}
                  />
                  <line
                    x1={CONS_X + CONS_W - 10}
                    y1={top + 6}
                    x2={CONS_X + 52}
                    y2={top + CONS_H - 6}
                    style={{ stroke: 'var(--text-muted)' }}
                    strokeWidth={2}
                  />
                </>
              )}
            </g>
          );
        })}
      </svg>
    </SimFrame>
  );
}
