# Quick Wins

> Three small, distinctive, low-risk upgrades: shareable sim permalinks, a public "How this Atlas built itself" build-story page, and full-text search.
> Status: backlog · Effort: S (each) · Fits static + no-backend: **yes**

## The ceiling it breaks

Not every ceiling-break is a big build. These three cheap upgrades each remove a specific friction or add a specific hook, and all stay comfortably inside the static architecture. Bundled here because none warrants its own epic.

## A. Shareable sim permalinks

**What:** encode a sim's current parameters in the URL (`?…`) so a configured scenario — "LRU cache under scan pollution," "token bucket at 3× burst" — becomes a linkable, bookmarkable, embeddable artifact others can cite. On load, a sim reads its params from the query string; a "Share" affordance copies the URL.

**How (reuse):** every sim already keeps params in `useState` with typed controls; adding read-from-URL + a share button is small and mechanical. The [Design Studio](01-design-studio.md) already implements exactly this pattern for its graph (`serialize.ts` + `?d=`), so the sims can follow the same convention. Everything via `withBase`.

**Why it matters:** turns sims from ephemeral toys into teaching artifacts — the thing people link in a blog post or a study group. It's the same primitive that makes the Studio shareable.

## B. "How this Atlas built itself" build-story page

**What:** a public page telling the genuinely novel story already written in `docs/EXPLAINER.md` / `docs/ADR.md` — the entire site (30 articles + 12 sims) produced by a parameterized multi-agent workflow with adversarial review, in two days. Write→review chains, the ownership map, the resume/retry-net recovery.

**How (reuse):** the narrative and the numbers already exist in the docs; this is a content page, not a feature. A strong portfolio magnet — the build process is more distinctive than any single article.

**Why it matters:** the dual audience is "learners + people evaluating the author." This page speaks directly to the second, and nothing else on the site tells that story publicly.

## C. Full-text search

**What:** search across all 30 topics (title, summary, body) — the other explicitly-uncommitted "later idea."

**How (reuse):** static-friendly — build a small client-side index (e.g. a prebuilt JSON index searched in-browser, no server, no library required beyond a tiny matcher, or a minimal one if justified). Fits GitHub Pages; the content collection is the source of truth.

**Why it matters:** at 30+ topics the six sidebar lists start to strain; search is the pragmatic navigation counterpart to the [Atlas graph](03-atlas-graph.md).

## Scope / risks

- Each is independently shippable; do them opportunistically.
- Permalinks (A) should share the Studio's encoding convention to avoid two dialects.
- Search (C): decide index size/format; keep the payload small so it doesn't bloat the zero-JS pages (load the index lazily / only on the search route).
