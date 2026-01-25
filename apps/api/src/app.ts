import { Hono } from 'hono';
import {
  cors,
  devOnly,
  errorHandler,
  envMiddleware,
  dbMiddleware,
  authMiddleware,
  sessionMiddleware,
  openRouterMiddleware,
  helcimMiddleware,
} from './middleware/index.js';
import {
  healthRoute,
  chatRoute,
  createDevRoute,
  createConversationsRoutes,
  createGuestChatRoutes,
  createModelsRoutes,
  createBillingRoutes,
  createWebhooksRoutes,
} from './routes/index.js';
import type { AppEnv } from './types.js';

export type { Bindings } from './types.js';

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', cors());
  app.use('*', envMiddleware());
  app.onError(errorHandler);

  app.route('/api/health', healthRoute);

  app.use('/api/auth/*', dbMiddleware());
  app.use('/api/auth/*', authMiddleware());
  app.on(['POST', 'GET'], '/api/auth/*', (c) => {
    const auth = c.get('auth');
    return auth.handler(c.req.raw);
  });

  app.use('/api/conversations/*', dbMiddleware());
  app.use('/api/conversations/*', authMiddleware());
  app.use('/api/conversations/*', sessionMiddleware());
  app.route('/api/conversations', createConversationsRoutes());

  app.use('/api/chat/*', dbMiddleware());
  app.use('/api/chat/*', authMiddleware());
  app.use('/api/chat/*', sessionMiddleware());
  app.use('/api/chat/*', openRouterMiddleware());
  app.route('/api/chat', chatRoute);

  app.use('/api/guest/*', dbMiddleware());
  app.use('/api/guest/*', openRouterMiddleware());
  app.route('/api/guest', createGuestChatRoutes());

  app.route('/api/models', createModelsRoutes());

  app.use('/api/billing/*', dbMiddleware());
  app.use('/api/billing/*', authMiddleware());
  app.use('/api/billing/*', sessionMiddleware());
  app.use('/api/billing/*', helcimMiddleware());
  app.route('/api/billing', createBillingRoutes());

  app.use('/api/webhooks/*', dbMiddleware());
  app.route('/api/webhooks', createWebhooksRoutes());

  app.use('/api/dev/*', devOnly());
  app.use('/api/dev/*', dbMiddleware());
  app.route('/api/dev', createDevRoute());

  return app;
}
