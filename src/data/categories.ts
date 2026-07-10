export interface Category {
  slug: string;
  title: string;
  description: string;
}

/** Display order of the sidebar and landing-page cards. */
export const CATEGORIES: Category[] = [
  {
    slug: 'communication-apis',
    title: 'Communication & APIs',
    description: 'How services talk: API styles, protocols, auth tokens, and push vs pull.',
  },
  {
    slug: 'scalability',
    title: 'Scalability',
    description: 'Handling more load: balancing, limiting, scaling out, and staying up.',
  },
  {
    slug: 'data-storage',
    title: 'Data & Storage',
    description: 'Choosing and structuring databases, splitting data, and keeping it consistent.',
  },
  {
    slug: 'caching',
    title: 'Caching',
    description: 'Serving reads fast: cache strategies, eviction, filters, and edge delivery.',
  },
  {
    slug: 'distributed-systems',
    title: 'Distributed Systems Theory',
    description: 'The fundamentals: trade-off theorems, hashing, coordination, and correctness.',
  },
  {
    slug: 'architecture-patterns',
    title: 'Architecture Patterns',
    description: 'Composing systems: queues, service boundaries, and processing models.',
  },
];

export const CATEGORY_SLUGS = CATEGORIES.map((c) => c.slug);
