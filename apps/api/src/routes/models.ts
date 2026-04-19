import { Hono } from 'hono';
import { z } from 'zod';
import { modelSchema } from '@hushbox/shared';
import { fetchModels, processModels } from '@hushbox/shared/models';
import type { AppEnv } from '../types.js';

const modelsListResponseSchema = z.object({
  models: z.array(modelSchema),
  premiumModelIds: z.array(z.string()),
});

export const modelsRoute = new Hono<AppEnv>().get('/', async (c) => {
  const apiKey = c.env.AI_GATEWAY_API_KEY;
  if (!apiKey) throw new Error('AI_GATEWAY_API_KEY required for /models');
  const publicModelsUrl = c.env.PUBLIC_MODELS_URL;
  if (!publicModelsUrl) throw new Error('PUBLIC_MODELS_URL required for /models');
  const rawModels = await fetchModels({ apiKey, publicModelsUrl });
  const { models, premiumIds } = processModels(rawModels);
  const response = modelsListResponseSchema.parse({
    models,
    premiumModelIds: premiumIds,
  });
  return c.json(response, 200);
});
