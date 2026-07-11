# Implementation Plan

Phased build plan for System Design Atlas. Each phase ends with a deployed, fully working site — content quality grows wave by wave. Design rationale for everything here lives in [DECISIONS.md](DECISIONS.md).

## Phase 1 — Site shell ✅ (shipped 2026-07-10)

- Astro 5 + React islands + MDX scaffold, GitHub Pages deploy pipeline
- Dark-first theme with light toggle, responsive sidebar nav, landing page
- All 30 topic pages stubbed with frontmatter, summaries, and resource links
- Simulation harness: `SimFrame` chrome, `useRafLoop`, control primitives, smoke-test sim proving hydration under the base path
- Resolved lnkd.in resource links checked into `src/data/resources.json` with a build-time unknown-key guard
- `docs/DECISIONS.md`

## Phases 2–7 — Content waves (one per category)

Each wave fills every topic page in one category: original explanation, static SVG diagrams (`Diagram` component, theme-aware color classes), a "Further learning" section, and the category's flagship simulations. Suggested order front-loads the most sim-heavy, highest-traffic categories:

| Phase | Category | Written pages | Simulations |
|---|---|---|---|
| 2 ✅ (2026-07-10) | Caching | CDN | CachingSim (strategy + eviction toggles, hit-rate readout), BloomFiltersSim (insert/query, false-positive hunt) |
| 3 ✅ (2026-07-10) | Scalability | Availability, Proxy vs Reverse Proxy, Stateful vs Stateless | LoadBalancingSim (strategy race, click-to-kill servers), RateLimitingSim (4 algorithms, burst button), ScalingSim (vertical vs horizontal breaking points) |
| 4 ✅ (2026-07-11) | Distributed Systems Theory | Distributed Algorithms, Idempotency, Concurrency vs Parallelism | CapTheoremSim (partition a 3-node cluster), ConsistentHashingSim (ring, vnode slider, % keys remapped) |
| 5 | Data & Storage | Databases, ACID Transactions, CDC | SqlNosqlSim (data-shape/query-pattern explorer), ShardingSim (range vs hash, hot shards, resharding) |
| 6 | Communication & APIs | APIs, REST, Webhooks, API Gateways, JWTs | ApiStylesSim (REST/gRPC/GraphQL/tRPC trade-off explorer), PollingWebSocketsSim (latency + overhead comparison) |
| 7 | Architecture Patterns | Services, Sync vs Async, Batch vs Stream | MessageQueuesSim (producer/consumer backpressure) |

Head start on phase 5: `SqlNosqlSim.tsx` and `ShardingSim.tsx` are already checked in (built during an interrupted run) — the wave should audit and review them rather than rebuild.

**Definition of done per topic page**
- Written tier: original explanation (~600–1200 words), ≥1 static SVG diagram, real-world examples, further-learning links
- Flagship tier: all of the above plus a working simulation following the `SmokeTestSim` pattern, embedded `client:visible`
- Build passes; no un-prefixed internal links; both themes render correctly

**Open item (resolved 2026-07-10):** the source links for CDC, Caching, Caching Strategies, Cache Eviction Policies, and CDN were YouTube search queries — replaced with hand-curated resources in `resources.json` (AWS/web.dev for CDN, Confluent/Red Hat for CDC, CodeAhoy/AWS whitepaper for caching strategies).

## Phase 8 — Polish pass

- Landing-page motion (subtle hero animation), page-transition niceties
- Cross-topic "related concepts" links between pages
- OpenGraph/social cards and sitemap for shareability
- Lighthouse pass: performance, accessibility (keyboard/screen-reader support in sims), SEO

## Later ideas (not committed)

- Search across topics
- A guided "interview prep path" ordering across categories
- Custom domain
