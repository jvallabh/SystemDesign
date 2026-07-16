/**
 * AtlasMap — the explorable concept map island.
 *
 * Renders the precomputed graph as static SSR'd SVG: edges first, then nodes as
 * real <a> links (indexable, keyboard-focusable, work with JS off). Layout is a
 * pure function of build-time data (see layout.ts), so the server SVG is
 * byte-identical to the client's first render — hence client:load WITH SSR
 * (ADR-14), not client:only.
 *
 * Interactivity is added on hydration only: hover/focus neighbourhood highlight
 * and hand-rolled pan/zoom. No animation loop (v1); the single opacity
 * transition is gated behind prefers-reduced-motion in atlas.css.
 */
import { useMemo, useState } from 'react';
import type { AtlasGraph } from './graph';
import type { Positions } from './layout';
import { CATEGORY_VAR } from './colors';
import { usePanZoom } from './usePanZoom';
import { CATEGORIES } from '../../data/categories';
import { withBase } from '../../utils/url';
import './atlas.css';

const BASE = { w: 1000, h: 640 };

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function nodeRadius(degree: number): number {
  return clamp(6 + degree * 1.1, 7, 16);
}

interface Props {
  graph: AtlasGraph;
  positions: Positions;
}

export default function AtlasMap({ graph, positions }: Props) {
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const { viewBox, svgRef, svgHandlers, zoomIn, zoomOut, reset } = usePanZoom(BASE);

  // Undirected adjacency, built once.
  const adjacency = useMemo(() => {
    const m: Record<string, Set<string>> = {};
    for (const n of graph.nodes) m[n.id] = new Set<string>();
    for (const e of graph.edges) {
      m[e.source].add(e.target);
      m[e.target].add(e.source);
    }
    return m;
  }, [graph]);

  const isNodeActive = (id: string): boolean => {
    if (highlightId === null) return true;
    return id === highlightId || adjacency[highlightId].has(id);
  };

  return (
    <div className="atlas">
      <div className="atlas-stage">
        <svg
          ref={svgRef}
          className="atlas-svg"
          viewBox={viewBox}
          role="group"
          aria-label={`Atlas concept map: ${graph.nodes.length} topics connected by relatedness`}
          {...svgHandlers}
        >
          {/* Edges first, under the nodes — decorative (relationships are conveyed by node aria-labels). */}
          <g aria-hidden="true">
            {graph.edges.map((edge) => {
              const a = positions[edge.source];
              const b = positions[edge.target];
              const incident =
                highlightId !== null && (edge.source === highlightId || edge.target === highlightId);
              const dim = highlightId !== null && !incident;
              return (
                <line
                  key={`${edge.source}|${edge.target}`}
                  className={incident ? 'atlas-edge is-incident' : 'atlas-edge s-border'}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  strokeWidth={incident ? 1.6 : 1}
                  style={incident ? { stroke: 'var(--accent)' } : undefined}
                  opacity={dim ? 0.18 : 1}
                />
              );
            })}
          </g>

          {/* Nodes on top. */}
          <g>
            {graph.nodes.map((node) => {
              const p = positions[node.id];
              const r = nodeRadius(node.degree);
              const active = isNodeActive(node.id);
              return (
                <a
                  key={node.id}
                  className="atlas-node"
                  href={withBase(`/topics/${node.id}/`)}
                  aria-label={node.tier === 'flagship' ? `${node.title} — has interactive sim` : node.title}
                  style={{ opacity: active ? 1 : 0.18 }}
                  onPointerEnter={() => setHighlightId(node.id)}
                  onPointerLeave={() => setHighlightId(null)}
                  onFocus={() => setHighlightId(node.id)}
                  onBlur={() => setHighlightId(null)}
                >
                  <title>{node.title}</title>
                  {node.tier === 'flagship' && (
                    <circle
                      className="s-accent atlas-ring"
                      cx={p.x}
                      cy={p.y}
                      r={r + 4}
                      fill="none"
                      strokeWidth={1.5}
                      aria-hidden="true"
                    />
                  )}
                  <circle
                    className="atlas-dot s-border"
                    cx={p.x}
                    cy={p.y}
                    r={r}
                    strokeWidth={1}
                    style={{ fill: CATEGORY_VAR[node.category] }}
                  />
                  <text
                    className="svg-label small atlas-label"
                    x={p.x}
                    y={p.y + r + 13}
                    textAnchor="middle"
                    aria-hidden="true"
                  >
                    {node.title}
                  </text>
                </a>
              );
            })}
          </g>
        </svg>

        <div className="atlas-controls" role="group" aria-label="Zoom controls">
          <button type="button" className="atlas-btn" onClick={zoomIn} aria-label="Zoom in">
            +
          </button>
          <button type="button" className="atlas-btn" onClick={zoomOut} aria-label="Zoom out">
            −
          </button>
          <button type="button" className="atlas-btn" onClick={reset} aria-label="Reset view">
            ⟲
          </button>
        </div>
      </div>

      <div className="atlas-legend">
        {CATEGORIES.map((c) => (
          <span className="atlas-legend-item" key={c.slug}>
            <span className="atlas-swatch" style={{ background: CATEGORY_VAR[c.slug] }} aria-hidden="true" />
            {c.title}
          </span>
        ))}
        <span className="atlas-legend-item atlas-legend-sim">
          <span className="atlas-swatch-ring" aria-hidden="true" />
          ring = has interactive sim
        </span>
      </div>
    </div>
  );
}
