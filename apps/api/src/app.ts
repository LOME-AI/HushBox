import { Hono } from 'hono';
import {
  cors,
  devOnly,
  errorHandler,
  envMiddleware,
  dbMiddleware,
  redisMiddleware,
  sessionMiddleware,
  openRouterMiddleware,
  helcimMiddleware,
  ironSessionMiddleware,
  csrfProtection,
  securityHeaders,
} from './middleware/index.js';
import {
  healthRoute,
  chatRoute,
  devRoute,
  conversationsRoute,
  keysRoute,
  membersRoute,
  linksRoute,
  linkGuestRoute,
  messageSharesRoute,
  publicSharesRoute,
  trialChatRoute,
  modelsRoute,
  billingRoute,
  webhooksRoute,
  opaqueAuthRoute,
  websocketRoute,
  budgetsRoute,
  usersRoute,
} from './routes/index.js';
import type { AppEnv } from './types.js';

export type { Bindings } from './types.js';

export function createApp() {
  const base = new Hono<AppEnv>();

  // Global middleware
  base.use('*', cors());
  base.use('*', securityHeaders());
  base.use('*', envMiddleware());
  base.onError(errorHandler);

  // Per-route middleware (all on base, before chaining)
  base.use('/api/auth/*', csrfProtection());
  base.use('/api/auth/*', dbMiddleware());
  base.use('/api/auth/*', redisMiddleware());
  base.use('/api/auth/*', ironSessionMiddleware());

  base.use('/api/conversations/*', csrfProtection());
  base.use('/api/conversations/*', dbMiddleware());
  base.use('/api/conversations/*', redisMiddleware());
  base.use('/api/conversations/*', ironSessionMiddleware());
  base.use('/api/conversations/*', sessionMiddleware());

  base.use('/api/members/*', csrfProtection());
  base.use('/api/members/*', dbMiddleware());
  base.use('/api/members/*', redisMiddleware());
  base.use('/api/members/*', ironSessionMiddleware());
  base.use('/api/members/*', sessionMiddleware());

  base.use('/api/links/*', csrfProtection());
  base.use('/api/links/*', dbMiddleware());
  base.use('/api/links/*', redisMiddleware());
  base.use('/api/links/*', ironSessionMiddleware());
  base.use('/api/links/*', sessionMiddleware());

  base.use('/api/budgets/*', csrfProtection());
  base.use('/api/budgets/*', dbMiddleware());
  base.use('/api/budgets/*', redisMiddleware());
  base.use('/api/budgets/*', ironSessionMiddleware());
  base.use('/api/budgets/*', sessionMiddleware());

  base.use('/api/link-guest/*', dbMiddleware());

  base.use('/api/shares/*', dbMiddleware());

  base.use('/api/messages/*', csrfProtection());
  base.use('/api/messages/*', dbMiddleware());
  base.use('/api/messages/*', redisMiddleware());
  base.use('/api/messages/*', ironSessionMiddleware());
  base.use('/api/messages/*', sessionMiddleware());

  base.use('/api/keys/*', csrfProtection());
  base.use('/api/keys/*', dbMiddleware());
  base.use('/api/keys/*', redisMiddleware());
  base.use('/api/keys/*', ironSessionMiddleware());
  base.use('/api/keys/*', sessionMiddleware());

  base.use('/api/chat/*', csrfProtection());
  base.use('/api/chat/*', dbMiddleware());
  base.use('/api/chat/*', redisMiddleware());
  base.use('/api/chat/*', ironSessionMiddleware());
  base.use('/api/chat/*', sessionMiddleware());
  base.use('/api/chat/*', openRouterMiddleware());

  base.use('/api/trial/*', csrfProtection());
  base.use('/api/trial/*', dbMiddleware());
  base.use('/api/trial/*', redisMiddleware());
  base.use('/api/trial/*', openRouterMiddleware());

  base.use('/api/models/*', csrfProtection());

  base.use('/api/billing/*', csrfProtection());
  base.use('/api/billing/*', dbMiddleware());
  base.use('/api/billing/*', redisMiddleware());
  base.use('/api/billing/*', ironSessionMiddleware());
  base.use('/api/billing/*', sessionMiddleware());
  base.use('/api/billing/*', helcimMiddleware());

  base.use('/api/webhooks/*', dbMiddleware());

  base.use('/api/ws/*', dbMiddleware());
  base.use('/api/ws/*', redisMiddleware());
  base.use('/api/ws/*', ironSessionMiddleware());
  base.use('/api/ws/*', sessionMiddleware());

  base.use('/api/users/*', csrfProtection());
  base.use('/api/users/*', dbMiddleware());
  base.use('/api/users/*', redisMiddleware());
  base.use('/api/users/*', ironSessionMiddleware());
  base.use('/api/users/*', sessionMiddleware());

  base.use('/api/dev/*', csrfProtection());
  base.use('/api/dev/*', devOnly());
  base.use('/api/dev/*', dbMiddleware());
  base.use('/api/dev/*', redisMiddleware());

  // Chain ALL routes for full AppType inference
  const app = base
    .route('/api/health', healthRoute)
    .route('/api/auth', opaqueAuthRoute)
    .route('/api/conversations', conversationsRoute)
    .route('/api/members', membersRoute)
    .route('/api/links', linksRoute)
    .route('/api/link-guest', linkGuestRoute)
    .route('/api/messages', messageSharesRoute)
    .route('/api/shares', publicSharesRoute)
    .route('/api/keys', keysRoute)
    .route('/api/chat', chatRoute)
    .route('/api/trial', trialChatRoute)
    .route('/api/models', modelsRoute)
    .route('/api/billing', billingRoute)
    .route('/api/webhooks', webhooksRoute)
    .route('/api/ws', websocketRoute)
    .route('/api/budgets', budgetsRoute)
    .route('/api/users', usersRoute)
    .route('/api/dev', devRoute);

  return app;
}

export type AppType = ReturnType<typeof createApp>;
