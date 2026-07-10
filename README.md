# System Design Atlas

A visual map of the concepts behind large-scale systems — interactive explanations of ~30 system design topics with original write-ups, diagrams, live simulations, and curated links for further learning.

**Live site:** https://jvallabh.github.io/SystemDesign/

## What's inside

Topics are organized into six thematic categories:

| Category | Topics |
|---|---|
| Communication & APIs | REST vs gRPC vs GraphQL vs tRPC ▶, Long Polling vs WebSockets ▶, APIs, REST, Webhooks, API Gateways, JWTs |
| Scalability | Load Balancing ▶, Rate Limiting ▶, Scaling ▶, Availability, Proxy vs Reverse Proxy, Stateful vs Stateless |
| Data & Storage | SQL vs NoSQL ▶, Sharding & Partitioning ▶, Databases, ACID Transactions, CDC |
| Caching | Caching Strategies & Eviction ▶, Bloom Filters ▶, CDN |
| Distributed Systems Theory | CAP Theorem ▶, Consistent Hashing ▶, Distributed Algorithms, Idempotency, Concurrency vs Parallelism |
| Architecture Patterns | Message Queues ▶, Services, Sync vs Async, Batch vs Stream |

▶ = flagship topic with a live, parameterized simulation (12 total) — e.g. add nodes to a consistent-hashing ring and watch keys remap, or slide the request rate against a token bucket.

## Stack

- [Astro](https://astro.build) with React islands and MDX — content is static HTML; simulations hydrate only when scrolled into view
- Zero animation libraries — sims are SVG + CSS + `requestAnimationFrame`
- Dark-first theme with a light toggle; all diagrams use CSS variables so both themes work
- Deployed to GitHub Pages via GitHub Actions on every push to `main`

## Development

```sh
npm install
npm run dev        # http://localhost:4321/SystemDesign/
npm run build      # static build to dist/
npm run preview    # serve the build locally
```

### Adding a topic

1. Create `src/content/topics/<category>/<slug>.mdx` with frontmatter (`title`, `category`, `tier`, `summary`, `order`, optional `sim` and `resources`).
2. Resource links live in `src/data/resources.json`; the build fails on unknown keys. Resolve new lnkd.in links with `node scripts/resolve-links.mjs <code>`.
3. Simulations follow the pattern in `src/components/sims/SmokeTestSim.tsx`: pure step function + `useRef` world + `useRafLoop` + `SimFrame` chrome. Embed with `<MySim client:visible />`.

Internal links and assets must go through `withBase()` (`src/utils/url.ts`) — the site serves from the `/SystemDesign` base path.

## Project docs

- [`docs/DECISIONS.md`](docs/DECISIONS.md) — design decisions and the options considered
- [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md) — phased build plan and current status
