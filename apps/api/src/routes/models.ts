import { Hono } from 'hono';
import { z } from 'zod';
import { modelSchema } from '@hushbox/shared';
import { processModels } from '@hushbox/shared/models';
import type { AppEnv } from '../types.js';

const modelsListResponseSchema = z.object({
  models: z.array(modelSchema),
  premiumModelIds: z.array(z.string()),
});

export const modelsRoute = new Hono<AppEnv>().get('/', async (c) => {
  const rawModels = await c.var.aiClient.listRawModels();
  const { models, premiumIds } = processModels(rawModels);
  const response = modelsListResponseSchema.parse({
    models,
    premiumModelIds: premiumIds,
  });
  return c.json(response, 200);
});
