# ADR — Architecture & Process Decisions, System Design Atlas

> Product/design rationale lives in [DECISIONS.md](DECISIONS.md); this file records the decisions — especially build-process ones — with their context and consequences. Status date: 2026-07-11.

## ADR-1: Astro + MDX static site with React islands

**Context.** Content-heavy teaching site; 30 pages of prose, 12 of which need real interactivity. **Decision.** Astro with MDX content collections; React only as `client:visible` islands for sims; GitHub Pages deploy. **Consequences.** Zero JS on 18 of 30 topic pages; sims hydrate lazily; the GitHub Pages base path means every internal link must be prefixed — a recurring bug class we gate on in verification (grep dist for `href="/topics`).

## ADR-2: SVG theme colors via utility classes, never `var()` in presentation attributes

**Context.** Site is dark/light switchable; diagrams are inline SVG. `fill="var(--x)"` is invalid in SVG presentation attributes and **silently renders black** — discovered the hard way in the first wave. **Decision.** All static SVG color goes through utility classes at the bottom of `global.css` (`.f-*`, `.s-*`, `.svg-label`); dynamic color in sims through style objects (valid CSS context). No hex/named colors anywhere. **Consequences.** Both themes render correctly by construction; the rule is enforced in writer/reviewer prompts and re-checked by grep in the per-wave verification gate. Known accepted exception: text elements use style-object vars when a `.f-*` class would lose the specificity fight against `.svg-label`.

## ADR-3: One canonical sim architecture (SmokeTestSim pattern)

**Context.** 12 sims built by different agents in parallel must be uniformly maintainable, SSR-safe, and frame-rate independent. **Decision.** Mandatory pattern: pure module-level `initWorld`/`stepWorld(world, dtMs, ...)`; world in `useRef`; single `useRafLoop`; deterministic seeded init for SSR/hydration match; bounded arrays; NaN guards at slider extremes. **Consequences.** Sim reviewers can verify by hand-stepping the pure functions; pause/reset semantics are identical everywhere; no hydration mismatches shipped.

## ADR-4: Content produced by a parameterized multi-agent workflow, one wave per category

**Context.** 30 articles + 12 sims is too much for one context window; quality had to survive parallel authorship. **Decision.** A single workflow script holding the full editorial plan as data (briefs, must-cover lists, sim specs, shared rule blocks), run once per category. Every artifact gets a write→adversarial-review chain; every wave ends with a category-wide coherence pass. Reviewers return structured `{fixes, concerns}` and fix in place rather than reporting upward. **Consequences.** Consistent voice and conventions across 30 pages; the review layers caught real defects every wave (factual errors, SVG overflow, cross-page terminology clashes). Cost: roughly 0.5–1M subagent tokens per wave.

## ADR-5: Topic ownership map ("stay in your lane")

**Context.** Adjacent topics (e.g. REST vs the API-styles comparison; caching vs CDN) naturally re-teach each other's material when written independently. **Decision.** Every topic declares `owns` and `adjacent` in the plan; writers must mention siblings by name only; the coherence pass enforces the map by trimming trespassing sections to pointers. **Consequences.** Duplication trimmed in every wave it appeared (polyglot-persistence example, 2PC explanation, broker mechanics); the map doubles as the collision checklist for future topics (see ROADMAP watch-fors).

## ADR-6: Concurrency bounded by an in-script worker pool (settled at 4)

**Context.** Full fan-out (7+ concurrent agents) repeatedly hit the account's session usage limit mid-wave, killing agents. **Decision.** Chains (article = write→review, sim = build→review) queue through a small worker pool inside the workflow script; user-tuned from unlimited → 2 → 4 (`CONCURRENCY` const). **Consequences.** Waves take ~19 min instead of ~8 but complete reliably; the limit was still hit once at 4-wide near a reset boundary, which resume absorbed (ADR-7).

## ADR-7: Recovery = workflow resume + retry-net cron + re-runnable prompts

**Context.** Session limits and interruptions are expected, not exceptional. **Decision.** Three layers: (1) `resumeFromRunId` replays completed agents from the journal cache and re-runs only failures; (2) a session cron (~31 min) resumes a dead wave or runs verify+commit if the wave finished unattended, and deletes itself when its wave ships; (3) prompts are written to be safely re-runnable — writers rewrite wholesale, sim builders audit-and-complete partial files. **Consequences.** The communication-apis wave lost 6/17 agents to a limit hit and completed cleanly on resume with zero duplicated work.

## ADR-8: Curated resource keys in `resources.json`, not inline links

**Context.** Early stub resources included YouTube *search-query* URLs that broke; articles hand-rolling "further learning" sections would drift. **Decision.** All external resources are keyed entries in `src/data/resources.json`; frontmatter lists keys; the layout renders the section. Broken links were replaced with hand-curated sources (AWS/web.dev, Confluent/Red Hat, etc.). **Consequences.** Link rot is fixable in one file; reviewers verify keys exist rather than URLs resolve (network checks are out of scope for agents — accepted risk, spot-check periodically).

## ADR-9: Per-wave verification gate before a single wave commit

**Context.** Parallel authors, known silent-failure classes (MDX-as-JSX, SVG colors, base path, hydration). **Decision.** Gate every wave on: `tsc --noEmit`, full Astro build, grep dist for un-prefixed topic hrefs, grep sources for hex/`var()` in SVG attributes, `grep -c astro-island` on flagship pages. One commit per wave; small doc/status tweaks folded in (or amended per the user's amend-follow-ups convention), never as separate noise commits. **Consequences.** Every wave commit landed green; git history reads as six clean feature increments.

## ADR-10: No cross-topic links until a dedicated phase

**Context.** Linking during parallel authorship invites broken/inconsistent anchors while pages are still being rewritten. **Decision.** Articles reference sibling topics as plain text; a Phase 8 pass wires real links site-wide once content is frozen. **Consequences.** Zero broken internal links shipped; the plain-text mentions are grep-able as the link-candidate inventory for Phase 8.

## ADR-11: Build-process docs kept local and gitignored — SUPERSEDED

**Context.** The repo is public; EXPLAINER/ROADMAP/ADR discuss internal process and tooling detail. **Original decision.** Keep these three files gitignored in `docs/`. **Superseded 2026-07-11:** committed to the repo by explicit choice — the process detail is worth sharing and the docs gain history/backup. **Consequences.** These docs are public; keep anything genuinely private out of them.

## ADR-13: The AI Tutor embeds as a `client:only` island

**Context.** The AI Tutor (`/tutor`) is a full-page, bring-your-own-key Claude chat, not a mid-article sim. Its very first render branches on `localStorage` — a saved API key shows the chat surface, no key shows the key-entry panel — which is client-only state that cannot be known at build time. (ADR-12, landing on the parallel Design Studio branch, is the sibling precedent: the Studio embeds `client:only` because its initial graph comes from the URL's `?d=` share param.) **Decision.** Embed `<Tutor client:only="react" />` with a sized `slot="fallback"` skeleton, the same deliberate exception to the DECISIONS "never client:only" rule (which governs *mid-article* sims that need a zero-JS fallback and no layout shift). The Anthropic SDK is a RULED tutor-only dependency (infrastructure, not a UI library); it is imported only by the tutor island modules and constructed in the browser with `dangerouslyAllowBrowser`. **Consequences.** No SSR/hydration-mismatch class for a key-gated app; an empty chat has no SEO value to pre-render anyway; the fallback skeleton avoids layout shift. `client:only` still emits exactly one `<astro-island>`, so the per-flagship island-count check generalizes to `/tutor/`. The corpus that grounds the tutor is a separate build-time artifact (`/tutor-corpus.json`, an `APIRoute` mirroring `sitemap.xml.ts`) with build assertions, so a content regression fails the build rather than shipping an ungrounded tutor. The BYOK key never leaves the browser except to api.anthropic.com — no server, no logging, no URL-encoding.
