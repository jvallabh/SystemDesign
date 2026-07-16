# AI Socratic Tutor / Mock-Interviewer

> An LLM tutor grounded in the 30 articles: ask-anything Q&A plus a "design Twitter" mock-interview mode that grills you and points you to the right sim.
> Status: backlog · Effort: L · Fits static + no-backend: **with caveat** (requires serverless or bring-your-own-key)

## The ceiling it breaks

The Atlas is a monologue — it explains, but it can't answer the follow-up question, can't tell you *why your* design is wrong, and can't simulate the pressure of an interview. An LLM tutor grounded in the existing corpus turns the site from a static reference into a conversation partner, which is the highest-wow, most on-trend upgrade and the one that most directly serves the interview-prep audience.

## What it is

Two modes sharing one grounded chat surface:

1. **Ask-anything Q&A** — the learner asks a question; the tutor answers using the 30 articles as ground truth, citing the specific topic(s) and linking to the relevant sim ("go slide the request rate on the rate-limiter to see this"). Refuses to hallucinate beyond the corpus.
2. **Mock interview** — the tutor poses a design prompt ("Design a URL shortener"), then drives a Socratic back-and-forth: asks for the API, the data model, how you'd scale reads, where you'd cache, what breaks at 10× traffic. It scores the conversation against a rubric drawn from the same `must`-coverage lists that shaped the articles, and points to atlas topics for gaps.

## How it works (reusing what exists)

- **Grounding corpus already exists**: the 30 MDX articles + their summaries + the `related:` graph are a ready-made retrieval source. A build step can emit a JSON/embeddings index of article chunks.
- **Rubric spine already exists**: the per-topic `must` coverage lists from the content-build workflow are a latent interview rubric.
- Uses the latest Claude models via the Anthropic API (see the project's `claude-api` reference before implementing model choice/caching).

## Scope: v1 vs later

**v1:** ask-anything Q&A grounded in the corpus with topic citations; a handful of mock-interview scenarios with rubric-based feedback.
**Later:** voice mode, a saved interview history, difficulty levels, "explain my Studio design" (feed a serialized [Design Studio](01-design-studio.md) graph to the tutor for critique), automated per-topic Q generation feeding the [mastery layer](04-mastery-layer.md).

## Risks / dependencies / open decisions

- **Architecture decision required — this breaks pure-static.** Options, in order of preference:
  1. **Bring-your-own-key** client-side: the learner pastes their own Anthropic API key (stored in `localStorage`), calls the API directly from the browser. Zero backend, zero cost/abuse surface for the site owner; friction for the user.
  2. **Serverless function** (e.g. Cloudflare Worker / Vercel edge) holding the key: smooth UX, but introduces hosting off GitHub Pages, key management, rate-limiting, and an abuse/cost surface on a public site.
- Retrieval quality and citation faithfulness need evaluation; a wrong-but-confident tutor is worse than none.
- Cost model on a public site is the gating concern — resolve #1 vs #2 before building.
