import { Hono } from 'hono';
import { z } from 'zod';
import { modelSchema } from '@hushbox/shared';
import { fetchModels, fetchZdrModelIds } from '../services/openrouter/index.js';
import { processModels } from '../services/models.js';
import type { AppEnv } from '../types.js';

const modelsListResponseSchema = z.object({
  models: z.array(modelSchema),
  premiumModelIds: z.array(z.string()),
});

export const modelsRoute = new Hono<AppEnv>().get('/', async (c) => {
  const [rawModels, zdrModelIds] = await Promise.all([fetchModels(), fetchZdrModelIds()]);
  const { models, premiumIds } = processModels(rawModels, zdrModelIds);
  const response = modelsListResponseSchema.parse({
    models,
    premiumModelIds: premiumIds,
  });
  return c.json(response, 200);
});
