# Improvement Ideas — System Design Atlas

> Brainstorm dated 2026-08-03, against `2a56fc6` (Phase 8 polish). Every claim below was
> checked against the working tree or a local `npm run build` (7.9s, 32 pages, 1.7 MB `dist/`).
> Nothing here is committed work — it's a menu. Companion docs: [ROADMAP.md](ROADMAP.md), [ADR.md](ADR.md).

The content project is done: all 30 topics are at full depth, 12 sims ship, Phase 8 polish
landed. What's thin now is everything *around* the content — there is no test suite, no
lint, no CI gate on pull requests, no license, and no reader navigation beyond the sidebar.
The ideas below are grouped by theme and ordered roughly by payoff per hour.

---

## 1. Engineering hygiene — the biggest structural gap

**1.1 CI runs nothing on pull requests.** `.github/workflows/deploy.yml` triggers only on
`push: [main]` and `workflow_dispatch`, and it does exactly one thing: `withastro/action@v3`.
A PR that breaks the build, breaks a link, or breaks types is discovered *after* merge, on
the deploy. Add a `ci.yml` on `pull_request` running `npm ci && npm run check && npm run build`.
Effort: ~20 lines. Impact: high.

**1.2 `npm run check` exists but is never executed anywhere.** `astro check` is in
`package.json` and `tsconfig.json` extends `astro/tsconfigs/strict` — so there's a strict
type gate configured that nothing enforces. Wire it into 1.1.

**1.3 No linter or formatter.** ~7,000 lines of TSX across 13 sims with no style gate. Biome
is the low-friction pick here (one binary, lint + format, no plugin sprawl) over
ESLint + Prettier. Run it in CI as a separate non-blocking job first so the initial
formatting diff doesn't have to land in one commit.

**1.4 No tests, on code that is unusually easy to test.** The sims are built as *pure step
functions over a `useRef` world* (the `SmokeTestSim` pattern) — that architecture was chosen
for reasons unrelated to testing, but it hands you testability for free. The teaching claims
are themselves assertions worth locking down:

- token-bucket refill and the four algorithms in `RateLimitingSim` behave as the article says
- `ConsistentHashingSim` reports a remap fraction near `1/n` when a node joins — the entire
  point of the page
- `BloomFiltersSim`'s false-positive rate tracks `(1 - e^(-kn/m))^k`
- `ShardingSim` hot-shard skew under range vs hash partitioning

Vitest, no DOM needed if the step functions are exported. A dozen tests would prevent the
site from ever teaching something its own simulation contradicts.

**1.5 No internal-link check in the build.** `resources.json` keys fail the build when
unknown (good), and bad `related:` ids log a warning (deliberate — see `TopicLayout.astro`).
But the 110 hand-written `[text](/SystemDesign/topics/…)` prose links across 30 MDX files are
checked by nothing. ROADMAP records them as "all 30 targets verified resolving in dist" —
a one-time manual pass. Make it a script: walk `dist/**/*.html`, collect internal `href`s,
assert each resolves to a built file. ~40 lines of Node, runs in CI, never rots again.

**1.6 Missing repo furniture.** No `LICENSE` (a public teaching site with original prose
really should have one — consider MIT for `src/components`/`scripts` and CC BY 4.0 for
`src/content`, stated explicitly), no `.nvmrc` or `engines` field (built here on Node 22),
no `dependabot.yml`, no `CONTRIBUTING.md`, no issue/PR templates.

---

## 2. Ship a smaller bundle — one high-leverage change

Measured from `dist/_astro/`:

| Asset | Size |
|---|---|
| `client.*.js` (React runtime) | **184 KB** |
| Each individual sim | 8–12 KB |

The framework is ~20× the payload of the thing it renders, on every flagship page. And the
sims import exactly four React APIs — `useState`, `useEffect`, `useRef`, `useMemo`, plus the
`ReactNode` type. No portals, no Suspense, no context, no third-party React libraries.

Switching to `@astrojs/preact` (or keeping `@astrojs/react` with the `preact/compat` alias if
you want zero source changes) should cut roughly 150 KB from every page carrying a sim.
This is probably the single highest impact-to-risk change available: the migration surface is
four hooks, and `npm run build` plus a hydration smoke check tells you immediately if it worked.

Secondary: `dist/topics/distributed-systems/consistent-hashing/index.html` is **77 KB**,
against 46–53 KB for the next-largest pages and an 8–16 KB target recorded in ROADMAP's Phase 8
notes. It carries 7 inline SVGs (article diagrams plus the sim's SSR markup). Worth
re-measuring what the target actually means now that sims render meaningful static markup
server-side — either the number is stale or that page needs trimming.

---

## 3. Decouple content from the base path

110 links across all 30 MDX files hardcode `/SystemDesign/…`. The code is careful about this
(`withBase()` everywhere in components), but the prose isn't and can't be — MDX links are
plain strings.

Consequence: "Custom domain" sits in ROADMAP's *Later ideas*, and today it is a
110-site find-and-replace across every content file, with no build error if one is missed.

Fix: a remark plugin that rewrites a `topic:` protocol — `[text](topic:caching/cdn)` →
`withBase('/topics/caching/cdn/')` — and *fails the build* on an unknown topic id. That
collapses ideas 1.5 and 3 into one mechanism: links become checked references instead of
strings, and the base path lives in exactly one place. It also makes idea 1.5's dist-walker
redundant for prose links (still useful for component-authored hrefs).

---

## 4. Reader navigation and retention

**4.1 There is no prev/next.** `TopicLayout.astro` renders breadcrumb, article, further
learning, and related chips — but nothing to advance to the next topic. On a 30-topic site
with a defined `order` per category, a reader who finishes a page has to go back to the
sidebar every single time. Cheapest meaningful UX win on the list.

**4.2 Search.** Listed in ROADMAP's *Later ideas*, and Pagefind makes it near-free for a
static Astro build: index `dist/` as a post-build step, drop in the UI component, no server,
no API key, works on GitHub Pages.

**4.3 Guided paths.** Also in *Later ideas*, and it pairs naturally with 4.1: define one or
two orderings across categories ("interview prep", "start from zero"), render them as their
own entry pages, and let prev/next follow the active path.

**4.4 Progress tracking.** localStorage-marked read state, a checkmark in the sidebar, a
"3 of 30" ring on the landing page. Purely client-side, fits the static-hosting constraint.

**4.5 Active recall.** Two or three self-check questions per topic, collapsed by default.
The site currently teaches well but tests nothing — and its stated audience (interview prep)
is exactly the audience that needs recall practice over re-reading.

**4.6 Capstone "design a system" pages.** URL shortener, news feed, chat, rate-limited API —
the walkthroughs readers actually arrive searching for. Each is a natural hub linking back
into eight or ten atlas topics, which turns the existing 30 pages into a graph with a purpose
rather than a flat list. This is the highest-ceiling *content* idea here, and the most work.

---

## 5. Simulation quality

**5.1 Seed the randomness.** Five sims call `Math.random()` (`LoadBalancingSim` 5×,
`ScalingSim` 5×, `PollingWebSocketsSim` 4×, `CapTheoremSim` 2×, and two others once each).
Consequences: runs aren't reproducible, so a reader can't compare two strategies under
identical traffic; behavior can't be snapshot-tested (blocking idea 1.4); and nothing can be
shared as a permalink. A 6-line `mulberry32` in the sim harness, seeded per reset, fixes all
three. Optional follow-on: encode sim parameters in the URL hash so a specific scenario is
linkable from prose — "here's the ring at 4 nodes with 150 vnodes."

**5.2 Screen readers get nothing from a sim.** Across 13 sims there are 18 `aria-label`s and
one `role` each — essentially the `SimFrame` chrome. The SVG canvas, where all the teaching
happens, is opaque. Two additions cover most of it: `role="img"` with a real `aria-label`
describing current state on the canvas, and an `aria-live="polite"` region echoing the
readout strip so state changes are announced. The readouts already exist as structured
`{label, value}` data in `SimFrame` — this is mostly plumbing, not new content.

**5.3 The light-theme contrast bug is still open.** ROADMAP has flagged
`--accent: #0d9488` at 3.74:1 on white (fails WCAG AA) since Phase 8, with the fix already
identified (`#0f766e` ≈ 4.9:1) and blocked on a "brand-color decision." It's a one-line
change in `theme.css` that currently makes every link and readout in light mode
non-compliant. Either make the call or drop light mode's accent to a neutral — but don't
leave a known accessibility failure parked in a backlog table indefinitely.

---

## 6. Docs are drifting

Five files, 268 lines, overlapping mandates: `DECISIONS.md`, `ADR.md`,
`IMPLEMENTATION-PLAN.md`, `ROADMAP.md`, `EXPLAINER.md`. Two concrete symptoms:

- `IMPLEMENTATION-PLAN.md` is entirely historical — every phase is ✅. It's an archive
  presented as a plan.
- **ROADMAP's backlog contains at least one already-fixed item**: it lists
  "`scroll-behavior: smooth` not gated on reduced-motion" as open, but `global.css:7-11`
  already wraps it in `@media (prefers-reduced-motion: no-preference)`. If one entry is
  stale, readers can't trust the others.

Suggestions: fold `DECISIONS.md` into `ADR.md` (one home for decisions), move
`IMPLEMENTATION-PLAN.md` under `docs/archive/`, and **convert the ROADMAP backlog table into
GitHub issues** — nine tracked items with owners and close-on-merge beats a markdown table
nobody re-verifies. `ROADMAP.md` then shrinks to a link to the issue list plus the
"watch-fors" section, which is genuinely useful and has no other home.

Also worth adding: `npm run new:topic <category>/<slug>` to scaffold the frontmatter,
imports, and diagram stub that README documents as a manual 3-step process.

---

## 7. Distribution and SEO

- **Per-topic OG images.** One shared `og-card.png` today; already noted as nice-to-have.
  Generate at build time with satori + resvg so each share shows the actual topic title.
- **`<lastmod>` in the sitemap**, sourced from git commit dates per file.
- **JSON-LD `TechArticle`** per topic page — cheap structured data, meaningful for a site
  whose entire distribution is search.
- **RSS feed** — trivial in Astro, gives returning readers a reason to subscribe.
- **Custom domain** — see idea 3; do the decoupling first or it's a 110-link migration.
- **Lighthouse in CI** against a preview build (`treosh/lighthouse-ci-action`), replacing the
  ROADMAP's "worth one look" manual pass with a number that regresses visibly.

---

## 8. Content gaps worth filling

From ROADMAP's own watch-fors plus a pass over the topic list:

- **Replication and replica lag** — explicitly noted as having no owning page; currently
  squatting inside `databases.mdx`. Natural flagship (a sim showing read-your-writes breaking
  under lag would be excellent).
- **A Reliability category**: circuit breakers, retries and exponential backoff, timeouts,
  bulkheads. ROADMAP already anticipates the collision with sync-vs-async's "survival kit"
  paragraph, so the landing plan is half-written.
- **Observability** — logs, metrics, traces, SLOs. Conspicuously absent for an
  interview-prep-adjacent atlas.
- **Consensus** (Raft specifically) — `distributed-algorithms.mdx` at 120 lines is the
  shortest page on the site and covers a lot of ground thinly; Raft deserves its own page and
  is one of the best simulation subjects available.
- **Blob/object storage** and **search indexing** — both show up in nearly every capstone
  design (idea 4.6) with nowhere to link.

Note the structural constraint: `index.astro` hardcodes a 6-card stagger and `content.config.ts`
enums the six category slugs, so adding a seventh category touches both (already flagged in
ROADMAP for the stagger).

---

## Suggested first slice

If only a weekend is available, these four compound the most:

1. **`ci.yml` on pull requests** — `npm ci && npm run check && npm run build` (§1.1, §1.2)
2. **Preact swap** — ~150 KB off every sim page, four hooks of migration surface (§2)
3. **Fix `--accent` in light mode** — one line, closes a known AA failure (§5.3)
4. **Prev/next in `TopicLayout`** — the cheapest real improvement to how the site reads (§4.1)

Then the `topic:` link plugin (§3), because it unblocks the custom domain and makes every
prose link a build-checked reference.
