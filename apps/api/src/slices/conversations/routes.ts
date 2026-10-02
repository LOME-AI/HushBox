import { Hono } from 'hono';
import { defineSliceManifest } from '../../middleware/pipeline-manifest.js';
import { budgetRoutes } from './routes/budget-routes.js';
import { conversationRoutes } from './routes/conversation-routes.js';
import { historyRoutes } from './routes/history-routes.js';
import { keyRoutes } from './routes/key-routes.js';
import { linkRoutes } from './routes/link-routes.js';
import { membershipRoutes } from './routes/membership-routes.js';
import { membershipStateRoutes } from './routes/membership-state-routes.js';
import { shareRoutes } from './routes/share-routes.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { ConversationsRouteDeps } from './routes/deps.js';

// No return annotation on purpose: the chained route schema must flow through
// `defineSliceManifest`'s generic so `AppType` (and the typed client) carry
// this slice's routes — an explicit `Hono<AppEnv>` would erase it to
// `BlankSchema` (the `createApp()` pattern in app.ts, applied at the slice).
export function createConversationsManifest(deps: ConversationsRouteDeps) {
  return defineSliceManifest({
    basePath: '/conversations',
    // Every group mounts at `/`, so the router sees the same paths in the same
    // order as one chain: the groups are contiguous slices of it.
    routes: new Hono<AppEnv>()
      .route('/', conversationRoutes(deps))
      .route('/', membershipRoutes(deps))
      .route('/', membershipStateRoutes(deps))
      .route('/', budgetRoutes(deps))
      .route('/', keyRoutes(deps))
      .route('/', historyRoutes(deps))
      .route('/', linkRoutes(deps))
      .route('/', shareRoutes(deps)),
  });
}
