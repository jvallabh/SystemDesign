# Design Decisions — System Design Atlas

Agreed during the planning session on 2026-07-10. Each entry lists the options considered; the **pick** is bolded.

## 1. Purpose / audience
- Personal learning notes — incremental, opinionated, lowest scope risk
- Public teaching resource — higher content quality bar, original diagrams, attribution care
- Portfolio piece — polish and interaction skill as the primary goal
- **Pick: Public teaching resource + portfolio piece** — content quality and visual polish both matter

## 2. Scope model (~30 topics)
- **Tiered: flagship topics with full interactive treatment; the rest get quality written pages with static diagrams + resource links, upgraded over time** ✅
- All topics at uniform depth — consistent but shallow-or-slow
- Start tiny: 3–4 topic vertical slice first

## 3. Stack
- **Astro + React islands + MDX — content pages in MDX, interactive diagrams as React components hydrated per-island; fast, SEO-friendly, static hosting** ✅
- Next.js (App Router) + MDX — more mainstream portfolio signal, heavier than needed
- Vite + React SPA — simplest, but weak SEO and manual content plumbing

## 4. Interactivity style for flagship topics
- **Simulations with controls — live parameterized visualizations (add/remove ring nodes, slide request rate, toggle eviction policies)** ✅
- Step-through animated explainers — guided next/prev scenario walkthroughs
- Mix: sims for dynamic topics, step-through for flow-oriented ones

## 5. Flagship topic set
- Sim-friendly core 8: Load Balancing, Consistent Hashing, Caching Strategies + Eviction, Rate Limiting, CAP Theorem, Bloom Filters, Sharding & Partitioning, Message Queues
- Interview-prep weighted: swap in SQL vs NoSQL + Scaling
- API/communication weighted: swap in Long Polling vs WebSockets + REST/gRPC/GraphQL comparison
- **Pick: union of all three — 12 flagships**: core 8 plus SQL vs NoSQL, Scaling, Long Polling vs WebSockets, REST/gRPC/GraphQL/tRPC

## 6. Resource links & content sourcing
- **Resolve lnkd.in shortlinks to canonical URLs (`scripts/resolve-links.mjs` → `src/data/resources.json`, checked in — builds never touch the network); link in a "Further learning" section per topic; all explanatory content written original** ✅
- Resolve links and base page content on them — derivative-content risk
- Keep lnkd.in links as-is — zero effort, opaque/rot-prone

Note: the source list's CDC, Caching, Caching Strategies, Cache Eviction Policies, and CDN links resolved to YouTube *search queries*, not actual videos — substitute hand-picked resources during those content waves.

## 7. Navigation / structure
- **Thematic categories (6 sections: Communication & APIs, Scalability, Data & Storage, Caching, Distributed Systems Theory, Architecture Patterns) with sidebar nav + landing page category cards** ✅
- Learning path — one linear beginner→advanced curriculum
- Flat searchable grid — 30 cards + filter

## 8. Visual design
- **Dark-first, technical, animated — light-mode toggle, monospace accents, glowing SVG diagrams, subtle motion. All SVGs theme-aware via CSS classes/currentColor, never hardcoded hex** ✅
- Clean light editorial — Stripe-docs / textbook feel
- Playful illustrated — bright, cartoon-style, beginner-friendly

## 9. Deployment
- **GitHub Pages via GitHub Actions — build Astro and publish on push to main; base path `/SystemDesign`** ✅
- Vercel — nicer URLs and preview deploys, needs dashboard setup
- Local only for now

## 10. Build sequence
- **Skeleton first, then topics in waves — M1: full site shell (layout, theme, nav, all 30 stub pages, deploy pipeline live); M2+: fill topics in category-sized waves** ✅
- Flagships first — all 12 sims before written-tier pages
- Everything in one continuous build

## 11. Site name
- **"System Design Atlas"** ✅
- "System Design Playground"
- Plain "System Design"

## Implementation conventions

- **No animation libraries.** Sims are SVG + CSS + requestAnimationFrame; tiny bundles are part of the portfolio point.
- **SVG theming:** presentation attributes cannot use `var()` (`fill="var(--accent)"` silently renders black). Static colors use the utility classes at the bottom of `src/styles/global.css` (`.f-*` fills, `.s-*` strokes, `.svg-label` text) — `className` in `.tsx`, `class` in `.mdx`. Dynamic colors in sims use style objects: `style={{ fill: 'var(--ok)' }}`. `fill="none"` and `fill="currentColor"` are fine as attributes. Never hardcoded hex/named colors.
- **Sim pattern:** pure module-level step function (testable) + world state in `useRef` + params in `useState` + `useRafLoop` (dt clamped, pauses when hidden, cancels on unmount) + `SimFrame` chrome. See `src/components/sims/SmokeTestSim.tsx` for the reference implementation.
- **Hydration:** `client:visible` for all sims (they sit mid-article). Never `client:only`.
- **Base path:** every internal link/asset goes through `withBase()` (`src/utils/url.ts`). Astro does not rewrite hand-written hrefs.
- **Astro v5 content API:** `src/content.config.ts` + `glob` loader; render with `render(entry)` from `astro:content`; `entry.id` drives route params.
