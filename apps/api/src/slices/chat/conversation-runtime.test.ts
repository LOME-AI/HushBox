import { describe, expect, it, vi } from 'vitest';
import { expectExposes } from '@hushbox/shared/test-assertions';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { createChatConversationRuntime } from './conversation-runtime.js';
import type { ChatConversationRuntimeDeps } from './conversation-runtime.js';
import type { Bindings } from '../../lib/context/index.js';
import type { Telemetry } from '../../lib/telemetry/index.js';

const silentTelemetry: Telemetry = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  captureError: vi.fn(),
};

/** The R2 bindings the composer's storage adapter reads (local-stack names). */
const R2_ENV = {
  R2_S3_ENDPOINT: 'http://localhost:9000',
  R2_BUCKET_MEDIA: 'media',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
};

/**
 * The exact drizzle chain the run referee's claim insert runs, recording the
 * row so a caller can read back the executor id the runtime minted, then
 * failing the claim.
 */
function claimRecordingDb(rows: Record<string, unknown>[]): ChatConversationRuntimeDeps['db'] {
  const chain = {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        rows.push(row);
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.reject(new Error('claim insert refused')),
          }),
        };
      },
    }),
  };
  return chain as unknown as ChatConversationRuntimeDeps['db'];
}

// The runtime builds synchronously (the executor loads its catalog lazily on
// first run), so db/redis are never touched at construction.
function deps(env: Bindings): ChatConversationRuntimeDeps {
  return {
    db: {} as unknown as ChatConversationRuntimeDeps['db'],
    redis: {} as unknown as ChatConversationRuntimeDeps['redis'],
    telemetry: silentTelemetry,
    env: { ...R2_ENV, ...env } as Bindings,
    readEpochPublicKey: () => Promise.resolve(null),
  };
}

describe('createChatConversationRuntime', () => {
  /**
   * The composer's provider selection leaves no mark on what it returns: real and
   * mock build the same runtime shape, and the flag that decided it is consumed
   * inside the executor. So the surface contract is all this asserts — and all it
   * claims. Which provider each env mode selects is proved by the key the real
   * path demands, below.
   */
  it('builds a runtime exposing the full run-control surface', () => {
    expectExposes(
      createChatConversationRuntime(
        deps({
          NODE_ENV: 'production',
          OPENROUTER_API_KEY: 'k',
          BRAVE_SEARCH_API_KEY: 'k',
        } as Bindings)
      ),
      'bindHooks',
      'claimRun',
      'releaseHold',
      'heartbeat',
      'failRun'
    );
  });

  it('fails fast in production when OPENROUTER_API_KEY is missing, naming the binding', () => {
    expect(() =>
      createChatConversationRuntime(deps({ NODE_ENV: 'production' } as Bindings))
    ).toThrow(/OPENROUTER_API_KEY/);
  });

  it('builds on the mock provider in local dev without an OpenRouter key', () => {
    // The real path demands OPENROUTER_API_KEY and throws without it, so
    // constructing with none set is what shows the mock path was selected.
    expect(() =>
      createChatConversationRuntime(deps({ NODE_ENV: 'development' } as Bindings))
    ).not.toThrow();
  });

  it('builds on the mock provider in E2E without an OpenRouter key', () => {
    expect(() =>
      createChatConversationRuntime(
        deps({ NODE_ENV: 'development', CI: 'true', E2E: 'true' } as Bindings)
      )
    ).not.toThrow();
  });

  it('builds the media storage adapter from env, failing fast on a missing R2 binding', () => {
    const base = deps({
      NODE_ENV: 'production',
      OPENROUTER_API_KEY: 'k',
      BRAVE_SEARCH_API_KEY: 'k',
    } as Bindings);
    const env = { ...base.env } as Record<string, unknown>;
    delete env['R2_S3_ENDPOINT'];
    expect(() => createChatConversationRuntime({ ...base, env: env as Bindings })).toThrow(
      /R2_S3_ENDPOINT/
    );
  });

  it('mints the run claim under the injected id source', async () => {
    const claimRows: Record<string, unknown>[] = [];
    const runtime = createChatConversationRuntime({
      ...deps({
        NODE_ENV: 'production',
        OPENROUTER_API_KEY: 'k',
        BRAVE_SEARCH_API_KEY: 'k',
      } as Bindings),
      db: claimRecordingDb(claimRows),
      now: () => new Date(TEST_DAY_START),
      newId: () => 'fixed-id',
    });
    // The id source mints the executor id the claim is written under; reading it
    // back off the claim row is what shows the composer forwarded the injection
    // rather than falling back to its own uuid default.
    await expect(
      runtime.claimRun({
        runKey: 'k',
        runId: 'r',
        bodyHash: 'h',
        identity: { mode: 'trial', sessionId: 's1' },
      })
    ).rejects.toThrow(/run referee unavailable/);
    expect(claimRows[0]?.['claimedBy']).toBe('fixed-id');
  });
});
