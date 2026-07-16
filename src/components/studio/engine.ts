/**
 * The Design Studio engine — a pure, framework-free queueing-network model.
 *
 * Generalizes the LoadBalancingSim token engine: request tokens flow through a
 * directed graph of typed nodes, each an M/M/1 (App = M/M/c) service station.
 * End-to-end latency is measured from real tokens (completeMs - bornMs), so the
 * queueing hockey-stick emerges rather than being drawn; throughput is measured
 * at completion events and plateaus at the bottleneck by construction.
 *
 * Contract (ADR-3): module-level pure functions, deterministic seeded PRNG,
 * bounded arrays, NaN-guarded at parameter extremes. No React, no DOM.
 */

export type NodeType = 'source' | 'lb' | 'app' | 'cache' | 'db' | 'queue';
export type Strategy = 'rr' | 'lc' | 'p2c' | 'rand';

export interface NodeParams {
  /** Service rate, jobs/s. For App this is per-instance. */
  capacity: number;
  /** App only: instance count → M/M/c capacity. 1 for other types. */
  instances: number;
  /** Cache only: fraction of requests served without hitting the backing store. */
  hitRatio: number;
  /** Buffer depth; arrivals beyond this are dropped. */
  queueCap: number;
  /** LB only: successor-selection strategy. */
  strategy: Strategy;
}

/** A node as authored/serialized (no runtime state). */
export interface GraphNode {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  params: NodeParams;
}

export interface Edge {
  from: string;
  to: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: Edge[];
}

export interface Token {
  id: number;
  bornMs: number;
  hops: number;
  // in-flight animation fields (valid while the token is in world.flights)
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  elapsedMs: number;
  durationMs: number;
  toNode: string;
}

/** A node plus its live runtime state. A token is in exactly one place: either
 *  world.flights (animating along an edge) or exactly one node's queue. */
export interface SimNode extends GraphNode {
  queue: Token[];
  progress: number;
  alive: boolean;
  rrIndex: number;
  /** Rolling arrival timestamps (ms), pruned to the utilization window. */
  arrivals: number[];
  /** Source only: ms until the next spawn. */
  spawnInMs: number;
}

export interface Fade {
  id: number;
  kind: 'done' | 'drop';
  x: number;
  y: number;
  age: number;
}

interface LatSample {
  t: number;
  v: number;
}

export interface World {
  clockMs: number;
  rngState: number;
  nodes: SimNode[];
  edges: Edge[];
  /** node id → successor ids; rebuilt from edges only when adjDirty. */
  adj: Record<string, string[]>;
  adjDirty: boolean;
  flights: Token[];
  fades: Fade[];
  dropped: number;
  completions: number[];
  lat: LatSample[];
  nextTokenId: number;
  nextFadeId: number;
}

// --- constants ---------------------------------------------------------------

const EPS = 0.001;
export const MAX_TOKENS = 350;
const MAX_HOPS = 50;
const MAX_FADES = 60;
const MAX_SAMPLES = 400;
const TPUT_WINDOW_MS = 2000;
const LAT_WINDOW_MS = 5000;
const UTIL_WINDOW_MS = 2000;
const FADE_MS = 600;
const FLIGHT_SPEED = 0.28; // px/ms — frame-rate independent

/** Node box geometry (top-left origin). Shared with the renderer. */
export const NODE_W = 116;
export const NODE_H = 64;

export const TYPE_LABEL: Record<NodeType, string> = {
  source: 'Traffic Source',
  lb: 'Load Balancer',
  app: 'App Server',
  cache: 'Cache',
  db: 'Database',
  queue: 'Queue',
};

export const TYPE_CODE: Record<NodeType, string> = {
  source: 'S',
  lb: 'L',
  app: 'A',
  cache: 'C',
  db: 'D',
  queue: 'Q',
};

export const CODE_TYPE: Record<string, NodeType> = {
  S: 'source',
  L: 'lb',
  A: 'app',
  C: 'cache',
  D: 'db',
  Q: 'queue',
};

/** Types that terminate a request on their own if they have no successor. */
function canSelfComplete(t: NodeType): boolean {
  return t === 'db' || t === 'app' || t === 'cache';
}

// --- geometry ----------------------------------------------------------------

export function inPort(n: { x: number; y: number }): { x: number; y: number } {
  return { x: n.x, y: n.y + NODE_H / 2 };
}

export function outPort(n: { x: number; y: number }): { x: number; y: number } {
  return { x: n.x + NODE_W, y: n.y + NODE_H / 2 };
}

// --- deterministic PRNG (mulberry32) ----------------------------------------

function nextRand(w: World): number {
  w.rngState = (w.rngState + 0x6d2b79f5) | 0;
  let t = w.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// --- construction ------------------------------------------------------------

function makeNode(g: GraphNode): SimNode {
  return {
    id: g.id,
    type: g.type,
    x: g.x,
    y: g.y,
    params: { ...g.params },
    queue: [],
    progress: 0,
    alive: true,
    rrIndex: -1,
    arrivals: [],
    spawnInMs: 0,
  };
}

export function initWorld(graph: Graph): World {
  const w: World = {
    clockMs: 0,
    rngState: 0x1a2b3c4d,
    nodes: graph.nodes.map(makeNode),
    edges: graph.edges.map((e) => ({ ...e })),
    adj: {},
    adjDirty: true,
    flights: [],
    fades: [],
    dropped: 0,
    completions: [],
    lat: [],
    nextTokenId: 0,
    nextFadeId: 0,
  };
  rebuildAdj(w);
  return w;
}

export function nodeById(w: World, id: string): SimNode | undefined {
  return w.nodes.find((n) => n.id === id);
}

function rebuildAdj(w: World): void {
  const adj: Record<string, string[]> = {};
  for (const n of w.nodes) adj[n.id] = [];
  for (const e of w.edges) {
    if (adj[e.from] && w.nodes.some((n) => n.id === e.to)) adj[e.from].push(e.to);
  }
  w.adj = adj;
  w.adjDirty = false;
}

function aliveSuccessors(w: World, n: SimNode): string[] {
  const succ = w.adj[n.id] ?? [];
  return succ.filter((id) => {
    const t = nodeById(w, id);
    return !!t && t.alive && t.type !== 'source';
  });
}

function effCap(n: SimNode): number {
  if (n.type === 'app') {
    const inst = Math.max(1, n.params.instances);
    // Floor the coordination-overhead factor so a crafted instance count can
    // never drive effective capacity to zero or negative — that would blackhole
    // traffic while the node still read as idle (arrivals dropped before they
    // are counted, so utilization would show 0%).
    const eff = Math.max(0.1, 1 - 0.03 * (inst - 1));
    return inst * n.params.capacity * eff;
  }
  return n.params.capacity;
}

function totalTokens(w: World): number {
  let n = w.flights.length;
  for (const node of w.nodes) n += node.queue.length;
  return n;
}

// --- token lifecycle ---------------------------------------------------------

function newToken(w: World): Token {
  return {
    id: w.nextTokenId++,
    bornMs: w.clockMs,
    hops: 0,
    fromX: 0,
    fromY: 0,
    toX: 0,
    toY: 0,
    elapsedMs: 0,
    durationMs: 1,
    toNode: '',
  };
}

function pushFade(w: World, x: number, y: number, kind: Fade['kind']): void {
  if (w.fades.length >= MAX_FADES) w.fades.shift();
  w.fades.push({ id: w.nextFadeId++, kind, x, y, age: 0 });
}

function completeToken(w: World, token: Token, x: number, y: number): void {
  w.completions.push(w.clockMs);
  w.lat.push({ t: w.clockMs, v: Math.max(0, w.clockMs - token.bornMs) });
  if (w.lat.length > MAX_SAMPLES) w.lat.shift();
  pushFade(w, x, y, 'done');
}

function dropToken(w: World, x: number, y: number): void {
  w.dropped++;
  pushFade(w, x, y, 'drop');
}

function launchFlight(
  w: World,
  token: Token,
  from: { x: number; y: number },
  toNodeId: string,
): void {
  const target = nodeById(w, toNodeId);
  if (!target) {
    dropToken(w, from.x, from.y);
    return;
  }
  const to = inPort(target);
  const dist = Math.max(Math.hypot(to.x - from.x, to.y - from.y), 1);
  token.fromX = from.x;
  token.fromY = from.y;
  token.toX = to.x;
  token.toY = to.y;
  token.elapsedMs = 0;
  token.durationMs = dist / FLIGHT_SPEED;
  token.toNode = toNodeId;
  w.flights.push(token);
}

// --- routing -----------------------------------------------------------------

function pickSuccessor(w: World, node: SimNode, succ: string[]): string {
  const strat = node.params.strategy;
  if (strat === 'rr') {
    node.rrIndex = (node.rrIndex + 1) % succ.length;
    return succ[node.rrIndex];
  }
  if (strat === 'rand') {
    return succ[Math.floor(nextRand(w) * succ.length)];
  }
  if (strat === 'p2c') {
    if (succ.length === 1) return succ[0];
    const i = Math.floor(nextRand(w) * succ.length);
    let j = Math.floor(nextRand(w) * (succ.length - 1));
    if (j >= i) j++;
    return loadOf(w, succ[i]) <= loadOf(w, succ[j]) ? succ[i] : succ[j];
  }
  // least connections
  let best = succ[0];
  let bestLoad = loadOf(w, best);
  for (const id of succ) {
    const l = loadOf(w, id);
    if (l < bestLoad) {
      best = id;
      bestLoad = l;
    }
  }
  return best;
}

/** Queue depth plus in-flight tokens already targeting a node (LB's
 *  inflight-aware least-connections — routing on queue length alone herds
 *  bursts because the flight delay hides decisions already made). */
function loadOf(w: World, nodeId: string): number {
  const n = nodeById(w, nodeId);
  let load = n ? n.queue.length : 0;
  for (const f of w.flights) if (f.toNode === nodeId) load++;
  return load;
}

function route(w: World, node: SimNode, token: Token): void {
  token.hops++;
  const from = outPort(node);
  if (token.hops > MAX_HOPS) {
    dropToken(w, from.x, from.y);
    return;
  }
  if (node.type === 'db') {
    completeToken(w, token, from.x, from.y); // terminal sink
    return;
  }
  if (node.type === 'cache' && nextRand(w) < node.params.hitRatio) {
    completeToken(w, token, from.x, from.y); // hit — served early, low latency
    return;
  }
  const succ = aliveSuccessors(w, node);
  if (succ.length === 0) {
    if (canSelfComplete(node.type)) completeToken(w, token, from.x, from.y);
    else dropToken(w, from.x, from.y); // source/lb/queue dead-end
    return;
  }
  const targetId = node.type === 'lb' ? pickSuccessor(w, node, succ) : rrPick(node, succ);
  launchFlight(w, token, from, targetId);
}

function rrPick(node: SimNode, succ: string[]): string {
  node.rrIndex = (node.rrIndex + 1) % succ.length;
  return succ[node.rrIndex];
}

// --- step phases -------------------------------------------------------------

function reconcile(w: World): void {
  if (w.adjDirty) rebuildAdj(w);
  for (const n of w.nodes) {
    const p = n.params;
    p.capacity = Math.max(EPS, p.capacity);
    p.instances = Math.min(64, Math.max(1, Math.round(p.instances)));
    p.hitRatio = Math.min(1, Math.max(0, p.hitRatio));
    p.queueCap = Math.max(1, Math.round(p.queueCap));
    if (n.queue.length > p.queueCap) {
      w.dropped += n.queue.length - p.queueCap;
      n.queue.length = p.queueCap;
    }
  }
}

function spawn(w: World, dtMs: number, rate: number): void {
  if (rate <= 0) return;
  for (const n of w.nodes) {
    if (n.type !== 'source' || !n.alive) continue;
    n.spawnInMs -= dtMs;
    while (n.spawnInMs <= 0) {
      const succ = aliveSuccessors(w, n);
      if (succ.length === 0) {
        dropToken(w, outPort(n).x, outPort(n).y);
      } else if (totalTokens(w) < MAX_TOKENS) {
        const t = newToken(w);
        n.rrIndex = (n.rrIndex + 1) % succ.length;
        launchFlight(w, t, outPort(n), succ[n.rrIndex]);
      }
      const gap = -Math.log(1 - nextRand(w)) * (1000 / rate);
      n.spawnInMs += Math.max(gap, 2);
    }
  }
}

function advanceFlights(w: World, dtMs: number): void {
  const survivors: Token[] = [];
  for (const t of w.flights) {
    t.elapsedMs += dtMs;
    if (t.elapsedMs < t.durationMs) {
      survivors.push(t);
      continue;
    }
    const node = nodeById(w, t.toNode);
    if (!node || !node.alive || node.type === 'source') {
      dropToken(w, t.toX, t.toY);
      continue;
    }
    if (node.queue.length >= node.params.queueCap) {
      dropToken(w, t.toX, t.toY);
      continue;
    }
    node.queue.push(t);
    node.arrivals.push(w.clockMs);
  }
  w.flights = survivors;
}

function drainAndRoute(w: World, dtMs: number): void {
  for (const node of w.nodes) {
    if (node.type === 'source') continue;
    if (!node.alive || node.queue.length === 0) {
      node.progress = 0;
      continue;
    }
    node.progress += effCap(node) * (dtMs / 1000);
    let guard = 0;
    while (node.progress >= 1 && node.queue.length > 0 && guard++ < 1000) {
      node.progress -= 1;
      const token = node.queue.shift();
      if (token) route(w, node, token);
    }
    if (node.queue.length === 0) node.progress = 0;
  }
}

function prune(w: World): void {
  const tcut = w.clockMs - TPUT_WINDOW_MS;
  while (w.completions.length > 0 && w.completions[0] < tcut) w.completions.shift();
  const lcut = w.clockMs - LAT_WINDOW_MS;
  while (w.lat.length > 0 && w.lat[0].t < lcut) w.lat.shift();
  const ucut = w.clockMs - UTIL_WINDOW_MS;
  for (const n of w.nodes) {
    while (n.arrivals.length > 0 && n.arrivals[0] < ucut) n.arrivals.shift();
  }
}

function ageFades(w: World, dtMs: number): void {
  const keep: Fade[] = [];
  for (const f of w.fades) {
    f.age += dtMs;
    if (f.age < FADE_MS) keep.push(f);
  }
  w.fades = keep;
}

export function stepWorld(w: World, dtMs: number, params: { rate: number }): void {
  reconcile(w);
  w.clockMs += dtMs;
  spawn(w, dtMs, params.rate);
  advanceFlights(w, dtMs);
  drainAndRoute(w, dtMs);
  prune(w);
  ageFades(w, dtMs);
}

// --- metrics -----------------------------------------------------------------

export function throughput(w: World): number {
  const win = Math.min(TPUT_WINDOW_MS, Math.max(w.clockMs, 1));
  return w.completions.length / (win / 1000);
}

export function percentile(w: World, p: number): number {
  const n = w.lat.length;
  if (n === 0) return 0;
  const sorted = w.lat.map((x) => x.v).sort((a, b) => a - b);
  const idx = Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))));
  return sorted[idx];
}

export function utilOf(w: World, node: SimNode): number {
  if (node.type === 'source') return 0;
  const seconds = Math.min(UTIL_WINDOW_MS, Math.max(w.clockMs, 1)) / 1000;
  const arrRate = node.arrivals.length / seconds;
  return Math.min(1, arrRate / Math.max(EPS, effCap(node)));
}

/** ScalingSim's ramp: green until ~40% utilization, easing to danger near 100%.
 *  Duplicated here (4 lines) to avoid touching the shipped sim. */
export function utilFill(u: number): string {
  const t = Math.min(1, Math.max(0, (u - 0.4) / 0.6));
  const pct = Math.round(t * t * 100);
  return `color-mix(in srgb, var(--danger) ${pct}%, var(--ok))`;
}

// --- validation --------------------------------------------------------------

export function validate(w: World): string[] {
  if (w.adjDirty) rebuildAdj(w);
  const warnings: string[] = [];
  if (w.nodes.length > 0 && !w.nodes.some((n) => n.type === 'source')) {
    warnings.push('No traffic source — add a Source to generate load.');
  }
  for (const n of w.nodes) {
    const succ = w.adj[n.id] ?? [];
    if (succ.length === 0 && !canSelfComplete(n.type) && n.type !== 'source') {
      warnings.push(`${TYPE_LABEL[n.type]} has no outgoing connection — requests here are dropped.`);
    }
    if (n.type === 'source' && succ.length === 0) {
      warnings.push('A Source has no outgoing connection — its traffic goes nowhere.');
    }
  }
  return warnings;
}

// --- graph editing (UI mutates the world through these) ---------------------

export function addNode(w: World, g: GraphNode): void {
  w.nodes.push(makeNode(g));
  w.adjDirty = true;
}

export function removeNode(w: World, id: string): void {
  w.nodes = w.nodes.filter((n) => n.id !== id);
  w.edges = w.edges.filter((e) => e.from !== id && e.to !== id);
  w.flights = w.flights.filter((f) => f.toNode !== id);
  w.adjDirty = true;
}

export function addEdge(w: World, from: string, to: string): boolean {
  if (from === to) return false;
  if (w.edges.some((e) => e.from === from && e.to === to)) return false;
  const target = nodeById(w, to);
  if (!nodeById(w, from) || !target || target.type === 'source') return false;
  w.edges.push({ from, to });
  w.adjDirty = true;
  return true;
}

export function removeEdge(w: World, from: string, to: string): void {
  w.edges = w.edges.filter((e) => !(e.from === from && e.to === to));
  w.adjDirty = true;
}

export function toggleAlive(w: World, id: string): void {
  const n = nodeById(w, id);
  if (!n) return;
  n.alive = !n.alive;
  if (!n.alive) {
    w.dropped += n.queue.length;
    n.queue = [];
    n.progress = 0;
  }
}

/** Snapshot the current graph (positions + params) for serialization/sharing. */
export function toGraph(w: World): Graph {
  return {
    nodes: w.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      x: n.x,
      y: n.y,
      params: { ...n.params },
    })),
    edges: w.edges.map((e) => ({ ...e })),
  };
}
