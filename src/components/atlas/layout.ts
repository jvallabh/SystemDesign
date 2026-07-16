/**
 * Atlas layout — a deterministic, precomputed force-directed placement.
 *
 * NOT a live rAF force sim (that is deferred): this is a pure function of the
 * graph, run once in the page frontmatter, so the SSR SVG is byte-identical to
 * the client's first render (no hydration mismatch) and works with JS off.
 *
 * Fruchterman–Reingold with two anti-hairball additions: nodes start at, and
 * are gently pulled toward, their category centroid (6 centroids on an ellipse),
 * and a post-pass enforces a minimum pairwise distance so labels stay legible.
 *
 * Determinism is load-bearing (SSR safety): no wall-clock reads and no unseeded
 * RNG anywhere — all randomness comes from a seeded mulberry32 (see below).
 */
import type { AtlasGraph } from './graph';
import { CATEGORY_SLUGS } from '../../data/categories';

export type Positions = Record<string, { x: number; y: number }>;

interface LayoutOpts {
  width?: number;
  height?: number;
  iterations?: number;
  seed?: number;
}

/** Seeded PRNG (mulberry32) — same generator as the sims, for SSR determinism. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

const PADDING = 56; // keep node centres this far from the viewBox edge
const MIN_DIST = 46; // target minimum pairwise distance (px)
const GRAVITY = 0.09; // per-iteration pull toward the category centroid
const K_SCALE = 0.62; // <1 tightens the ideal edge length for a small graph

export function computeLayout(graph: AtlasGraph, opts: LayoutOpts = {}): Positions {
  const width = opts.width ?? 1000;
  const height = opts.height ?? 640;
  const iterations = opts.iterations ?? 300;
  const seed = opts.seed ?? 1;

  const rand = mulberry32(seed);
  const nodes = graph.nodes;
  const n = nodes.length;

  // 6 category centroids evenly spaced on an ellipse, ordered per CATEGORIES.
  const cx = width / 2;
  const cy = height / 2;
  const rx = 0.36 * width;
  const ry = 0.36 * height;
  const centroid: Record<string, { x: number; y: number }> = {};
  const catCount = CATEGORY_SLUGS.length;
  CATEGORY_SLUGS.forEach((slug, i) => {
    const a = (i / catCount) * Math.PI * 2 - Math.PI / 2; // first centroid at 12 o'clock
    centroid[slug] = { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
  });
  const centreFallback = { x: cx, y: cy };

  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const gx = new Float64Array(n); // this node's centroid
  const gy = new Float64Array(n);
  const index: Record<string, number> = {};

  nodes.forEach((node, i) => {
    index[node.id] = i;
    const c = centroid[node.category] ?? centreFallback;
    gx[i] = c.x;
    gy[i] = c.y;
    // Start at the centroid + seeded jitter (deterministic).
    px[i] = c.x + (rand() - 0.5) * 60;
    py[i] = c.y + (rand() - 0.5) * 60;
  });

  const edges = graph.edges.map((e) => [index[e.source], index[e.target]] as const);

  const k = K_SCALE * Math.sqrt((width * height) / Math.max(1, n)); // ideal distance
  const k2 = k * k;
  let temp = width * 0.1; // max displacement per step
  const cooling = temp / (iterations + 1); // linear cooling

  const dx = new Float64Array(n);
  const dy = new Float64Array(n);

  for (let iter = 0; iter < iterations; iter++) {
    dx.fill(0);
    dy.fill(0);

    // Repulsion: every pair pushes apart with force k²/d.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ex = px[i] - px[j];
        let ey = py[i] - py[j];
        let d = Math.sqrt(ex * ex + ey * ey);
        if (d < 0.01) {
          // Coincident: nudge apart in a seeded direction so it stays deterministic.
          ex = rand() - 0.5;
          ey = rand() - 0.5;
          d = Math.sqrt(ex * ex + ey * ey) || 0.01;
        }
        const f = k2 / d;
        const ux = (ex / d) * f;
        const uy = (ey / d) * f;
        dx[i] += ux;
        dy[i] += uy;
        dx[j] -= ux;
        dy[j] -= uy;
      }
    }

    // Attraction: spring along each edge with force d²/k.
    for (const [a, b] of edges) {
      let ex = px[a] - px[b];
      let ey = py[a] - py[b];
      const d = Math.sqrt(ex * ex + ey * ey) || 0.01;
      const f = (d * d) / k;
      const ux = (ex / d) * f;
      const uy = (ey / d) * f;
      dx[a] -= ux;
      dy[a] -= uy;
      dx[b] += ux;
      dy[b] += uy;
    }

    // Gentle gravity toward the node's category centroid (anti-hairball).
    for (let i = 0; i < n; i++) {
      dx[i] += (gx[i] - px[i]) * GRAVITY * k;
      dy[i] += (gy[i] - py[i]) * GRAVITY * k;
    }

    // Apply, limited by the current temperature; then cool.
    for (let i = 0; i < n; i++) {
      const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1;
      const step = Math.min(d, temp);
      px[i] = clamp(px[i] + (dx[i] / d) * step, PADDING, width - PADDING);
      py[i] = clamp(py[i] + (dy[i] / d) * step, PADDING, height - PADDING);
    }
    temp -= cooling;
  }

  // Post-pass: relax toward a minimum pairwise distance, re-clamping each sweep.
  // The usable area (≈888×528) vastly exceeds what 30 nodes at 46px need, so
  // this converges well within the sweep budget.
  for (let sweep = 0; sweep < 120; sweep++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ex = px[j] - px[i];
        let ey = py[j] - py[i];
        let d = Math.sqrt(ex * ex + ey * ey);
        if (d >= MIN_DIST) continue;
        if (d < 0.01) {
          ex = rand() - 0.5;
          ey = rand() - 0.5;
          d = Math.sqrt(ex * ex + ey * ey) || 0.01;
        }
        const push = (MIN_DIST - d) / 2;
        const ux = (ex / d) * push;
        const uy = (ey / d) * push;
        px[i] = clamp(px[i] - ux, PADDING, width - PADDING);
        py[i] = clamp(py[i] - uy, PADDING, height - PADDING);
        px[j] = clamp(px[j] + ux, PADDING, width - PADDING);
        py[j] = clamp(py[j] + uy, PADDING, height - PADDING);
        moved = true;
      }
    }
    if (!moved) break;
  }

  const positions: Positions = {};
  let minObserved = Infinity;
  for (let i = 0; i < n; i++) {
    const x = px[i];
    const y = py[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Atlas layout: non-finite position for "${nodes[i].id}".`);
    }
    if (x < PADDING - 0.5 || x > width - PADDING + 0.5 || y < PADDING - 0.5 || y > height - PADDING + 0.5) {
      throw new Error(`Atlas layout: position for "${nodes[i].id}" out of bounds (${x}, ${y}).`);
    }
    positions[nodes[i].id] = { x, y };
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = Math.hypot(px[i] - px[j], py[i] - py[j]);
      if (d < minObserved) minObserved = d;
    }
  }
  if (minObserved < 40) {
    throw new Error(`Atlas layout: minimum pairwise distance ${minObserved.toFixed(1)}px < 40px.`);
  }

  return positions;
}
