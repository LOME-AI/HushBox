import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { modelSchema } from '@lome-chat/shared';
import { fetchModels, getModel } from '../services/openrouter/index.js';
import { processModels, transformModel } from '../services/models.js';
import type { AppEnv } from '../types.js';

const modelsListResponseSchema = z.object({
  models: z.array(modelSchema),
  premiumModelIds: z.array(z.string()),
});

const errorSchema = z.object({
  error: z.string(),
});

const listModelsRoute = createRoute({
  method: 'get',
  path: '/',
  responses: {
    200: {
      content: { 'application/json': { schema: modelsListResponseSchema } },
      description: 'List of available AI models with premium classification',
    },
  },
});

const getModelRoute = createRoute({
  method: 'get',
  path: '/{modelId}',
  request: {
    params: z.object({
      modelId: z.string().openapi({ description: 'Model ID (URL-encoded if contains slashes)' }),
    }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: modelSchema } },
      description: 'Model details',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Model not found',
    },
  },
});

export function createModelsRoutes(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(listModelsRoute, async (c) => {
    const rawModels = await fetchModels();
    const { models, premiumIds } = processModels(rawModels);
    return c.json(
      {
        models,
        premiumModelIds: premiumIds,
      },
      200
    );
  });

  app.openapi(getModelRoute, async (c) => {
    const { modelId } = c.req.valid('param');

    // Decode URL-encoded model ID (e.g., openai%2Fgpt-4-turbo -> openai/gpt-4-turbo)
    const decodedModelId = decodeURIComponent(modelId);

    try {
      const rawModel = await getModel(decodedModelId);
      const model = transformModel(rawModel);
      return c.json(model, 200);
    } catch {
      return c.json({ error: 'Model not found' }, 404);
    }
  });

  return app;
}

export const modelsRoute = createModelsRoutes();
