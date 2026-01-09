import { Hono } from 'hono';
import {
  cors,
  devOnly,
  errorHandler,
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
  app.onError(errorHandler);

  app.route('/health', healthRoute);

  app.use('/api/auth/*', dbMiddleware());
  app.use('/api/auth/*', authMiddleware());
  app.on(['POST', 'GET'], '/api/auth/*', (c) => {
    const auth = c.get('auth');
    return auth.handler(c.req.raw);
  });

  app.use('/conversations/*', dbMiddleware());
  app.use('/conversations/*', authMiddleware());
  app.use('/conversations/*', sessionMiddleware());
  app.route('/conversations', createConversationsRoutes());

  app.use('/chat/*', dbMiddleware());
  app.use('/chat/*', authMiddleware());
  app.use('/chat/*', sessionMiddleware());
  app.use('/chat/*', openRouterMiddleware());
  app.route('/chat', chatRoute);

  app.use('/guest/*', dbMiddleware());
  app.use('/guest/*', openRouterMiddleware());
  app.route('/guest', createGuestChatRoutes());

  app.route('/models', createModelsRoutes());

  app.use('/billing/*', dbMiddleware());
  app.use('/billing/*', authMiddleware());
  app.use('/billing/*', sessionMiddleware());
  app.use('/billing/*', helcimMiddleware());
  app.route('/billing', createBillingRoutes());

  app.use('/webhooks/*', dbMiddleware());
  app.route('/webhooks', createWebhooksRoutes());

  app.use('/dev/*', devOnly());
  app.use('/dev/*', dbMiddleware());
  app.route('/dev', createDevRoute());

  return app;
}
