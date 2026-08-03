import { getCollection } from 'astro:content';
import type { CollectionEntry } from 'astro:content';
import { CATEGORY_SLUGS } from '../data/categories';

type Topic = CollectionEntry<'topics'>;

/**
 * Order of topics inside a single category: the `order` frontmatter field first,
 * then title. `order` defaults to 99 in the schema, so ties are expected — the
 * final compare on the (unique) entry id keeps the result a total order, and
 * therefore the build output deterministic.
 */
function compareWithinCategory(a: Topic, b: Topic): number {
  return (
    a.data.order - b.data.order ||
    a.data.title.localeCompare(b.data.title) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Every published (non-draft) topic in the site's reading order: categories in
 * the `CATEGORIES` order used by the sidebar and the landing cards, and topics
 * within each category by `compareWithinCategory`.
 *
 * This is the single definition of "the order of the atlas" — the sidebar and
 * the previous/next footer both read from it so they can never disagree.
 */
export async function getOrderedTopics(): Promise<Topic[]> {
  const topics = await getCollection('topics', ({ data }) => !data.draft);
  return topics.sort(
    (a, b) =>
      CATEGORY_SLUGS.indexOf(a.data.category) - CATEGORY_SLUGS.indexOf(b.data.category) ||
      compareWithinCategory(a, b)
  );
}

/**
 * The topics either side of `id` in the reading order. The sequence spans the
 * whole atlas — the last topic of a category is followed by the first of the
 * next one — and does not wrap: the first topic has no `prev`, the last no
 * `next`.
 */
export async function getTopicNeighbors(
  id: string
): Promise<{ prev?: Topic; next?: Topic }> {
  const ordered = await getOrderedTopics();
  const i = ordered.findIndex((t) => t.id === id);
  if (i === -1) return {};
  return { prev: ordered[i - 1], next: ordered[i + 1] };
}
