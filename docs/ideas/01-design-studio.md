# The Design Studio

> Composable drag-and-drop sandbox that fuses the 12 isolated sims into one queueing-network engine — the interview whiteboard the Atlas doesn't have.
> Status: **in progress** · Effort: L · Fits static + no-backend: **yes**

## The ceiling it breaks

Today every simulation is a closed world teaching one concept. The learner reads and watches; they never *build*. But a system-design interview is exactly the opposite skill — compose primitives (load balancer, cache, queue, database) into a whole system and reason about where it breaks. The Studio turns the Atlas from "read about primitives" into "assemble a system, turn on traffic, and watch it flow, back up, and cascade-fail." It's the single most identity-shifting upgrade: encyclopedia → simulator.

## What it is

A dedicated page (`/studio`) with a drag-and-drop canvas. Drag components from a palette (Traffic Source, Load Balancer, App Server, Cache, Database, Queue), wire them into a topology, turn on traffic, and watch request tokens flow through the graph. Per-node utilization colors from green to red; queues fill; over-capacity nodes drop. Live readouts show system throughput and end-to-end p50/p99 latency. Click a node to kill it and watch the failure cascade. Load a preset ("read-heavy web app") to start from a real design, and share your topology as a URL.

## How it works (reusing what exists)

The engine is a **discrete-event particle model** that generalizes `LoadBalancingSim.tsx`: request tokens flow through a directed graph of typed nodes, each an M/M/1 (App = M/M/c) queue station.

- **Token routing / queues / kill-node** come straight from `LoadBalancingSim` (`pickServer`, `loadOf`, per-server queue + drain, `QUEUE_CAP` overflow drops, click-to-kill).
- **Latency model** is `ScalingSim`'s M/M/1 (`latency = base/(1−util)`) — but measured from real tokens (`completeMs − bornMs`), so the hockey-stick *emerges* rather than being drawn. `ScalingSim`'s `utilFill` color ramp and M/M/c capacity carry over.
- **Cache hit/miss branching** and the seeded `mulberry32` PRNG come from `CachingSim`.
- The shared harness (`useRafLoop`, the control kit, `.f-*`/`.s-*` theming, `withBase`) is reused wholesale. Only the 3-pane chrome (Palette · Canvas · Inspector) is new, because `SimFrame`'s 2-column grid doesn't fit.

No new dependencies: hand-rolled SVG pointer-events for drag/wire (no graph or animation libraries), consistent with the project's "tiny bundles are the portfolio point" stance.

## Scope: v1 vs later

**v1:** 6 node types with real behavior + params; add/move/wire/select/delete/kill; live token flow with per-node queue depth + util color + drops; readouts (throughput, p50, p99, drops); global traffic-rate slider + play/pause/reset; 3 presets; shareable `?d=` permalink; validation warnings; keyboard-accessible kill + delete; reduced-motion starts paused.

**Later:** undo/redo, saved designs (localStorage), copy/paste, animated failure-cascade + response-return path viz, full mobile drag-and-drop, auto-layout/snapping, more node types (CDN/edge, read-replica, sharded DB, rate limiter), per-node latency histograms, a guided case-study mode layered on presets, retries/circuit-breakers.

## Risks / dependencies / open decisions

- **Hydration:** the Studio is embedded `client:only="react"` (initial graph depends on client-only `location.search`) — a documented exception to the "never client:only" rule, recorded as an ADR.
- **Pointer↔SVG mapping** must recompute `getScreenCTM().inverse()` per event to survive scroll/resize; gestures disambiguated by hit target + a drag threshold.
- **Runaway tokens / user-drawn cycles** bounded by `MAX_TOKENS`, `MAX_HOPS` drop, and per-node `queueCap`.
- Bridges naturally into [05 — case studies](05-case-studies.md) (presets become guided designs) and [06 — quick wins](06-quick-wins.md) (the share-URL encoding is the same idea as sim permalinks).
