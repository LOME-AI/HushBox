import type { Redis } from '@upstash/redis';
import type { Database } from '@hushbox/db';
import type { EnvUtilities, Platform } from '@hushbox/shared';
import type { HelcimClient } from './services/helcim/index.js';
import type { OpenRouterClient } from './services/openrouter/index.js';
import type { SessionData } from './lib/session.js';

/** Minimal Durable Object namespace binding (avoids leaking @cloudflare/workers-types globally) */
interface DONamespaceBinding {
  idFromName(name: string): { toString(): string };
  get(id: { toString(): string }): { fetch(request: Request): Promise<Response> };
}

/** Minimal R2 bucket binding (avoids leaking @cloudflare/workers-types globally) */
interface R2BucketBinding {
  get(key: string): Promise<{
    body: ReadableStream;
    httpMetadata?: { contentType?: string };
    size: number;
  } | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | string): Promise<unknown>;
}

export interface Bindings {
  DATABASE_URL: string;
  APP_VERSION: string;
  NODE_ENV?: string;
  CI?: string;
  E2E?: string;
  RESEND_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  HELCIM_API_TOKEN?: string;
  HELCIM_WEBHOOK_VERIFIER?: string;
  FCM_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT_JSON?: string;
  FRONTEND_URL?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  OPAQUE_MASTER_SECRET?: string;
  IRON_SESSION_SECRET?: string;
  CONVERSATION_ROOM?: DONamespaceBinding;
  APP_BUILDS?: R2BucketBinding;
}

export interface Variables {
  platform: Platform;
  db: Database;
  redis: Redis;
  helcim: HelcimClient;
  openrouter: OpenRouterClient;
  envUtils: EnvUtilities;
  user: {
    id: string;
    email: string | null;
    username: string;
    emailVerified: boolean;
    totpEnabled: boolean;
    hasAcknowledgedPhrase: boolean;
    publicKey: Uint8Array;
  } | null;
  member: { id: string; privilege: string; visibleFromEpoch: number };
  session: SessionData | null;
  sessionData: SessionData | null;
}

export interface AppEnv {
  Bindings: Bindings;
  Variables: Variables;
}
