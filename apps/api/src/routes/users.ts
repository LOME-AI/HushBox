import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { ERROR_CODE_UNAUTHORIZED } from '@hushbox/shared';
import type { AppEnv } from '../types.js';
import { searchUsers } from '../services/users/user-search.js';
import { createErrorResponse } from '../lib/error-response.js';

export const usersRoute = new Hono<AppEnv>().post(
  '/search',
  zValidator(
    'json',
    z.object({
      query: z.string().min(1).max(50),
      excludeConversationId: z.string().optional(),
      limit: z.number().int().min(1).max(20).optional(),
    })
  ),
  async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
    }

    const db = c.get('db');
    const { query, excludeConversationId, limit } = c.req.valid('json');

    const results = await searchUsers(db, query, user.id, {
      ...(excludeConversationId !== undefined && { excludeConversationId }),
      ...(limit !== undefined && { limit }),
    });

    return c.json({ users: results }, 200);
  }
);
