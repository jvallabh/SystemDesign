# ROADMAP — System Design Atlas

> Status date: 2026-07-11. Companion docs: [EXPLAINER.md](EXPLAINER.md), [ADR.md](ADR.md).

## Shipped

- **Site shell** (`90dc9cf`): Astro scaffold, dark/light theme, nav, 30 topic stubs, sim harness, GitHub Pages deploy.
- **All six content waves** — every topic at full depth, 12 flagship sims live:
  - Caching (`7664bda`), Scalability (`c00e7ae`), Distributed systems (`3335707`), Data & storage (`93fdd45`), Communication & APIs (`a1d0f96`), Architecture patterns (`01ae8e0`).
- Curated resource keys in `resources.json` replacing broken YouTube-search links.

## Next — Phase 8 polish (on explicit go-ahead only)

From `IMPLEMENTATION-PLAN.md` plus accumulated items:

- Landing-page motion (subtle hero animation), page-transition niceties.
- **Cross-topic links** — articles currently reference siblings by plain text only (deliberate; see ADR-10). Wire them into real links site-wide in one pass.
- OG/social cards per topic.
- Accessibility pass (keyboard nav through sims is partially there; audit focus order, reduced-motion, contrast in both themes).
- Lighthouse pass (should be near-perfect already for non-sim pages; verify island hydration cost on flagships).
- README refresh + mark Phase 8 shipped in the plan doc when done.

## Backlog — content debt harvested from reviewer/coherence concerns

Small, factual, or structural items the review agents flagged but correctly left alone. Worth batching into a single cleanup pass:

| Item | Where | Note |
|---|---|---|
| "8KB page size" also names InnoDB (16KB) | `databases.mdx` | change to "8–16KB" |
| Replication/replica-lag teaching has no owning page | `databases.mdx` | if a Replication topic is ever added, shrink this section to a pointer |
| JWT verification location tension | `jwts.mdx` vs `api-gateways.mdx` | per-service verify vs verify-once-at-edge; add one reconciling sentence on either page |
| Network-hop latency numbers differ | `services.mdx` (0.5–10ms) vs `sync-vs-async.mdx` (20ms median) | harmonize or annotate what each includes |
| Clickstream lands in Cassandra on one page, ClickHouse on another | `sql-vs-nosql.mdx` vs `databases.mdx` | both correct; consider one clarifying clause |
| REST diagram draws 3 sequential requests as simultaneous fan-out | `rest-grpc-graphql-trpc.mdx` | stagger the arrows |
| Stripe "versions from early 2010s" claim | `apis.mdx` | Stripe moved to named major releases in 2024; soften or verify |
| Workload segment labels ~190px vs 180px controls rail | `SqlNosqlSim` / `controls.css` | may wrap/clip on narrow layouts |
| `buildLane` recomputed 4× per frame | `ApiStylesSim.tsx` | useMemo on [scenario, latency] if ever touched again |
| Bounded queue can transiently hit 51 (redelivery bypasses cap) | `MessageQueuesSim.tsx` | matches real broker semantics; document or clamp |
| "Reshard +1" silently no-ops at 8/8 | `ShardingSim.tsx` | peer sims show capacity in the button label |

## Watch-fors when adding future topics

- A reliability topic (circuit breakers/retries) will collide with sync-vs-async's "survival kit" paragraph — trim there when it lands.
- Rate Limiting page vs message-queues' backpressure section — verified no overlap today; re-check if either is rewritten.
- Idempotency how-to is owned by the Idempotency page; three architecture-patterns pages carry short mentions that must stay short.
