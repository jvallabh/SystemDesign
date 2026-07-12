import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const topics = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/topics' }),
  schema: z
    .object({
      title: z.string(),
      category: z.enum([
        'communication-apis',
        'scalability',
        'data-storage',
        'caching',
        'distributed-systems',
        'architecture-patterns',
      ]),
      tier: z.enum(['flagship', 'written']),
      summary: z.string(),
      order: z.number().default(99),
      resources: z.array(z.string()).default([]),
      related: z.array(z.string()).default([]),
      sim: z.string().optional(),
      draft: z.boolean().default(false),
    })
    .refine((d) => d.tier !== 'flagship' || !!d.sim, {
      message: 'flagship topics must declare a sim component',
    }),
});

export const collections = { topics };
