import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { fetchModels, getModel } from '../services/openrouter/index.js';
import type { AppEnv } from '../types.js';

const modelInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  context_length: z.number(),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
  }),
  supported_parameters: z.array(z.string()),
});

const errorSchema = z.object({
  error: z.string(),
});

const listModelsRoute = createRoute({
  method: 'get',
  path: '/',
  responses: {
    200: {
      content: { 'application/json': { schema: z.array(modelInfoSchema) } },
      description: 'List of available AI models',
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
      content: { 'application/json': { schema: modelInfoSchema } },
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
    const models = await fetchModels();
    return c.json(models, 200);
  });

  app.openapi(getModelRoute, async (c) => {
    const { modelId } = c.req.valid('param');

    // Decode URL-encoded model ID (e.g., openai%2Fgpt-4-turbo -> openai/gpt-4-turbo)
    const decodedModelId = decodeURIComponent(modelId);

    try {
      const model = await getModel(decodedModelId);
      return c.json(model, 200);
    } catch {
      return c.json({ error: 'Model not found' }, 404);
    }
  });

  return app;
}

export const modelsRoute = createModelsRoutes();
