# "Design X" Case Studies

> Guided end-to-end designs (TinyURL, Twitter feed, chat) that stitch primitives into whole systems, with pre-configured sims embedded at each step.
> Status: backlog · Effort: M · Fits static + no-backend: **yes**

## The ceiling it breaks

The Atlas teaches primitives beautifully but never composes them. Interviews don't ask "explain consistent hashing" — they ask "design Twitter," and the skill is assembling the primitives into a coherent whole while reasoning about trade-offs. There's a gap between "I understand caching" and "I know where caching goes in a news-feed design." Case studies are the bridge, and they're the concrete form of the uncommitted "interview-prep path."

## What it is

A handful of narrative, end-to-end design walkthroughs — each a guided path from requirements → API → data model → scaling → bottlenecks → trade-offs. Every step links the primitive article it draws on and, where useful, embeds the relevant sim *pre-configured for that scenario* (e.g. the caching sim tuned to the feed's read/write ratio). Starter set: **TinyURL** (hashing, storage, read-heavy caching), **Twitter home feed** (fan-out-on-write vs read, caching, queues), **a chat system** (WebSockets, presence, message queues), **a rate limiter service** (the four algorithms in context).

## How it works (reusing what exists)

- **Content model fits as-is**: each case study is an MDX page (possibly a new `case-studies` collection or category) using the same `Diagram` component, theme-aware SVGs, and prose conventions.
- **Cross-linking machinery exists**: the `[text](/SystemDesign/topics/<cat>/<slug>/)` inline-link format and `related:` chips already connect topics; case studies lean on them heavily.
- **Sims are already embeddable and parameterizable**: they're React islands dropped into MDX via `client:visible`. Pre-configuring one for a scenario means passing initial params — a small, additive prop change per sim.
- **Bridges to the [Design Studio](01-design-studio.md)**: each case study's reference architecture maps directly onto Studio presets — "read about the Twitter feed design, then go build it yourself." The Studio's preset format is the shared artifact.

## Scope: v1 vs later

**v1:** 2–3 case studies (TinyURL + Twitter feed) as guided MDX pages with linked primitives and at least one embedded, scenario-tuned sim each.
**Later:** the full starter set, a "requirements → your design" interactive worksheet, a matching Studio preset per case study, integration with the [mastery layer](04-mastery-layer.md) (quiz after each case study), and a suggested ordering ("interview crash course" path).

## Risks / dependencies / open decisions

- **Scope of each study:** real designs are deep; keep each to interview-appropriate depth, not a distributed-systems textbook chapter (reuse the "stay in your lane / owns-adjacent" discipline so they don't re-teach primitive articles).
- Requires sims to accept initial-param props — verify each target sim's `initWorld` can seed from props without breaking SSR determinism.
- Decide taxonomy: new content collection vs a seventh category vs a standalone section.
