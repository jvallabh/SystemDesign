/**
 * Atlas Graph — pure graph construction from topic frontmatter.
 *
 * Turns the topics collection (`related:` frontmatter) into an undirected
 * concept map: nodes are topics coloured by category, edges are the union of
 * the directed `related` references, deduped via a sorted-pair invariant.
 *
 * No Astro imports: this runs in the page frontmatter but stays a plain,
 * unit-testable function of its input. Build-time assertions throw so a bad
 * `related` ref (typo, dangling link) or a degenerate graph fails the build.
 */

export interface AtlasNode {
  id: string;
  title: string;
  category: string;
  tier: 'flagship' | 'written';
  degree: number;
}

/** Undirected edge; invariant: `source < target` lexicographically. */
export interface AtlasEdge {
  source: string;
  target: string;
}

export interface AtlasGraph {
  nodes: AtlasNode[];
  edges: AtlasEdge[];
}

interface TopicEntry {
  id: string;
  title: string;
  category: string;
  tier: string;
  related: string[];
}

export function buildGraph(entries: TopicEntry[]): AtlasGraph {
  const ids = new Set(entries.map((e) => e.id));

  // Symmetrize: union A→B and B→A, dedupe on the sorted pair.
  const seen = new Set<string>();
  const edges: AtlasEdge[] = [];
  for (const e of entries) {
    for (const ref of e.related) {
      if (!ids.has(ref)) {
        throw new Error(
          `Atlas graph: topic "${e.id}" relates to "${ref}", which is not a known topic.`,
        );
      }
      if (ref === e.id) {
        throw new Error(`Atlas graph: topic "${e.id}" has a self-edge in its related list.`);
      }
      const [source, target] = e.id < ref ? [e.id, ref] : [ref, e.id];
      const key = `${source} ${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source, target });
    }
  }

  const degree = new Map<string, number>(entries.map((e) => [e.id, 0]));
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const nodes: AtlasNode[] = entries.map((e) => ({
    id: e.id,
    title: e.title,
    category: e.category,
    tier: e.tier === 'flagship' ? 'flagship' : 'written',
    degree: degree.get(e.id) ?? 0,
  }));

  // Deterministic order so the SSR render is byte-stable regardless of how the
  // collection was enumerated.
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  edges.sort((a, b) =>
    a.source < b.source
      ? -1
      : a.source > b.source
        ? 1
        : a.target < b.target
          ? -1
          : a.target > b.target
            ? 1
            : 0,
  );

  // Build-time invariants — throwing here fails `astro build`.
  if (nodes.length < 30) {
    throw new Error(`Atlas graph: expected ≥30 nodes, got ${nodes.length}.`);
  }
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      throw new Error(`Atlas graph: edge endpoint does not resolve (${edge.source} — ${edge.target}).`);
    }
    if (edge.source === edge.target) {
      throw new Error(`Atlas graph: self-edge on "${edge.source}".`);
    }
  }
  for (const node of nodes) {
    if (node.degree < 1) {
      throw new Error(`Atlas graph: topic "${node.id}" has no related links (degree 0).`);
    }
  }

  return { nodes, edges };
}
