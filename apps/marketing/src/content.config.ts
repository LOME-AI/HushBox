import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/blog' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string().max(160),
      author: z.string(),
      date: z.date(),
      tags: z.array(z.string()),
      image: image().optional(),
      draft: z.boolean().default(false),
    }),
});

export const collections = { blog };
