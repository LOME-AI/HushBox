import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { modelSchema, errorResponseSchema, ERROR_CODE_NOT_FOUND } from '@lome-chat/shared';
import { fetchModels, getModel } from '../services/openrouter/index.js';
import { processModels, transformModel } from '../services/models.js';
import { createErrorResponse } from '../lib/error-response.js';
import { ERROR_MODEL_NOT_FOUND } from '../constants/errors.js';
import type { AppEnv } from '../types.js';

const modelsListResponseSchema = z.object({
  models: z.array(modelSchema),
  premiumModelIds: z.array(z.string()),
});

const errorSchema = errorResponseSchema;

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
    const response = modelsListResponseSchema.parse({
      models,
      premiumModelIds: premiumIds,
    });
    return c.json(response, 200);
  });

  app.openapi(getModelRoute, async (c) => {
    const { modelId } = c.req.valid('param');

    // Decode URL-encoded model ID (e.g., openai%2Fgpt-4-turbo -> openai/gpt-4-turbo)
    const decodedModelId = decodeURIComponent(modelId);

    try {
      const rawModel = await getModel(decodedModelId);
      const model = transformModel(rawModel);
      const response = modelSchema.parse(model);
      return c.json(response, 200);
    } catch {
      return c.json(createErrorResponse(ERROR_MODEL_NOT_FOUND, ERROR_CODE_NOT_FOUND), 404);
    }
  });

  return app;
}
