import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Mock auth to break transitive import chain: chat.js → auth.ts → api.ts (env parse)
vi.mock('../lib/auth', () => ({
  useAuthStore: vi.fn((selector: (s: { privateKey: null }) => unknown) =>
    selector({ privateKey: null })
  ),
}));

// Mock crypto and epoch-key-cache (transitive deps of chat.js)
vi.mock('@hushbox/crypto', () => ({
  decryptMessage: vi.fn(),
  fromBase64: vi.fn(),
}));

vi.mock('../lib/epoch-key-cache', () => ({
  getEpochKey: vi.fn(() => {}),
  processKeyChain: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  getSnapshot: vi.fn(() => 0),
}));

vi.mock('../lib/api-client.js', () => ({
  client: {
    api: {
      members: {
        ':conversationId': {
          $get: vi.fn(),
          add: { $post: vi.fn() },
          remove: { $post: vi.fn() },
          privilege: { $patch: vi.fn() },
          leave: { $post: vi.fn() },
          accept: { $patch: vi.fn() },
        },
      },
    },
  },
  fetchJson: vi.fn(),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    ...actual,
    useQuery: vi.fn(actual.useQuery),
    useMutation: vi.fn(actual.useMutation),
    useQueryClient: vi.fn(actual.useQueryClient),
  };
});

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { client, fetchJson } from '../lib/api-client.js';
import {
  memberKeys,
  useConversationMembers,
  useAddMember,
  useRemoveMember,
  useChangePrivilege,
  useLeaveConversation,
  useAcceptMembership,
} from './use-conversation-members.js';
import { budgetKeys } from './use-conversation-budgets.js';
import { chatKeys } from './chat.js';

const mockedUseQuery = vi.mocked(useQuery);
const mockedUseMutation = vi.mocked(useMutation);
const mockedUseQueryClient = vi.mocked(useQueryClient);
const mockedFetchJson = vi.mocked(fetchJson);
const mockedClient = vi.mocked(client);

describe('memberKeys', () => {
  it('produces all key', () => {
    expect(memberKeys.all).toEqual(['members']);
  });

  it('produces list key with conversationId', () => {
    expect(memberKeys.list('conv-1')).toEqual(['members', 'conv-1']);
  });
});

describe('useConversationMembers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enables the query when conversationId is provided', () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useConversationMembers('conv-1'));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: memberKeys.list('conv-1'),
        enabled: true,
      })
    );
  });

  it('disables the query when conversationId is null', () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useConversationMembers(null));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: memberKeys.list(''),
        enabled: false,
      })
    );
  });

  it('calls the correct client path in queryFn', async () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useConversationMembers('conv-1'));

    const queryFunction = mockedUseQuery.mock.calls[0]![0].queryFn as () => Promise<unknown>;
    await queryFunction();

    expect(mockedClient.api.members[':conversationId'].$get).toHaveBeenCalledWith({
      param: { conversationId: 'conv-1' },
    });
    expect(mockedFetchJson).toHaveBeenCalled();
  });
});

describe('useAddMember', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    } as unknown as ReturnType<typeof useQueryClient>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls useMutation with correct mutationFn', () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useAddMember());

    expect(mockedUseMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationFn: expect.any(Function),
      })
    );
  });

  it('passes wrap when giveFullHistory is true', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useAddMember());

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
      userId: string;
      privilege: string;
      giveFullHistory: boolean;
      wrap?: string;
    }) => Promise<unknown>;

    await mutationFunction({
      conversationId: 'conv-1',
      userId: 'user-2',
      wrap: 'base64wrap',
      privilege: 'read',
      giveFullHistory: true,
    });

    expect(mockedClient.api.members[':conversationId'].add.$post).toHaveBeenCalledWith({
      param: { conversationId: 'conv-1' },
      json: { userId: 'user-2', wrap: 'base64wrap', privilege: 'read', giveFullHistory: true },
    });
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('passes rotation when giveFullHistory is false', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useAddMember());

    const testRotation = {
      expectedEpoch: 1,
      epochPublicKey: 'ep-pub',
      confirmationHash: 'conf-hash',
      chainLink: 'chain',
      encryptedTitle: 'enc-title',
      memberWraps: [{ memberPublicKey: 'mpk', wrap: 'w', privilege: 'admin', visibleFromEpoch: 1 }],
    };

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
      userId: string;
      privilege: string;
      giveFullHistory: boolean;
      rotation?: typeof testRotation;
    }) => Promise<unknown>;

    await mutationFunction({
      conversationId: 'conv-1',
      userId: 'user-2',
      privilege: 'write',
      giveFullHistory: false,
      rotation: testRotation,
    });

    expect(mockedClient.api.members[':conversationId'].add.$post).toHaveBeenCalledWith({
      param: { conversationId: 'conv-1' },
      json: {
        userId: 'user-2',
        privilege: 'write',
        giveFullHistory: false,
        rotation: testRotation,
      },
    });
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('invalidates member list and budget cache on success', async () => {
    const invalidateQueries = vi.fn();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries,
    } as unknown as ReturnType<typeof useQueryClient>);
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useAddMember());

    const onSuccess = mockedUseMutation.mock.calls[0]![0].onSuccess as (
      data: unknown,
      variables: { conversationId: string },
      context: unknown
    ) => Promise<void>;

    await onSuccess(
      {},
      {
        conversationId: 'conv-1',
      },
      // eslint-disable-next-line unicorn/no-useless-undefined -- onSuccess requires three arguments
      undefined
    );

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: memberKeys.list('conv-1'),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: budgetKeys.conversation('conv-1'),
    });
  });
});

describe('useRemoveMember', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    } as unknown as ReturnType<typeof useQueryClient>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes correct parameters to the client including rotation', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useRemoveMember());

    const testRotation = {
      expectedEpoch: 1,
      epochPublicKey: 'ep-pub',
      confirmationHash: 'conf-hash',
      chainLink: 'chain',
      encryptedTitle: 'enc-title',
      memberWraps: [{ memberPublicKey: 'mpk', wrap: 'w', privilege: 'admin', visibleFromEpoch: 1 }],
    };

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
      memberId: string;
      rotation: typeof testRotation;
    }) => Promise<unknown>;

    await mutationFunction({ conversationId: 'conv-1', memberId: 'mem-1', rotation: testRotation });

    expect(mockedClient.api.members[':conversationId'].remove.$post).toHaveBeenCalledWith({
      param: { conversationId: 'conv-1' },
      json: { memberId: 'mem-1', rotation: testRotation },
    });
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('invalidates member list and budget cache on success', async () => {
    const invalidateQueries = vi.fn();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries,
    } as unknown as ReturnType<typeof useQueryClient>);
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useRemoveMember());

    const onSuccess = mockedUseMutation.mock.calls[0]![0].onSuccess as (
      data: unknown,
      variables: { conversationId: string; memberId: string },
      context: unknown
    ) => Promise<void>;

    // eslint-disable-next-line unicorn/no-useless-undefined -- onSuccess requires three arguments
    await onSuccess({}, { conversationId: 'conv-1', memberId: 'mem-1' }, undefined);

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: memberKeys.list('conv-1'),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: budgetKeys.conversation('conv-1'),
    });
  });
});

describe('useChangePrivilege', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    } as unknown as ReturnType<typeof useQueryClient>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes correct parameters to the client', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useChangePrivilege());

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
      memberId: string;
      privilege: string;
    }) => Promise<unknown>;

    await mutationFunction({ conversationId: 'conv-1', memberId: 'mem-1', privilege: 'admin' });

    expect(mockedClient.api.members[':conversationId'].privilege.$patch).toHaveBeenCalledWith({
      param: { conversationId: 'conv-1' },
      json: { memberId: 'mem-1', privilege: 'admin' },
    });
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('invalidates member list and budget cache on success', async () => {
    const invalidateQueries = vi.fn();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries,
    } as unknown as ReturnType<typeof useQueryClient>);
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useChangePrivilege());

    const onSuccess = mockedUseMutation.mock.calls[0]![0].onSuccess as (
      data: unknown,
      variables: { conversationId: string; memberId: string; privilege: string },
      context: unknown
    ) => Promise<void>;

    await onSuccess(
      {},
      { conversationId: 'conv-1', memberId: 'mem-1', privilege: 'admin' },
      // eslint-disable-next-line unicorn/no-useless-undefined -- onSuccess requires three arguments
      undefined
    );

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: memberKeys.list('conv-1'),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: budgetKeys.conversation('conv-1'),
    });
  });
});

describe('useLeaveConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    } as unknown as ReturnType<typeof useQueryClient>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends empty json body when no rotation provided', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useLeaveConversation());

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
    }) => Promise<unknown>;

    await mutationFunction({ conversationId: 'conv-1' });

    expect(mockedClient.api.members[':conversationId'].leave.$post).toHaveBeenCalledWith({
      param: { conversationId: 'conv-1' },
      json: {},
    });
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('sends rotation in json body when provided', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useLeaveConversation());

    const testRotation = {
      expectedEpoch: 1,
      epochPublicKey: 'ep-pub',
      confirmationHash: 'conf-hash',
      chainLink: 'chain',
      encryptedTitle: 'enc-title',
      memberWraps: [{ memberPublicKey: 'mpk', wrap: 'w', privilege: 'admin', visibleFromEpoch: 1 }],
    };

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
      rotation?: typeof testRotation;
    }) => Promise<unknown>;

    await mutationFunction({ conversationId: 'conv-1', rotation: testRotation });

    expect(mockedClient.api.members[':conversationId'].leave.$post).toHaveBeenCalledWith({
      param: { conversationId: 'conv-1' },
      json: { rotation: testRotation },
    });
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('invalidates conversations list, member list, and budget cache on success', async () => {
    const invalidateQueries = vi.fn();
    const removeQueries = vi.fn();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries,
      removeQueries,
    } as unknown as ReturnType<typeof useQueryClient>);
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useLeaveConversation());

    const onSuccess = mockedUseMutation.mock.calls[0]![0].onSuccess as (
      data: unknown,
      variables: { conversationId: string },
      context: unknown
    ) => Promise<void>;

    // eslint-disable-next-line unicorn/no-useless-undefined -- onSuccess requires three arguments
    await onSuccess({}, { conversationId: 'conv-1' }, undefined);

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: chatKeys.conversations(),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: memberKeys.list('conv-1'),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: budgetKeys.conversation('conv-1'),
    });
  });

  it('removes conversation and messages from cache on success', async () => {
    const invalidateQueries = vi.fn();
    const removeQueries = vi.fn();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries,
      removeQueries,
    } as unknown as ReturnType<typeof useQueryClient>);
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useLeaveConversation());

    const onSuccess = mockedUseMutation.mock.calls[0]![0].onSuccess as (
      data: unknown,
      variables: { conversationId: string },
      context: unknown
    ) => Promise<void>;

    // eslint-disable-next-line unicorn/no-useless-undefined -- onSuccess requires three arguments
    await onSuccess({}, { conversationId: 'conv-1' }, undefined);

    expect(removeQueries).toHaveBeenCalledWith({
      queryKey: chatKeys.conversation('conv-1'),
    });
  });
});

describe('useAcceptMembership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    } as unknown as ReturnType<typeof useQueryClient>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes correct parameters to the client', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useAcceptMembership());

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
    }) => Promise<unknown>;

    await mutationFunction({ conversationId: 'conv-1' });

    expect(mockedClient.api.members[':conversationId'].accept.$patch).toHaveBeenCalledWith({
      param: { conversationId: 'conv-1' },
    });
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('invalidates conversations list on success', async () => {
    const invalidateQueries = vi.fn();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries,
    } as unknown as ReturnType<typeof useQueryClient>);
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useAcceptMembership());

    const onSuccess = mockedUseMutation.mock.calls[0]![0].onSuccess as (
      data: unknown,
      variables: { conversationId: string },
      context: unknown
    ) => Promise<void>;

    // eslint-disable-next-line unicorn/no-useless-undefined -- onSuccess requires three arguments
    await onSuccess({}, { conversationId: 'conv-1' }, undefined);

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: chatKeys.conversations(),
    });
  });
});
