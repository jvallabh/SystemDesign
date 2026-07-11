# EXPLAINER — How System Design Atlas Was Built

> Companion docs: [ROADMAP.md](ROADMAP.md), [ADR.md](ADR.md), [DECISIONS.md](DECISIONS.md), [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md).

## What it is

System Design Atlas (https://jvallabh.github.io/SystemDesign/) is a static teaching site: 30 system-design topics across six categories, each a full original article with theme-aware SVG diagrams, curated further-learning links, and — for the 12 "flagship" topics — an interactive simulation. Built in two days (2026-07-10 → 07-11): one day for the shell, one for all content.

## Stack and site architecture

- **Astro + MDX**, statically built, deployed to GitHub Pages via a GitHub Actions workflow. 32 pages total (30 topics + landing + topic index).
- **Content collections**: every topic is one `.mdx` file under `src/content/topics/<category>/<slug>.mdx` with frontmatter (`title`, `category`, `tier`, `order`, `summary`, `resources`, optional `sim`). The layout renders title, further-learning section (from `resources` keys resolved against `src/data/resources.json`), and navigation — articles never hand-roll those.
- **React islands** only where interactivity pays: each flagship article embeds exactly one sim component with `client:visible`. Everything else ships zero JS.
- **Theming**: dark/light via CSS custom properties in `src/styles/theme.css`. SVG diagrams and sims never use raw colors — only utility classes (`.f-*` fills, `.s-*` strokes, `.svg-label` text) defined at the bottom of `src/styles/global.css`, because CSS `var()` is invalid in SVG presentation attributes (silently renders black). Dynamic colors in sims go through style objects (`style={{ fill: 'var(--ok)' }}`), which *is* valid CSS.
- **Sim harness** (`src/components/sims/`): `SimFrame.tsx` (chrome: title, play/pause/reset, readouts), `hooks/useRafLoop.ts` (single rAF loop, dt-based), `controls/` (Slider, Toggle, SegmentedControl, Button, Readout), and `SmokeTestSim.tsx` as the canonical reference. Every sim follows the same architecture: pure module-level `initWorld()`/`stepWorld(world, dtMs, ...)`, world state in `useRef`, params in `useState`, one `setTick` bump per frame. `initWorld` is deterministic (seeded PRNG) so SSR and hydration markup match.

## The content pipeline (the interesting part)

All 30 articles and 12 sims were produced by a **single parameterized multi-agent workflow script**, run once per category ("wave"). The script holds the complete editorial plan as data:

- **`TOPICS`**: per topic — file path, tier, a content `brief` (the article's thesis and arc), a `must` list (checkable coverage items), an `owns` scope, and an `adjacent` list naming what *neighboring pages* own. The owns/adjacent pair is the anti-duplication mechanism: writers are told "stay in your lane — mention sibling topics by name at most."
- **`SIMS`**: per sim — a detailed behavioral spec (entities, controls, readouts, and crucially *"behavior to make visible"* — the pedagogical payoff, e.g. "fixed windows admit a double burst straddling the boundary").
- **Shared rule blocks** (`MDX_RULES`, `SIM_RULES`): the hard-won constraints — MDX-as-JSX gotchas (no `{}` in prose, `class=` not `className`), the SVG color rules, the sim architecture contract, SSR-safety, bounded memory, NaN guards.

Per wave, the script runs:

1. **Write → Review chains, one per article.** A writer agent reads the conventions docs and rewrites the stub into a 700–1500-word article. Then an adversarial reviewer ("assume defects; find and fix them in place") re-verifies frontmatter, MDX validity, SVG rules, coordinates/overflow by mental arithmetic, and — highest value — content correctness against the `must` list. It returns structured `{fixes, concerns}` via a JSON schema.
2. **Build → Review chains, one per sim.** Builder implements against the spec (or audits/completes a partial file left by an interrupted run); an adversarial sim reviewer hand-steps `stepWorld` at dt=16, checks pattern conformance, frame-rate independence, SSR safety, and rendering rules. Reviewers sometimes wrote scratch harnesses to verify numerically (e.g. ShardingSim's reshard-fraction math, PollingWebSocketsSim's latency averages).
3. **Coherence pass** over the whole category: dedupe teaching across pages using the ownership map, fix cross-page contradictions and naming inconsistencies, verify summaries.

Concurrency is a worker pool inside the script (`CONCURRENCY = 4`; originally full fan-out, then 2, then 4 — see ADR-6). Each article/sim chain stays internally sequential; the pool bounds how many chains run at once.

## Verification gate (per wave, before commit)

1. `npx tsc --noEmit` — strict TypeScript over the sims.
2. `npm run build` — Astro build of all pages (catches MDX/JSX violations).
3. `grep dist/` for un-prefixed `href="/topics` (GitHub Pages base-path bug class).
4. Grep wave files for hex/named colors or `var()` in SVG `fill=`/`stroke=` attributes (the silent-black bug class).
5. `grep -c astro-island` on flagship pages — proves the sim island actually hydrates.

Then: one commit per wave, push, next wave.

## Failure handling

Session usage limits killed agents mid-wave twice. The recovery design:

- **Workflow resume** (`resumeFromRunId`): completed agents replay from a journal cache keyed by (prompt, opts); only failed/new agents run live. The communication-apis wave lost 6 of 17 agents to a limit hit; resume redid exactly those 6.
- **Interrupted-run semantics baked into prompts**: writers rewrite files wholesale (safe to re-run), sim builders audit-and-complete existing partial files rather than blindly rewriting.
- **Retry-net cron**: a session cron every ~31 min that checks whether the current wave is running, resumes it if it died, and runs the verify+commit cycle if it finished unattended. Deleted once its wave shipped.

## Timeline and scale

| Wave | Commit | Agents | Notes |
|---|---|---|---|
| Site shell (M1) | `90dc9cf` | — | scaffold, theme, nav, 30 stubs, sim harness, deploy |
| Caching | `7664bda` | ~7 | first wave, previous session |
| Scalability | `c00e7ae` | ~15 | previous session |
| Distributed systems | `3335707` | ~13 | previous session |
| Data & storage | `93fdd45` | 15 | ~587k subagent tokens, ~19 min, zero errors |
| Communication & APIs | `a1d0f96` | 19 | survived session-limit hit via resume; ~1.07M tokens across both passes |
| Architecture patterns | `01ae8e0` | 11 | ~432k tokens, ~19 min, zero errors |

Roughly 500k–1M subagent tokens per wave; the review layers (adversarial per-file + coherence) consistently caught real bugs the writers/builders missed — factual errors, SVG overflow, terminology clashes between pages written in parallel (e.g. "N+1" meaning opposite things on two API pages).
