import * as React from 'react';
import { describe, it, expect, expectTypeOf, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from '@hushbox/ui';
import { TEST_IDS, friendlyErrorMessage } from '@hushbox/shared';
import { renderWithProviders } from '@/test-utils/render';
import { urlFromFetchInput } from '@/test-utils/fetch-mock';
import { ForkDialogs, useForkManagement } from './fork-management';
import type { RenameConversationDialog } from '@/components/sidebar/rename-conversation-dialog';
import type { DeleteConversationDialog } from '@/components/sidebar/delete-conversation-dialog';

const CONVERSATION_ID = 'conv-1';

const FORKS = [
  { id: 'main', name: 'Main' },
  { id: 'fork-1', name: 'Fork 1' },
];

interface SentRequest {
  method: string;
  url: string;
  body: unknown;
}

type Transport = (request: SentRequest) => Promise<Response>;

let transport: Transport;
let sent: SentRequest[];

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function parseBody(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}

beforeEach(() => {
  sent = [];
  transport = (): Promise<Response> => Promise.resolve(jsonResponse(200, {}));
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request: SentRequest = {
      method: init?.method ?? 'GET',
      url: urlFromFetchInput(input),
      body: parseBody(init),
    };
    sent.push(request);
    return transport(request);
  });
});

interface HarnessProps {
  forks?: readonly { id: string; name: string }[];
  activeForkId?: string | null;
  setActiveFork?: (id: string | null) => void;
}

function ForkManagementHarness({
  forks = FORKS,
  activeForkId = 'fork-1',
  setActiveFork = vi.fn(),
}: Readonly<HarnessProps>): React.JSX.Element {
  const fm = useForkManagement(CONVERSATION_ID, forks, activeForkId, setActiveFork);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          fm.handleForkSelect('main');
        }}
      >
        Select Main
      </button>
      <button
        type="button"
        onClick={() => {
          fm.handleForkRename('fork-1', 'Fork 1');
        }}
      >
        Rename Fork 1
      </button>
      <button
        type="button"
        onClick={() => {
          fm.handleForkDelete('fork-1');
        }}
      >
        Delete Fork 1
      </button>
      <button
        type="button"
        onClick={() => {
          fm.handleForkFromMessage('msg-1');
        }}
      >
        Fork from message
      </button>
      <ForkDialogs fm={fm} />
      <Toaster />
    </>
  );
}

async function renameTo(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Rename Fork 1' }));
  const input = await screen.findByDisplayValue('Fork 1');
  await user.clear(input);
  await user.type(input, name);
  await user.click(screen.getByTestId(TEST_IDS.saveRenameButton));
}

async function confirmDelete(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Delete Fork 1' }));
  await user.click(await screen.findByTestId(TEST_IDS.confirmDeleteButton));
}

describe('fork rename', () => {
  it('keeps the rename dialog open and announces FORK_NAME_TAKEN when the rename is refused', async () => {
    transport = (): Promise<Response> =>
      Promise.resolve(jsonResponse(409, { code: 'FORK_NAME_TAKEN' }));
    const user = userEvent.setup();
    renderWithProviders(<ForkManagementHarness />);

    await renameTo(user, 'Main');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      friendlyErrorMessage('FORK_NAME_TAKEN')
    );
    expect(screen.getByDisplayValue('Main')).toBeInTheDocument();
  });

  it('holds the rename dialog open and dismiss-locked until the rename lands', async () => {
    const response = Promise.withResolvers<Response>();
    transport = (): Promise<Response> => response.promise;
    const user = userEvent.setup();
    renderWithProviders(<ForkManagementHarness />);

    await renameTo(user, 'Renamed');
    await user.keyboard('{Escape}');

    expect(screen.getByTestId(TEST_IDS.renameConversationDialog)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.saveRenameButton)).toBeDisabled();
    expect(screen.getByTestId(TEST_IDS.cancelRenameButton)).toBeDisabled();

    response.resolve(jsonResponse(200, { fork: { id: 'fork-1', name: 'Renamed' } }));
    await waitFor(() => {
      expect(screen.queryByTestId(TEST_IDS.renameConversationDialog)).not.toBeInTheDocument();
    });
  });

  it('sends the trimmed name to the fork it renames', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ForkManagementHarness />);

    await renameTo(user, '  Renamed  ');

    await waitFor(() => {
      expect(sent).toContainEqual(
        expect.objectContaining({
          method: 'PATCH',
          url: expect.stringContaining(`/conversations/${CONVERSATION_ID}/forks/fork-1`),
          body: { name: 'Renamed' },
        })
      );
    });
  });

  it('closes the rename dialog on cancel without sending anything', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ForkManagementHarness />);

    await user.click(screen.getByRole('button', { name: 'Rename Fork 1' }));
    await user.click(await screen.findByTestId(TEST_IDS.cancelRenameButton));

    await waitFor(() => {
      expect(screen.queryByTestId(TEST_IDS.renameConversationDialog)).not.toBeInTheDocument();
    });
    expect(sent).toEqual([]);
  });
});

describe('fork delete', () => {
  it('keeps the delete dialog open and announces the failure when the delete is dropped', async () => {
    transport = (): Promise<Response> => Promise.reject(new TypeError('Failed to fetch'));
    const user = userEvent.setup();
    renderWithProviders(<ForkManagementHarness />);

    await confirmDelete(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i);
    expect(screen.getByTestId(TEST_IDS.deleteConversationDialog)).toBeInTheDocument();
  });

  it('clears the active fork once the active fork is deleted', async () => {
    const setActiveFork = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<ForkManagementHarness setActiveFork={setActiveFork} />);

    await confirmDelete(user);

    await waitFor(() => {
      expect(setActiveFork).toHaveBeenCalledWith(null);
    });
  });

  it('closes the delete dialog once the delete lands', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ForkManagementHarness />);

    await confirmDelete(user);

    await waitFor(() => {
      expect(screen.queryByTestId(TEST_IDS.deleteConversationDialog)).not.toBeInTheDocument();
    });
  });

  it('keeps the active fork when a different fork is deleted', async () => {
    const setActiveFork = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <ForkManagementHarness activeForkId="main" setActiveFork={setActiveFork} />
    );

    await confirmDelete(user);

    await waitFor(() => {
      expect(screen.queryByTestId(TEST_IDS.deleteConversationDialog)).not.toBeInTheDocument();
    });
    expect(setActiveFork).not.toHaveBeenCalled();
  });

  it('names a fork missing from the list "Fork" in the delete confirmation', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ForkManagementHarness forks={[]} />);

    await user.click(screen.getByRole('button', { name: 'Delete Fork 1' }));

    expect(await screen.findByText(/permanently delete "Fork"/)).toBeInTheDocument();
  });

  it('closes the delete dialog on cancel without sending anything', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ForkManagementHarness />);

    await user.click(screen.getByRole('button', { name: 'Delete Fork 1' }));
    await user.click(await screen.findByTestId(TEST_IDS.cancelDeleteButton));

    await waitFor(() => {
      expect(screen.queryByTestId(TEST_IDS.deleteConversationDialog)).not.toBeInTheDocument();
    });
    expect(sent).toEqual([]);
  });
});

describe('fork from message', () => {
  it('tells the user when a fork is refused at the branch limit', async () => {
    transport = (): Promise<Response> =>
      Promise.resolve(jsonResponse(400, { code: 'FORK_LIMIT_REACHED' }));
    const user = userEvent.setup();
    renderWithProviders(<ForkManagementHarness />);

    await user.click(screen.getByRole('button', { name: 'Fork from message' }));

    expect(await screen.findByText(friendlyErrorMessage('FORK_LIMIT_REACHED'))).toBeInTheDocument();
  });

  it('restores the previously active fork when creation is refused', async () => {
    transport = (): Promise<Response> =>
      Promise.resolve(jsonResponse(400, { code: 'FORK_LIMIT_REACHED' }));
    const setActiveFork = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<ForkManagementHarness setActiveFork={setActiveFork} />);

    await user.click(screen.getByRole('button', { name: 'Fork from message' }));

    await waitFor(() => {
      expect(setActiveFork).toHaveBeenLastCalledWith('fork-1');
    });
  });

  it('claims the new fork active before the create request settles', async () => {
    transport = (): Promise<Response> => new Promise<Response>(() => undefined);
    const setActiveFork = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<ForkManagementHarness setActiveFork={setActiveFork} />);

    await user.click(screen.getByRole('button', { name: 'Fork from message' }));

    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    const createBody = sent[0]?.body as { id: string; fromMessageId: string };
    expect(createBody.fromMessageId).toBe('msg-1');
    expect(setActiveFork).toHaveBeenCalledWith(createBody.id);
  });

  it('keeps the new fork active once creation lands', async () => {
    const setActiveFork = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<ForkManagementHarness setActiveFork={setActiveFork} />);

    await user.click(screen.getByRole('button', { name: 'Fork from message' }));

    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    const createBody = sent[0]?.body as { id: string };
    await waitFor(() => {
      expect(setActiveFork).toHaveBeenLastCalledWith(createBody.id);
    });
  });
});

describe('fork select', () => {
  it('activates the selected fork', async () => {
    const setActiveFork = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<ForkManagementHarness setActiveFork={setActiveFork} />);

    await user.click(screen.getByRole('button', { name: 'Select Main' }));

    expect(setActiveFork).toHaveBeenCalledWith('main');
  });
});

describe('confirm contract', () => {
  it('refuses a confirm that returns nothing to wait on', () => {
    type RenameConfirm = React.ComponentProps<typeof RenameConversationDialog>['onConfirm'];
    type DeleteConfirm = React.ComponentProps<typeof DeleteConversationDialog>['onConfirm'];

    expectTypeOf<() => void>().not.toExtend<RenameConfirm>();
    expectTypeOf<() => void>().not.toExtend<DeleteConfirm>();
  });
});
