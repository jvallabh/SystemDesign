# The Literal Atlas Graph

> A zoomable, spatial concept map built from the existing `related:` frontmatter, with mastery/progress overlaid — making the name "Atlas" literal.
> Status: backlog · Effort: M · Fits static + no-backend: **yes**

## The ceiling it breaks

The project is called "Atlas," but navigation is six flat sidebar lists — there is no map. Yet every article already declares its 4–5 neighbours in `related:` frontmatter, so a real topic graph exists as data; it's just never rendered as one. Turning that latent graph into an explorable spatial map delivers on the product's core metaphor and is a standout portfolio visual, with essentially no content work.

## What it is

An interactive concept map (its own page, and/or the landing hero): 30 nodes, one per topic, colored by category, connected by the `related:` edges. Pan/zoom; hover a node to highlight its neighbourhood; click to open the article. Optionally overlay the learner's progress ([mastery layer](04-mastery-layer.md)) so the map doubles as a "what have I learned / what's next" dashboard — mastered nodes filled, adjacent-unvisited nodes glowing as suggested next steps.

## How it works (reusing what exists)

- **Edges already exist**: `related:` in every topic's frontmatter (ids like `caching/cdn`) — the same data `TopicLayout` renders as "Related concepts" chips. A build step collects all topics + their `related` arrays into a graph JSON.
- **Categories + colors already exist**: `src/data/categories.ts` (6 categories) and the theme tokens give per-category coloring for free.
- **Rendering stays in-house**: a force-directed or precomputed layout drawn as SVG + `requestAnimationFrame` (reuse `useRafLoop`), no D3/graph library — consistent with the no-libraries rule. Layout can be precomputed at build time (deterministic) so first paint is instant and SSR-safe, with light interactivity hydrated on top.
- Node/edge theming via the existing `.f-*`/`.s-*` classes + `style` objects for dynamic (category) color.

## Scope: v1 vs later

**v1:** static-precomputed layout of all 30 topics, category-colored, `related:` edges, hover-highlight + click-through, on its own page linked from nav; theme-aware; reduced-motion-safe (no perpetual jitter).
**Later:** live force simulation with drag, progress overlay, filter by category, "shortest path between two topics," edges weighted by co-occurrence, embedding the map as the landing hero.

## Risks / dependencies / open decisions

- **Directedness / symmetry:** `related:` is not guaranteed symmetric (A lists B, B may not list A). Decide whether to render directed edges or symmetrize.
- **Layout legibility** at 30 nodes with ~5 edges each — precompute and hand-tune anchor positions if force-layout is too hairball.
- Pairs naturally with the [mastery layer](04-mastery-layer.md) (progress overlay) and is the most reusable navigation counterpart to full-text search ([quick wins](06-quick-wins.md)).
