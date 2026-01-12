import type { betterAuth } from 'better-auth';
import type { Database } from '@lome-chat/db';
import type { HelcimClient } from './services/helcim/index.js';
import type { OpenRouterClient } from './services/openrouter/index.js';

export interface Bindings {
  DATABASE_URL: string;
  NODE_ENV?: string;
  CI?: string;
  E2E?: string;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  RESEND_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  HELCIM_API_TOKEN?: string;
  HELCIM_WEBHOOK_VERIFIER?: string;
  FRONTEND_URL?: string;
}

export interface Variables {
  db: Database;
  auth: ReturnType<typeof betterAuth>;
  helcim: HelcimClient;
  openrouter: OpenRouterClient;
  user: { id: string; email: string; name: string | null } | null;
  session: { id: string; userId: string; expiresAt: Date } | null;
}

export interface AppEnv {
  Bindings: Bindings;
  Variables: Variables;
}
