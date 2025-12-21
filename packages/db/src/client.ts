import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';

import * as schema from './schema/index';

neonConfig.webSocketConstructor = ws;

// Configure WebSocket proxy for local development
// In production with Neon, this isn't needed as the driver uses Neon's infrastructure
if (process.env['NODE_ENV'] === 'development') {
  neonConfig.wsProxy = (host, port) => `${host}:${String(port)}/v1`;
  // Use non-TLS WebSocket for local development (ws:// instead of wss://)
  neonConfig.useSecureWebSocket = false;
  // Disable TLS in the Postgres pipeline (local Postgres doesn't use TLS)
  neonConfig.pipelineTLS = false;
  // Disable SNI (not needed for local)
  neonConfig.pipelineConnect = false;
}

export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString });
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof createDb>;
