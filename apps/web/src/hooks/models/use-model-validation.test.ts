import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  createModelStoreStub,
  selectorFromState,
  type ModelStoreStub,
} from '@/test-utils/model-store-mock';
import { useModelStore } from '@/stores/model';
import { useModelValidation } from '@/hooks/models/use-model-validation.js';

vi.mock('@/lib/auth/auth', () => ({
  useSession: vi.fn(),
}));

// A double, not a second implementation: each test states what is KNOWN about
// the payer's funding — served, awaiting, exhausted, or no door at all. Which
// credential opens which door, and how a query settles into one of those
// answers, is pinned where it lives, in `use-spendable.test.ts`.
vi.mock('@/hooks/billing/use-spendable.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/billing/use-spendable.js')>()),
  useFundingRead: vi.fn(),
}));

vi.mock('@/hooks/models/models.js', () => ({
  useModels: vi.fn(),
  getAccessibleModelIds: vi.fn(),
}));

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  return {
    ...actual,
    useModelStore: vi.fn(),
  };
});

import { useSession } from '@/lib/auth/auth';
import { useFundingRead } from '@/hooks/billing/use-spendable.js';
import { useModels, getAccessibleModelIds } from '@/hooks/models/models.js';
import type { FundingRead } from '@/hooks/billing/use-spendable.js';
import type { SelectedModelEntry } from '@/stores/model';
import type { Model, ChatModality } from '@hushbox/shared';

const mockedUseSession = vi.mocked(useSession);
const mockedUseFundingRead = vi.mocked(useFundingRead);

/** A landed read of the payer's snapshot at the given tier. */
function servedTier(
  tier: 'paid' | 'free' | 'trial' | 'guest',
  payer: 'self' | 'owner' = 'self'
): FundingRead {
  return {
    status: 'served',
    snapshot: {
      spendableNanoUsd: '0',
      heldNanoUsd: '0',
      payerTier: tier,
      payer,
      ownerFundingLimit: payer === 'owner' ? 'member_allocation' : null,
    },
  };
}

/** A door-holder's read still in flight. */
const AWAITING: FundingRead = { status: 'awaiting', snapshot: undefined };

/** A door-holder's read that has exhausted its retries and will not land. */
const UNAVAILABLE: FundingRead = { status: 'unavailable', snapshot: undefined };

/** A caller with no funding door at all — the trial, and any unscoped guest read. */
const NO_DOOR: FundingRead = { status: 'no-door', snapshot: undefined };

/**
 * Serve `read` to exactly one funding scope and `otherwise` to every other, so
 * a hook reading the wrong scope reads a different tier and the assertion
 * moves.
 */
function servedByScope(scope: string | null, read: FundingRead, otherwise: FundingRead): void {
  mockedUseFundingRead.mockImplementation((_isAuthenticated, conversationId) =>
    conversationId === scope ? read : otherwise
  );
}
const mockedUseModels = vi.mocked(useModels);
const mockedGetAccessibleModelIds = vi.mocked(getAccessibleModelIds);
const mockedUseModelStore = vi.mocked(useModelStore);

const imagenModel: Model = {
  id: 'imagen',
  name: 'Imagen',
  description: 'Imagen',
  provider: 'Google',
  modality: 'image',
  contextLength: 0,
  supportedParameters: [],
  created: Math.floor(Date.now() / 1000),
  pricing: { perImage: '40000000' },
};

const testModels: Model[] = [
  {
    id: 'basic-model',
    name: 'Basic Model',
    description: 'A basic model',
    provider: 'TestProvider',
    modality: 'text' as const,
    contextLength: 100_000,
    supportedParameters: [],
    created: Math.floor(Date.now() / 1000),
    pricing: { inputPerToken: '10000', outputPerToken: '30000' },
  },
  {
    id: 'premium-model',
    name: 'Premium Model',
    description: 'A premium model',
    provider: 'TestProvider',
    modality: 'text' as const,
    contextLength: 200_000,
    supportedParameters: [],
    created: Math.floor(Date.now() / 1000),
    pricing: { inputPerToken: '100000', outputPerToken: '300000' },
  },
  imagenModel,
];

const mockSetSelectedModels = vi.fn();

function buildState(
  overrides: Partial<Record<ChatModality, SelectedModelEntry[]>> = {}
): ModelStoreStub {
  return createModelStoreStub({
    selections: {
      text: overrides.text ?? [{ id: 'basic-model', name: 'Basic Model' }],
      image: overrides.image ?? [],
      audio: overrides.audio ?? [],
      video: overrides.video ?? [],
    },
    setSelectedModels: mockSetSelectedModels,
  });
}

function stubStore(state: ModelStoreStub): void {
  mockedUseModelStore.mockImplementation(selectorFromState(state) as typeof useModelStore);
}

describe('useModelValidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseSession.mockReturnValue({ data: null, isPending: false } as ReturnType<
      typeof useSession
    >);
    mockedUseFundingRead.mockReturnValue(NO_DOOR);
    stubStore(buildState());
    mockedGetAccessibleModelIds.mockReturnValue({
      strongestId: 'basic-model',
      valueId: 'basic-model',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing when models data is not loaded', () => {
    mockedUseModels.mockReturnValue({ data: undefined } as ReturnType<typeof useModels>);

    renderHook(() => {
      useModelValidation(null);
    });

    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('does not run while session is loading', () => {
    mockedUseSession.mockReturnValue({
      data: undefined,
      isPending: true,
    } as unknown as ReturnType<typeof useSession>);
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(buildState({ text: [{ id: 'premium-model', name: 'Premium Model' }] }));

    renderHook(() => {
      useModelValidation(null);
    });

    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('does not reset when premium user has premium model selected', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseFundingRead.mockReturnValue(servedTier('paid'));
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(buildState({ text: [{ id: 'premium-model', name: 'Premium Model' }] }));

    renderHook(() => {
      useModelValidation(null);
    });

    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('does nothing when selected text model is already accessible', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseFundingRead.mockReturnValue(servedTier('free'));
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(buildState({ text: [{ id: 'basic-model', name: 'Basic Model' }] }));

    renderHook(() => {
      useModelValidation(null);
    });

    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('KEEPS a premium text model selected for a free user — marked, never removed', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseFundingRead.mockReturnValue(servedTier('free'));
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(buildState({ text: [{ id: 'premium-model', name: 'Premium Model' }] }));

    renderHook(() => {
      useModelValidation(null);
    });

    // The picker renders it greyed with its reason; rewriting the store would
    // hide a model the payer can unlock, and would change a selection the user
    // never changed.
    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('KEEPS a premium text model selected for a trial user — marked, never removed', () => {
    mockedUseSession.mockReturnValue({ data: null, isPending: false } as ReturnType<
      typeof useSession
    >);
    mockedUseFundingRead.mockReturnValue(NO_DOOR);
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(buildState({ text: [{ id: 'premium-model', name: 'Premium Model' }] }));

    renderHook(() => {
      useModelValidation(null);
    });

    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('leaves a premium selection alone even when a stronger basic model exists', () => {
    const modelsWithMultipleBasic: Model[] = [
      ...testModels,
      {
        id: 'expensive-basic',
        name: 'Expensive Basic',
        description: 'An expensive basic model',
        provider: 'TestProvider',
        modality: 'text' as const,
        contextLength: 150_000,
        supportedParameters: [],
        created: Math.floor(Date.now() / 1000),
        pricing: { inputPerToken: '50000', outputPerToken: '150000' },
      },
    ];

    mockedUseSession.mockReturnValue({ data: null, isPending: false } as ReturnType<
      typeof useSession
    >);
    mockedUseModels.mockReturnValue({
      data: { models: modelsWithMultipleBasic, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(buildState({ text: [{ id: 'premium-model', name: 'Premium Model' }] }));
    mockedGetAccessibleModelIds.mockReturnValue({
      strongestId: 'expensive-basic',
      valueId: 'basic-model',
    });

    renderHook(() => {
      useModelValidation(null);
    });

    // The fallback exists for a selection the CATALOG dropped, not for one the
    // payer merely cannot fund today.
    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('does not reset if strongest model is not in the models list', () => {
    mockedUseSession.mockReturnValue({ data: null, isPending: false } as ReturnType<
      typeof useSession
    >);
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(buildState({ text: [{ id: 'premium-model', name: 'Premium Model' }] }));
    mockedGetAccessibleModelIds.mockReturnValue({
      strongestId: 'non-existent',
      valueId: 'non-existent',
    });

    renderHook(() => {
      useModelValidation(null);
    });

    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('resets text when selected model no longer exists', () => {
    mockedUseSession.mockReturnValue({ data: null, isPending: false } as ReturnType<
      typeof useSession
    >);
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(buildState({ text: [{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }] }));

    renderHook(() => {
      useModelValidation(null);
    });

    expect(mockSetSelectedModels).toHaveBeenCalledWith('text', [
      { id: 'basic-model', name: 'Basic Model' },
    ]);
  });

  it('does not run while balance is loading for an authenticated user', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseFundingRead.mockReturnValue(AWAITING);
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(buildState({ text: [{ id: 'premium-model', name: 'Premium Model' }] }));

    renderHook(() => {
      useModelValidation(null);
    });

    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('waits for an in-flight payer read before pruning', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseFundingRead.mockReturnValue(AWAITING);
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(
      buildState({
        text: [{ id: 'basic-model', name: 'Basic Model' }],
        image: [{ id: 'stale-image-model', name: 'Stale' }],
      })
    );

    renderHook(() => {
      useModelValidation(null);
    });

    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('prunes a model the catalog dropped even when the payer read is exhausted', () => {
    // An in-flight read lands in milliseconds and the prune follows it; an
    // exhausted one never lands, so waiting on it strands a model the catalog
    // no longer carries in the user's selection indefinitely.
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseFundingRead.mockReturnValue(UNAVAILABLE);
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(
      buildState({
        text: [{ id: 'basic-model', name: 'Basic Model' }],
        image: [{ id: 'stale-image-model', name: 'Stale' }],
      })
    );

    renderHook(() => {
      useModelValidation(null);
    });

    expect(mockSetSelectedModels).toHaveBeenCalledWith('image', []);
  });

  it('substitutes no text fallback while the payer tier is unreadable', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseFundingRead.mockReturnValue(UNAVAILABLE);
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(buildState({ text: [{ id: 'dropped-from-catalog', name: 'Dropped' }] }));

    renderHook(() => {
      useModelValidation(null);
    });

    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('removes an invalid image model without touching text', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseFundingRead.mockReturnValue(servedTier('paid'));
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(
      buildState({
        text: [{ id: 'basic-model', name: 'Basic Model' }],
        image: [{ id: 'stale-image-model', name: 'Stale' }],
      })
    );

    renderHook(() => {
      useModelValidation(null);
    });

    expect(mockSetSelectedModels).toHaveBeenCalledTimes(1);
    expect(mockSetSelectedModels).toHaveBeenCalledWith('image', []);
  });

  it('preserves valid image models and only removes invalid ones', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseFundingRead.mockReturnValue(servedTier('paid'));
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(
      buildState({
        image: [
          { id: 'imagen', name: 'Imagen' },
          { id: 'stale', name: 'Stale' },
        ],
      })
    );

    renderHook(() => {
      useModelValidation(null);
    });

    expect(mockSetSelectedModels).toHaveBeenCalledWith('image', [{ id: 'imagen', name: 'Imagen' }]);
  });

  describe('trial-user modality lock', () => {
    it('forces activeModality to text when the user is unauthenticated', () => {
      const mockSetActiveModality = vi.fn();
      mockedUseSession.mockReturnValue({ data: null, isPending: false } as ReturnType<
        typeof useSession
      >);
      mockedUseFundingRead.mockReturnValue(NO_DOOR);
      mockedUseModels.mockReturnValue({
        data: { models: testModels, premiumIds: new Set(['premium-model']) },
      } as ReturnType<typeof useModels>);
      stubStore(
        createModelStoreStub({
          activeModality: 'image',
          selections: {
            text: [{ id: 'basic-model', name: 'Basic Model' }],
            image: [],
            audio: [],
            video: [],
          },
          setSelectedModels: mockSetSelectedModels,
          setActiveModality: mockSetActiveModality,
        })
      );

      renderHook(() => {
        useModelValidation(null);
      });

      expect(mockSetActiveModality).toHaveBeenCalledWith('text');
    });

    it('does not touch activeModality when already text for unauthenticated user', () => {
      const mockSetActiveModality = vi.fn();
      mockedUseSession.mockReturnValue({ data: null, isPending: false } as ReturnType<
        typeof useSession
      >);
      mockedUseFundingRead.mockReturnValue(NO_DOOR);
      mockedUseModels.mockReturnValue({
        data: { models: testModels, premiumIds: new Set(['premium-model']) },
      } as ReturnType<typeof useModels>);
      stubStore(
        createModelStoreStub({
          activeModality: 'text',
          selections: {
            text: [{ id: 'basic-model', name: 'Basic Model' }],
            image: [],
            audio: [],
            video: [],
          },
          setSelectedModels: mockSetSelectedModels,
          setActiveModality: mockSetActiveModality,
        })
      );

      renderHook(() => {
        useModelValidation(null);
      });

      expect(mockSetActiveModality).not.toHaveBeenCalled();
    });

    it('does not touch activeModality for authenticated users on non-text modality', () => {
      const mockSetActiveModality = vi.fn();
      mockedUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      } as ReturnType<typeof useSession>);
      mockedUseFundingRead.mockReturnValue(servedTier('paid'));
      mockedUseModels.mockReturnValue({
        data: { models: testModels, premiumIds: new Set(['premium-model']) },
      } as ReturnType<typeof useModels>);
      stubStore(
        createModelStoreStub({
          activeModality: 'image',
          selections: {
            text: [{ id: 'basic-model', name: 'Basic Model' }],
            image: [{ id: 'imagen', name: 'Imagen' }],
            audio: [],
            video: [],
          },
          setSelectedModels: mockSetSelectedModels,
          setActiveModality: mockSetActiveModality,
        })
      );

      renderHook(() => {
        useModelValidation(null);
      });

      expect(mockSetActiveModality).not.toHaveBeenCalled();
    });

    it('does not run while session is still loading', () => {
      const mockSetActiveModality = vi.fn();
      mockedUseSession.mockReturnValue({
        data: undefined,
        isPending: true,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseFundingRead.mockReturnValue(NO_DOOR);
      mockedUseModels.mockReturnValue({
        data: { models: testModels, premiumIds: new Set(['premium-model']) },
      } as ReturnType<typeof useModels>);
      stubStore(
        createModelStoreStub({
          activeModality: 'image',
          selections: {
            text: [{ id: 'basic-model', name: 'Basic Model' }],
            image: [],
            audio: [],
            video: [],
          },
          setSelectedModels: mockSetSelectedModels,
          setActiveModality: mockSetActiveModality,
        })
      );

      renderHook(() => {
        useModelValidation(null);
      });

      expect(mockSetActiveModality).not.toHaveBeenCalled();
    });
  });

  describe('the payer, not the sender, decides which fallback is reachable', () => {
    /** A dropped text selection, so the fallback substitution is what is observed. */
    function staleTextSelection(strongestId: string): void {
      mockedUseModels.mockReturnValue({
        data: { models: testModels, premiumIds: new Set(['premium-model']) },
      } as ReturnType<typeof useModels>);
      mockedGetAccessibleModelIds.mockReturnValue({ strongestId, valueId: strongestId });
      stubStore(buildState({ text: [{ id: 'dropped-from-catalog', name: 'Dropped' }] }));
    }

    it("substitutes the strongest model an owner-funded member's payer can reach", () => {
      mockedUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      } as ReturnType<typeof useSession>);
      servedByScope('conv-owner', servedTier('paid', 'owner'), servedTier('free'));
      staleTextSelection('premium-model');

      renderHook(() => {
        useModelValidation('conv-owner');
      });

      expect(mockSetSelectedModels).toHaveBeenCalledWith('text', [
        { id: 'premium-model', name: 'Premium Model' },
      ]);
    });

    it("substitutes the strongest model an owner-funded link guest's payer can reach", () => {
      // A guest is an unauthenticated caller reading the door its credential
      // grants inside one conversation. The unscoped door is closed to it,
      // which is exactly what made the guest resolve as if the owner had no
      // premium access.
      servedByScope('conv-shared', servedTier('paid', 'owner'), NO_DOOR);
      staleTextSelection('premium-model');

      renderHook(() => {
        useModelValidation('conv-shared');
      });

      expect(mockedUseFundingRead).toHaveBeenCalledWith(false, 'conv-shared');
      expect(mockSetSelectedModels).toHaveBeenCalledWith('text', [
        { id: 'premium-model', name: 'Premium Model' },
      ]);
    });

    it('rewrites nothing for a link guest whose payer snapshot has not arrived', () => {
      servedByScope('conv-shared', AWAITING, NO_DOOR);
      staleTextSelection('basic-model');

      renderHook(() => {
        useModelValidation('conv-shared');
      });

      expect(mockSetSelectedModels).not.toHaveBeenCalled();
    });

    it('leaves a solo self-funded caller reading its own unscoped door', () => {
      mockedUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      } as ReturnType<typeof useSession>);
      servedByScope(null, servedTier('paid'), servedTier('free'));
      staleTextSelection('premium-model');

      renderHook(() => {
        useModelValidation(null);
      });

      expect(mockedUseFundingRead).toHaveBeenCalledWith(true, null);
      expect(mockSetSelectedModels).toHaveBeenCalledWith('text', [
        { id: 'premium-model', name: 'Premium Model' },
      ]);
    });
  });
  describe('media axis snapping, with no media control mounted', () => {
    it('snaps a stored aspect ratio no selected image model offers', () => {
      mockedUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      } as ReturnType<typeof useSession>);
      mockedUseFundingRead.mockReturnValue(servedTier('paid'));
      const snappedImageModel: Model = {
        ...imagenModel,
        supportedAspectRatios: ['16:9', '9:16'],
      };
      mockedUseModels.mockReturnValue({
        data: { models: [snappedImageModel], premiumIds: new Set<string>() },
      } as ReturnType<typeof useModels>);
      const state = createModelStoreStub({
        activeModality: 'text',
        imageConfig: { aspectRatio: '1:1' },
        selections: {
          text: [{ id: 'basic-model', name: 'Basic Model' }],
          image: [{ id: 'imagen', name: 'Imagen' }],
          audio: [],
          video: [],
        },
        setSelectedModels: mockSetSelectedModels,
      });
      stubStore(state);

      renderHook(() => {
        useModelValidation(null);
      });

      expect(state.setImageConfig).toHaveBeenCalledWith({ aspectRatio: '16:9' });
    });
  });
});
