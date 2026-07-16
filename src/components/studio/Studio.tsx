import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as RPE } from 'react';
import { useRafLoop } from '../sims/hooks/useRafLoop';
import {
  initWorld,
  stepWorld,
  addNode,
  removeNode,
  addEdge,
  removeEdge,
  toggleAlive,
  nodeById,
  toGraph,
  throughput,
  percentile,
  utilOf,
  utilFill,
  validate,
  inPort,
  outPort,
  NODE_W,
  NODE_H,
} from './engine';
import type { Graph, NodeType, SimNode, Strategy, World } from './engine';
import type { ParamSpec } from './nodes';
import { INFO, PRESETS, DEFAULT_PRESET, makeGraphNode } from './nodes';
import { shareUrl, readGraphFromLocation } from './serialize';
import { Palette } from './Palette';
import { Inspector } from './Inspector';
import './studio.css';

const VW = 940;
const VH = 480;
const DRAG_THRESHOLD = 4;
const FADE_MS = 600;

type Drag =
  | { mode: 'idle' }
  | { mode: 'node'; id: string; offX: number; offY: number; startX: number; startY: number; moved: boolean }
  | { mode: 'edge'; from: string; x: number; y: number }
  | { mode: 'new'; type: NodeType; x: number; y: number; inside: boolean };

type Selected = { kind: 'node'; id: string } | { kind: 'edge'; from: string; to: string };

function initialState(): { graph: Graph; rate: number } {
  const fromUrl = readGraphFromLocation();
  if (fromUrl && fromUrl.nodes.length > 0) return { graph: fromUrl, rate: DEFAULT_PRESET.rate };
  return { graph: DEFAULT_PRESET.graph, rate: DEFAULT_PRESET.rate };
}

function nodeAt(w: World, x: number, y: number): SimNode | undefined {
  for (let i = w.nodes.length - 1; i >= 0; i--) {
    const n = w.nodes[i];
    if (x >= n.x && x <= n.x + NODE_W && y >= n.y && y <= n.y + NODE_H) return n;
  }
  return undefined;
}

function subInfo(n: SimNode): string {
  switch (n.type) {
    case 'source':
      return 'emits traffic';
    case 'lb':
      return n.params.strategy;
    case 'app':
      return `×${n.params.instances} · ${Math.round(n.params.capacity)}/s`;
    case 'cache':
      return `hit ${Math.round(n.params.hitRatio * 100)}%`;
    case 'db':
      return `${Math.round(n.params.capacity)}/s`;
    case 'queue':
      return `drain ${Math.round(n.params.capacity)}/s`;
    default:
      return '';
  }
}

export default function Studio() {
  const start = useRef(initialState());
  const world = useRef<World>(initWorld(start.current.graph));
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag>({ mode: 'idle' });
  const idc = useRef(1000);

  const [playing, setPlaying] = useState(
    () => typeof window === 'undefined' || !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [rate, setRate] = useState(start.current.rate);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [copied, setCopied] = useState(false);
  const [, setTick] = useState(0);

  const selRef = useRef<Selected | null>(selected);
  selRef.current = selected;

  const repaint = () => setTick((t) => t + 1);

  useRafLoop((dt) => {
    stepWorld(world.current, dt, { rate });
    setTick((t) => t + 1);
  }, playing);

  // Delete removes the selected node/edge (unless typing in a control).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const el = document.activeElement;
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
      const sel = selRef.current;
      if (!sel) return;
      if (sel.kind === 'node') removeNode(world.current, sel.id);
      else removeEdge(world.current, sel.from, sel.to);
      setSelected(null);
      repaint();
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // --- coordinate mapping (recomputed per event; survives scroll/resize) ---
  const toSvg = (clientX: number, clientY: number): { x: number; y: number } => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };

  const clampX = (x: number) => Math.max(0, Math.min(VW - NODE_W, x));
  const clampY = (y: number) => Math.max(0, Math.min(VH - NODE_H, y));

  // --- palette drag-to-add (tracked on window so it works across elements) ---
  const onChipPointerDown = (type: NodeType, e: RPE) => {
    e.preventDefault();
    const p = toSvg(e.clientX, e.clientY);
    drag.current = { mode: 'new', type, x: p.x, y: p.y, inside: false };
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (d.mode !== 'new') return;
      const q = toSvg(ev.clientX, ev.clientY);
      const rect = svgRef.current?.getBoundingClientRect();
      d.x = q.x;
      d.y = q.y;
      d.inside =
        !!rect &&
        ev.clientX >= rect.left &&
        ev.clientX <= rect.right &&
        ev.clientY >= rect.top &&
        ev.clientY <= rect.bottom;
      repaint();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const d = drag.current;
      if (d.mode === 'new' && d.inside) {
        const id = `s${idc.current++}`;
        addNode(world.current, makeGraphNode(d.type, clampX(d.x - NODE_W / 2), clampY(d.y - NODE_H / 2), id));
        setSelected({ kind: 'node', id });
      }
      drag.current = { mode: 'idle' };
      repaint();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    repaint();
  };

  // --- node / port / edge interactions on the canvas ---
  const onNodePointerDown = (id: string, e: RPE) => {
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    const n = nodeById(world.current, id);
    if (!n) return;
    const p = toSvg(e.clientX, e.clientY);
    drag.current = { mode: 'node', id, offX: p.x - n.x, offY: p.y - n.y, startX: p.x, startY: p.y, moved: false };
  };

  const onPortPointerDown = (id: string, e: RPE) => {
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    const n = nodeById(world.current, id);
    if (!n) return;
    const o = outPort(n);
    drag.current = { mode: 'edge', from: id, x: o.x, y: o.y };
  };

  const onCanvasPointerMove = (e: RPE) => {
    const d = drag.current;
    if (d.mode === 'node') {
      const n = nodeById(world.current, d.id);
      if (!n) return;
      const p = toSvg(e.clientX, e.clientY);
      n.x = clampX(p.x - d.offX);
      n.y = clampY(p.y - d.offY);
      if (!d.moved && Math.hypot(p.x - d.startX, p.y - d.startY) > DRAG_THRESHOLD) d.moved = true;
      if (!playing) repaint();
    } else if (d.mode === 'edge') {
      const p = toSvg(e.clientX, e.clientY);
      d.x = p.x;
      d.y = p.y;
      if (!playing) repaint();
    }
  };

  const onCanvasPointerUp = (e: RPE) => {
    const d = drag.current;
    try {
      svgRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer was not captured */
    }
    if (d.mode === 'node') {
      if (!d.moved) setSelected({ kind: 'node', id: d.id });
    } else if (d.mode === 'edge') {
      const p = toSvg(e.clientX, e.clientY);
      const target = nodeAt(world.current, p.x, p.y);
      if (target && target.id !== d.from) addEdge(world.current, d.from, target.id);
    }
    drag.current = { mode: 'idle' };
    repaint();
  };

  const onEdgePointerDown = (from: string, to: string, e: RPE) => {
    e.stopPropagation();
    setSelected({ kind: 'edge', from, to });
  };

  const onKill = (id: string, e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    toggleAlive(world.current, id);
    repaint();
  };

  const onParam = (key: ParamSpec['key'], value: number) => {
    const n = selRef.current?.kind === 'node' ? nodeById(world.current, selRef.current.id) : undefined;
    if (n) {
      n.params[key] = value;
      repaint();
    }
  };

  const onStrategy = (value: Strategy) => {
    const n = selRef.current?.kind === 'node' ? nodeById(world.current, selRef.current.id) : undefined;
    if (n) {
      n.params.strategy = value;
      repaint();
    }
  };

  // --- toolbar actions ---
  const loadPreset = (i: number) => {
    const preset = PRESETS[i];
    if (!preset) return;
    world.current = initWorld(preset.graph);
    idc.current = 1000;
    setRate(preset.rate);
    setSelected(null);
    repaint();
  };

  const onReset = () => {
    world.current = initWorld(toGraph(world.current));
    repaint();
  };

  const onShare = () => {
    const url = shareUrl(toGraph(world.current));
    window.history.replaceState(null, '', url);
    navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard unavailable — URL is still in the address bar */
      });
  };

  // --- derived (recomputed each render) ---
  const w = world.current;
  const d = drag.current;
  const tput = throughput(w);
  const p50 = percentile(w, 0.5);
  const p99 = percentile(w, 0.99);
  const warnings = validate(w);
  const selNode = selected?.kind === 'node' ? nodeById(w, selected.id) ?? null : null;
  const selEdge = selected?.kind === 'edge' ? selected : null;

  return (
    <div className="studio">
      <div className="studio-toolbar">
        <h2>Design Studio</h2>
        <button className="studio-btn" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button className="studio-btn" onClick={onReset} aria-label="Reset simulation">
          ↺
        </button>
        <label className="studio-rate">
          traffic <output>{rate}/s</output>
          <input
            type="range"
            min={0}
            max={400}
            step={10}
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
            aria-label="Traffic rate"
          />
        </label>
        <select
          className="studio-select"
          value={-1}
          onChange={(e) => {
            loadPreset(Number(e.target.value));
          }}
          aria-label="Load a preset design"
        >
          <option value={-1}>Load preset…</option>
          {PRESETS.map((p, i) => (
            <option key={p.name} value={i}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="studio-btn" onClick={onShare}>
          {copied ? 'Copied!' : 'Share'}
        </button>
      </div>

      <div className="studio-main">
        <Palette onChipPointerDown={onChipPointerDown} />

        <div className="studio-canvas-wrap">
          <svg
            ref={svgRef}
            className="studio-canvas"
            viewBox={`0 0 ${VW} ${VH}`}
            preserveAspectRatio="xMidYMid meet"
            role="application"
            aria-label="System design canvas"
            onPointerMove={onCanvasPointerMove}
            onPointerUp={onCanvasPointerUp}
          >
            <defs>
              <marker id="studio-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0,0 L10,5 L0,10 z" className="f-muted" />
              </marker>
            </defs>

            <rect x={0} y={0} width={VW} height={VH} fill="transparent" onPointerDown={() => setSelected(null)} />

            {/* edges */}
            {w.edges.map((e) => {
              const a = nodeById(w, e.from);
              const b = nodeById(w, e.to);
              if (!a || !b) return null;
              const o = outPort(a);
              const i = inPort(b);
              const dead = !a.alive || !b.alive;
              const sel = !!selEdge && selEdge.from === e.from && selEdge.to === e.to;
              return (
                <g key={`${e.from}>${e.to}`}>
                  <line
                    x1={o.x}
                    y1={o.y}
                    x2={i.x}
                    y2={i.y}
                    style={{ stroke: 'transparent', strokeWidth: 18, cursor: 'pointer' }}
                    onPointerDown={(ev) => onEdgePointerDown(e.from, e.to, ev)}
                  />
                  <line
                    x1={o.x}
                    y1={o.y}
                    x2={i.x}
                    y2={i.y}
                    markerEnd="url(#studio-arrow)"
                    style={{
                      stroke: sel ? 'var(--accent)' : dead ? 'var(--danger)' : 'var(--text-muted)',
                      strokeWidth: sel ? 2.5 : 1.5,
                      opacity: dead ? 0.5 : 0.85,
                    }}
                  />
                </g>
              );
            })}

            {/* in-flight tokens */}
            {w.flights.map((t) => {
              const p = Math.min(t.elapsedMs / t.durationMs, 1);
              return (
                <circle
                  key={t.id}
                  cx={t.fromX + (t.toX - t.fromX) * p}
                  cy={t.fromY + (t.toY - t.fromY) * p}
                  r={3.5}
                  className="f-accent-2"
                />
              );
            })}

            {/* completion / drop fades */}
            {w.fades.map((f) => (
              <circle
                key={f.id}
                cx={f.x}
                cy={f.y}
                r={4}
                style={{
                  fill: f.kind === 'done' ? 'var(--ok)' : 'var(--danger)',
                  opacity: Math.max(1 - f.age / FADE_MS, 0),
                }}
              />
            ))}

            {/* nodes */}
            {w.nodes.map((n) => {
              const info = INFO[n.type];
              const util = utilOf(w, n);
              const sel = selected?.kind === 'node' && selected.id === n.id;
              const overloaded = util >= 0.999 && n.type !== 'source' && n.type !== 'lb';
              const qFrac = Math.min(n.queue.length / Math.max(1, n.params.queueCap), 1);
              const o = outPort(n);
              const inp = inPort(n);
              const barW = NODE_W - 52;
              const barTrack = NODE_H - 20;
              return (
                <g key={n.id} opacity={n.alive ? 1 : 0.5}>
                  <rect
                    x={n.x}
                    y={n.y}
                    width={NODE_W}
                    height={NODE_H}
                    rx={8}
                    className="f-inset"
                    style={{
                      stroke: sel ? 'var(--accent)' : overloaded ? 'var(--danger)' : 'var(--border)',
                      strokeWidth: sel ? 2 : 1.2,
                      cursor: 'grab',
                    }}
                    onPointerDown={(ev) => onNodePointerDown(n.id, ev)}
                  />
                  <text x={n.x + 12} y={n.y + 22} className="svg-label small" style={{ pointerEvents: 'none' }}>
                    {info.short}
                  </text>
                  <text
                    x={n.x + 12}
                    y={n.y + 39}
                    className="svg-label small muted"
                    style={{ pointerEvents: 'none' }}
                  >
                    {subInfo(n)}
                  </text>

                  {n.type !== 'source' && (
                    <>
                      <rect
                        x={n.x + 12}
                        y={n.y + NODE_H - 13}
                        width={barW}
                        height={5}
                        rx={2.5}
                        className="f-border"
                        style={{ pointerEvents: 'none' }}
                      />
                      {util > 0 && (
                        <rect
                          x={n.x + 12}
                          y={n.y + NODE_H - 13}
                          width={barW * util}
                          height={5}
                          rx={2.5}
                          style={{ fill: utilFill(util), pointerEvents: 'none' }}
                        />
                      )}
                      <rect
                        x={n.x + NODE_W - 26}
                        y={n.y + 10}
                        width={7}
                        height={barTrack}
                        rx={2}
                        className="f-border"
                        style={{ pointerEvents: 'none' }}
                      />
                      {qFrac > 0 && (
                        <rect
                          x={n.x + NODE_W - 26}
                          y={n.y + 10 + barTrack * (1 - qFrac)}
                          width={7}
                          height={barTrack * qFrac}
                          rx={2}
                          style={{ fill: qFrac >= 0.9 ? 'var(--danger)' : 'var(--accent)', pointerEvents: 'none' }}
                        />
                      )}
                      <circle cx={inp.x} cy={inp.y} r={5} className="f-bg s-border" style={{ pointerEvents: 'none' }} />
                    </>
                  )}

                  {n.type !== 'db' && (
                    <circle
                      cx={o.x}
                      cy={o.y}
                      r={6}
                      className="f-bg s-accent"
                      style={{ cursor: 'crosshair' }}
                      onPointerDown={(ev) => onPortPointerDown(n.id, ev)}
                    />
                  )}

                  <g
                    tabIndex={0}
                    role="button"
                    aria-label={`${n.alive ? 'Kill' : 'Revive'} ${info.label}`}
                    style={{ cursor: 'pointer' }}
                    onPointerDown={(ev) => onKill(n.id, ev)}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault();
                        onKill(n.id, ev);
                      }
                    }}
                  >
                    <circle cx={n.x + NODE_W - 12} cy={n.y + 12} r={7} className="f-bg s-border" />
                    <circle
                      cx={n.x + NODE_W - 12}
                      cy={n.y + 12}
                      r={2.5}
                      style={{ fill: n.alive ? 'var(--ok)' : 'var(--danger)' }}
                    />
                  </g>

                  {!n.alive && (
                    <g style={{ stroke: 'var(--danger)', strokeWidth: 2, pointerEvents: 'none' }}>
                      <line x1={n.x + 8} y1={n.y + 8} x2={n.x + NODE_W - 8} y2={n.y + NODE_H - 8} />
                      <line x1={n.x + NODE_W - 8} y1={n.y + 8} x2={n.x + 8} y2={n.y + NODE_H - 8} />
                    </g>
                  )}
                </g>
              );
            })}

            {/* drag previews */}
            {d.mode === 'new' && d.inside && (
              <rect
                x={clampX(d.x - NODE_W / 2)}
                y={clampY(d.y - NODE_H / 2)}
                width={NODE_W}
                height={NODE_H}
                rx={8}
                className="f-inset s-accent"
                style={{ opacity: 0.6, pointerEvents: 'none' }}
              />
            )}
            {d.mode === 'edge' &&
              (() => {
                const from = nodeById(w, d.from);
                if (!from) return null;
                const o = outPort(from);
                return (
                  <line
                    x1={o.x}
                    y1={o.y}
                    x2={d.x}
                    y2={d.y}
                    style={{ stroke: 'var(--accent)', strokeWidth: 2, strokeDasharray: '4 4', pointerEvents: 'none' }}
                  />
                );
              })()}
          </svg>
          <span className="studio-hint">
            Drag a component in · drag a node's right port to connect · click the corner dot to kill
          </span>
        </div>

        <div className="studio-rail">
          {selNode ? (
            <>
              <Inspector node={selNode} onParam={onParam} onStrategy={onStrategy} />
              <button
                className="studio-delete"
                onClick={() => {
                  removeNode(world.current, selNode.id);
                  setSelected(null);
                  repaint();
                }}
              >
                Delete node
              </button>
            </>
          ) : selEdge ? (
            <>
              <div className="rail-head">
                <h3>Connection</h3>
              </div>
              <p className="rail-note">
                This edge routes requests to the next component. Press Delete or the button below to remove it.
              </p>
              <button
                className="studio-delete"
                onClick={() => {
                  removeEdge(world.current, selEdge.from, selEdge.to);
                  setSelected(null);
                  repaint();
                }}
              >
                Delete connection
              </button>
            </>
          ) : (
            <>
              <div className="rail-head">
                <h3>Build a system</h3>
              </div>
              <p className="rail-note">
                Drag components from the left onto the canvas, then drag from a node's right-edge port to another node
                to connect them. Turn up the traffic and watch where it backs up.
              </p>
              <div className="rail-legend">
                <span>
                  <i className="rail-swatch" style={{ background: 'var(--ok)' }} /> low utilization
                </span>
                <span>
                  <i className="rail-swatch" style={{ background: 'var(--danger)' }} /> saturated / dropping
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="studio-footer">
        <div className="studio-readouts">
          <div className="studio-readout">
            <span className="studio-readout-value">{tput.toFixed(0)}/s</span>
            <span className="studio-readout-label">throughput</span>
          </div>
          <div className="studio-readout">
            <span className="studio-readout-value">{Math.round(p50)} ms</span>
            <span className="studio-readout-label">p50 latency</span>
          </div>
          <div className="studio-readout">
            <span className="studio-readout-value">{Math.round(p99)} ms</span>
            <span className="studio-readout-label">p99 latency</span>
          </div>
          <div className="studio-readout">
            <span className="studio-readout-value">{w.dropped}</span>
            <span className="studio-readout-label">dropped</span>
          </div>
        </div>
        {warnings.length > 0 && (
          <div className="studio-warnings">
            {warnings.map((wn, i) => (
              <div key={i} className="studio-warning">
                ⚠ {wn}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
