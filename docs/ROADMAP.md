# ROADMAP — System Design Atlas

> Status date: 2026-07-11. Companion docs: [EXPLAINER.md](EXPLAINER.md), [ADR.md](ADR.md).

## Shipped

- **Site shell** (`90dc9cf`): Astro scaffold, dark/light theme, nav, 30 topic stubs, sim harness, GitHub Pages deploy.
- **All six content waves** — every topic at full depth, 12 flagship sims live:
  - Caching (`7664bda`), Scalability (`c00e7ae`), Distributed systems (`3335707`), Data & storage (`93fdd45`), Communication & APIs (`a1d0f96`), Architecture patterns (`01ae8e0`).
- Curated resource keys in `resources.json` replacing broken YouTube-search links.

## Shipped — Phase 8 polish (2026-07-11)

- Cross-topic inline links site-wide + `related:` frontmatter rendered as "Related concepts" chips (link format `[text](/SystemDesign/topics/<category>/<slug>/)`; all 30 targets verified resolving in dist).
- OG/Twitter/canonical meta (trailing-slash-normalized), site-wide `og-card.png` (1200×630), `sitemap.xml` (31 URLs), `robots.txt`.
- Landing hero entrance + CSS-only cross-document view transitions, both disabled under `prefers-reduced-motion`.
- A11y: sims start paused for reduced-motion users, consistent `:focus-visible` ring, keyboard-accessible mobile nav toggle with `aria-expanded`.
- Content-debt fixes from the old backlog: 8–16KB page size, clickstream clarification, JWT-verification reconciling sentence, Stripe versioning claim, REST diagram staggered, hop-latency numbers annotated.

## Backlog

| Item | Where | Note |
|---|---|---|
| **Light-theme `--accent` (#0d9488) as link/readout text fails AA** (3.74:1 on white) | `theme.css` / site-wide | brand-color decision: e.g. #0f766e ≈ 4.9:1; dark theme fine (12.7:1) |
| `scroll-behavior: smooth` not gated on reduced-motion | `global.css` | add `@media (prefers-reduced-motion: reduce)` override |
| Replication/replica-lag teaching has no owning page | `databases.mdx` | if a Replication topic is added, shrink to a pointer |
| Per-topic OG images (one shared card today); sitemap lacks `<lastmod>` | layouts / `sitemap.xml.ts` | nice-to-have |
| Hero card stagger hardcoded for 6 categories | `index.astro` | 7th category card would animate undelayed |
| Workload segment labels ~190px vs 180px controls rail | `SqlNosqlSim` / `controls.css` | may wrap/clip on narrow layouts |
| `buildLane` recomputed 4× per frame | `ApiStylesSim.tsx` | useMemo on [scenario, latency] if ever touched again |
| Bounded queue can transiently hit 51 (redelivery bypasses cap) | `MessageQueuesSim.tsx` | matches real broker semantics; document or clamp |
| "Reshard +1" silently no-ops at 8/8 | `ShardingSim.tsx` | peer sims show capacity in the button label |
| Lighthouse run against the live deploy | — | local gate covers build/links/hydration; a real Lighthouse pass on Pages still worth one look |

## Watch-fors when adding future topics

- A reliability topic (circuit breakers/retries) will collide with sync-vs-async's "survival kit" paragraph — trim there when it lands.
- Rate Limiting page vs message-queues' backpressure section — verified no overlap today; re-check if either is rewritten.
- Idempotency how-to is owned by the Idempotency page; three architecture-patterns pages carry short mentions that must stay short.
