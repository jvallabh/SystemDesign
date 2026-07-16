import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { buildCorpus } from '../components/tutor/corpus';

export const prerender = true;

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
    if (t.body.includes('\nimport ') || t.body.includes('<Diagram')) {
      throw new Error(`tutor-corpus: ${t.id} body contains unstripped MDX`);
    }
  }

  return new Response(JSON.stringify(corpus), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
