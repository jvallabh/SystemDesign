# Mastery Layer

> Active-recall quizzes, predict-the-sim challenges, spaced-repetition flashcards, and localStorage progress — turning passive reading into tested understanding.
> Status: backlog · Effort: M · Fits static + no-backend: **yes**

## The ceiling it breaks

The site teaches but never checks. A learner can read all 30 articles and still not know what they *don't* know — and active recall, not re-reading, is what actually moves knowledge into long-term memory. This is the single biggest learning-outcome upgrade for the interview-prep audience, and it's entirely client-side (no backend), reusing content structure that already exists.

## What it is

Three complementary assessment surfaces, plus lightweight progress tracking:

1. **Per-topic quizzes** — a few misconception-targeted multiple-choice questions at the end of each article ("Which eviction policy survives a scan burst?"), with explanations that link back into the prose.
2. **Predict-the-sim challenges** — before a sim runs, ask the learner to predict the outcome ("At 90% hit ratio, what happens to average latency vs 99%?"), then reveal by running the sim. This is a uniquely strong move because the sims are already built to make one specific behavior visible.
3. **Spaced-repetition flashcards** — for the dense, memorizable facts (latency numbers, the when-to-use tables, CAP trade-offs). A simple SM-2-style scheduler in `localStorage`.

Progress (topics read, quizzes passed, cards due) persists in `localStorage` and can surface as a mastery map — feeding the [Atlas graph](03-atlas-graph.md) overlay.

## How it works (reusing what exists)

- **Question spine already exists**: the per-topic `must` coverage lists from the content-build workflow are effectively a bank of "things you should be able to answer" — the natural seed for quiz questions.
- **Sims are already predict-then-reveal-ready**: each sim's spec names the "behavior to make visible," which is exactly the answer to a prediction prompt. A `predict` prop or a small wrapper around `SimFrame` gates the run behind a guess.
- **Content model extends cleanly**: quiz questions can live in topic frontmatter or a sibling data file, validated by the same Zod-schema discipline in `content.config.ts`.
- All client-side: `localStorage` for progress, no accounts, no backend — matches the static architecture exactly.

## Scope: v1 vs later

**v1:** end-of-article MCQs for the flagship topics, `localStorage` progress (read/passed), and one predict-the-sim wrapper wired into 2–3 flagship sims.
**Later:** full spaced-repetition flashcard deck with scheduler, quizzes for all 30 topics, a mastery dashboard, streaks, export/import progress, difficulty adaptivity, auto-generated questions (see [AI tutor](02-ai-tutor.md)).

## Risks / dependencies / open decisions

- **Authoring load:** good MCQs are hand-crafted; misconception distractors are the hard part. Start with flagships; consider AI-assisted drafting (reviewed by hand).
- **Question storage format** (frontmatter vs data file) — decide before authoring at scale.
- No cross-device sync without accounts (accepted for v1; `localStorage` only).
