import type { CollectionEntry } from 'astro:content';
import { withBase } from '../../utils/url';

/** One Atlas article, reduced to teachable text for grounding the tutor. */
export interface CorpusTopic {
  id: string;
  title: string;
  category: string;
  summary: string;
  related: string[];
  headings: string[];
  /** True when the topic page carries an interactive simulation. */
  sim: boolean;
  body: string;
}

export interface Corpus {
  version: 1;
  topics: CorpusTopic[];
}

/** Drop top-level ESM import/export lines, but never inside a fenced code block. */
function stripEsmLines(raw: string): string {
  const kept: string[] = [];
  let inFence = false;
  for (const line of raw.split('\n')) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    // Only strip MDX component imports/exports; a JS `import …` inside a code
    // fence is prose to keep.
    if (!inFence && /^(?:import|export)\s/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Reduce a raw MDX body (frontmatter already removed by Astro) to plain
 * teaching prose. Removes ESM import/export lines (outside code fences),
 * `<Diagram>` blocks and their inline SVGs (the bulk of the raw size), any
 * remaining capitalized JSX components (self-closing and paired), and collapses
 * runs of blank lines. Headings, prose, code fences, and tables are preserved.
 */
export function stripMdx(raw: string): string {
  // ESM import/export statement lines (MDX component imports), fence-aware.
  let out = stripEsmLines(raw);
  // `<Diagram …>…</Diagram>` blocks, including the inline SVG they wrap.
  out = out.replace(/<Diagram\b[\s\S]*?<\/Diagram>/g, '');
  // Remaining paired capitalized JSX components: `<Foo …>…</Foo>`.
  out = out.replace(/<([A-Z][A-Za-z0-9]*)\b[^>]*>[\s\S]*?<\/\1>/g, '');
  // Self-closing capitalized JSX components: `<FooSim … />`.
  out = out.replace(/<[A-Z][A-Za-z0-9]*\b[^>]*\/>/g, '');
  // Collapse 3+ blank lines to 2.
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/** Extract ATX headings (`## …` through `###### …`), skipping fenced code. */
export function extractHeadings(raw: string): string[] {
  const headings: string[] = [];
  let inFence = false;
  for (const line of raw.split('\n')) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = line.match(/^#{2,6}\s+(.+?)\s*$/);
    if (match) headings.push(match[1].trim());
  }
  return headings;
}

/** Assemble the deterministic corpus from draft-filtered topic entries (build time). */
export function buildCorpus(entries: CollectionEntry<'topics'>[]): Corpus {
  const topics: CorpusTopic[] = entries
    .map((entry) => {
      const raw = entry.body ?? '';
      return {
        id: entry.id,
        title: entry.data.title,
        category: entry.data.category,
        summary: entry.data.summary,
        related: entry.data.related,
        headings: extractHeadings(raw),
        sim: entry.data.tier === 'flagship',
        body: stripMdx(raw),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return { version: 1, topics };
}

// Fetch the prebuilt corpus once and memoize the promise in module scope, so
// mode switches and re-renders never refetch.
let corpusPromise: Promise<Corpus> | null = null;

/** Lazily fetch the prebuilt corpus JSON (client-side, memoized). */
export function loadCorpus(): Promise<Corpus> {
  if (!corpusPromise) {
    corpusPromise = fetch(withBase('/tutor-corpus.json')).then((res) => {
      if (!res.ok) throw new Error(`Failed to load tutor corpus (${res.status})`);
      return res.json() as Promise<Corpus>;
    });
  }
  return corpusPromise;
}
