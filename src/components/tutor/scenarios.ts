/** A canned mock-interview scenario grounded in a handful of Atlas topics. */
export interface Scenario {
  id: string;
  title: string;
  /** Injected verbatim as the interviewer's first message (no API call). */
  opening: string;
  /** 3–5 topic ids whose bodies are inlined into the interview system prompt. */
  topicIds: string[];
  /** 6–10 gradeable criteria, each citing a scenario topic as [[id]]. */
  rubric: string[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'url-shortener',
    title: 'URL shortener',
    opening:
      "Let's design a URL shortener — think Bitly or TinyURL. A user hands us a long URL and we return a short link like sd.at/aX9f2; anyone who visits that short link gets redirected to the original. Assume it's heavily read-dominated: far more people click short links than create them. Where would you like to start — the API, the data model, or how we generate the short codes?",
    topicIds: [
      'data-storage/sql-vs-nosql',
      'caching/caching-strategies',
      'data-storage/sharding-and-partitioning',
      'distributed-systems/consistent-hashing',
    ],
    rubric: [
      'Identifies the workload as heavily read-dominated and sizes reads against writes before designing storage [[caching/caching-strategies]]',
      'Picks a datastore suited to a simple key→URL lookup and argues the key-value vs relational trade-off [[data-storage/sql-vs-nosql]]',
      'Designs a short-code generation scheme (base62 counter, hash, or random) and handles collisions and code length [[data-storage/sql-vs-nosql]]',
      'Caches hot short codes and can explain cache-aside plus an eviction policy for the long tail [[caching/caching-strategies]]',
      'Partitions the mapping table once it outgrows one node and chooses a sharding key/strategy [[data-storage/sharding-and-partitioning]]',
      'Explains how consistent hashing limits key remapping when nodes are added or removed [[distributed-systems/consistent-hashing]]',
      'Reasons about hotspots — a viral link — and how caching or sharding absorbs the spike [[data-storage/sharding-and-partitioning]]',
    ],
  },
  {
    id: 'rate-limiter',
    title: 'Distributed rate limiter',
    opening:
      "Let's design a distributed rate limiter. It sits in front of our API and enforces limits like '100 requests per minute per API key' across a whole fleet of servers, not just one machine. When a client goes over, we reject with 429. Start wherever you like — for example, which algorithm would you use to decide whether a given request is allowed?",
    topicIds: [
      'scalability/rate-limiting',
      'caching/caching-strategies',
      'scalability/stateful-vs-stateless',
      'distributed-systems/consistent-hashing',
    ],
    rubric: [
      'Picks a concrete algorithm (token bucket, leaky bucket, or sliding window) and states its trade-offs [[scalability/rate-limiting]]',
      'Defines the limit key (per user / IP / API key) and the window semantics clearly [[scalability/rate-limiting]]',
      'Stores counters in a fast shared store rather than per-node local memory, and justifies why [[caching/caching-strategies]]',
      'Keeps the limiter nodes stateless so any node can serve any request [[scalability/stateful-vs-stateless]]',
      'Makes the counter read-modify-write atomic to avoid races across concurrent requests [[scalability/rate-limiting]]',
      'Distributes counter state across nodes and explains how consistent hashing routes a key to its shard [[distributed-systems/consistent-hashing]]',
      'Handles the store being unavailable (fail-open vs fail-closed) and burst behavior at window boundaries [[scalability/rate-limiting]]',
    ],
  },
  {
    id: 'news-feed',
    title: 'News feed',
    opening:
      "Let's design the home timeline for a social app — the feed of recent posts from everyone a user follows, newest first, like Twitter/X or Instagram. Assume millions of users, and some accounts have millions of followers. Where would you start — the data model, or how we assemble a user's feed when they open the app?",
    topicIds: [
      'data-storage/sql-vs-nosql',
      'caching/caching-strategies',
      'architecture-patterns/message-queues',
      'data-storage/sharding-and-partitioning',
      'architecture-patterns/sync-vs-async',
    ],
    rubric: [
      'Models users, posts, and the follow relationship and picks suitable stores for each [[data-storage/sql-vs-nosql]]',
      'Decides between fan-out-on-write (push) and fan-out-on-read (pull) and defends the choice [[architecture-patterns/sync-vs-async]]',
      'Does the fan-out asynchronously off the write path so posting stays fast [[architecture-patterns/sync-vs-async]]',
      'Uses a message queue to absorb and distribute fan-out work to consumers, decoupling producers [[architecture-patterns/message-queues]]',
      'Caches the materialized timeline and can explain freshness and eviction for the feed cache [[caching/caching-strategies]]',
      'Shards feed and post storage by user and reasons about hot partitions from high-follower accounts [[data-storage/sharding-and-partitioning]]',
      'Treats a celebrity’s huge fan-out as a special case (a hybrid push/pull approach) [[architecture-patterns/sync-vs-async]]',
      'Reasons about queue backpressure or consumer lag when the system is overloaded [[architecture-patterns/message-queues]]',
    ],
  },
];
