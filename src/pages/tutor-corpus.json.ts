import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { buildCorpus } from '../components/tutor/corpus';

export const prerender = true;

/**
 * True if a stripped body still contains MDX that should have been removed:
 * a `<Diagram>` block, a raw inline `<svg>`, or a top-level ESM import/export.
 * The import check is fence-aware so a legitimate `import …` inside a code
 * fence (kept as prose) does not trip it.
 */
function hasMdxLeak(body: string): boolean {
  if (body.includes('<Diagram') || /<svg\b/.test(body)) return true;
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^(?:import|export)\s/.test(line)) return true;
  }
  return false;
}

export const GET: APIRoute = async () => {
  const entries = await getCollection('topics', ({ data }) => !data.draft);
  const corpus = buildCorpus(entries);

  // Build-time assertions — throwing here fails the build, so a corpus
  // regression (missing topics, dangling related edge, unstripped MDX, or an
  // article that reduced to nothing) can never ship.
  const ids = new Set(corpus.topics.map((t) => t.id));
  if (corpus.topics.length < 30) {
    throw new Error(`tutor-corpus: expected >= 30 topics, got ${corpus.topics.length}`);
  }
  for (const t of corpus.topics) {
    for (const related of t.related) {
      if (!ids.has(related)) {
        throw new Error(`tutor-corpus: ${t.id} related id "${related}" does not resolve`);
      }
    }
    if (t.body.length <= 500) {
      throw new Error(`tutor-corpus: ${t.id} body too short (${t.body.length} chars)`);
    }
    if (hasMdxLeak(t.body)) {
      throw new Error(`tutor-corpus: ${t.id} body contains unstripped MDX`);
    }
  }

  return new Response(JSON.stringify(corpus), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
