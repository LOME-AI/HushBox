import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LinkRow } from '@/components/chat/member/link-row';

const baseLink = {
  id: 'link1',
  displayName: 'Dave',
  privilege: 'read',
  createdAt: '2026-02-08T00:00:00Z',
};

describe('LinkRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the display name when present', () => {
    render(<LinkRow link={baseLink} index={0} isCurrentLink={false} isAdmin />);

    expect(screen.getByTestId('link-item-link1')).toHaveTextContent('Dave');
  });

  it('falls back to Guest Link #N when display name is null', () => {
    render(
      <LinkRow link={{ ...baseLink, displayName: null }} index={3} isCurrentLink={false} isAdmin />
    );

    expect(screen.getByTestId('link-item-link1')).toHaveTextContent('Guest Link #4');
  });

  it('saves trimmed name on Enter', async () => {
    const onSaveLinkName = vi.fn();
    const user = userEvent.setup();
    render(
      <LinkRow
        link={baseLink}
        index={0}
        isCurrentLink={false}
        isAdmin
        onSaveLinkName={onSaveLinkName}
      />
    );

    await user.click(screen.getByTestId('link-actions-link1'));
    await waitFor(() => {
      expect(screen.getByTestId('link-change-name-link1')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('link-change-name-link1'));

    const input = await screen.findByTestId('link-name-input-link1');
    await user.clear(input);
    await user.type(input, '  New Name  {Enter}');

    expect(onSaveLinkName).toHaveBeenCalledWith('link1', 'New Name');
  });

  it('does not save an empty name', async () => {
    const onSaveLinkName = vi.fn();
    const user = userEvent.setup();
    render(
      <LinkRow
        link={baseLink}
        index={0}
        isCurrentLink={false}
        isAdmin
        onSaveLinkName={onSaveLinkName}
      />
    );

    await user.click(screen.getByTestId('link-actions-link1'));
    await user.click(await screen.findByTestId('link-change-name-link1'));

    const input = await screen.findByTestId('link-name-input-link1');
    await user.clear(input);
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSaveLinkName).not.toHaveBeenCalled();
    expect(screen.queryByTestId('link-name-input-link1')).not.toBeInTheDocument();
  });

  it('cancels editing on Escape without saving', async () => {
    const onSaveLinkName = vi.fn();
    const user = userEvent.setup();
    render(
      <LinkRow
        link={baseLink}
        index={0}
        isCurrentLink={false}
        isAdmin
        onSaveLinkName={onSaveLinkName}
      />
    );

    await user.click(screen.getByTestId('link-actions-link1'));
    await user.click(await screen.findByTestId('link-change-name-link1'));

    const input = await screen.findByTestId('link-name-input-link1');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByTestId('link-name-input-link1')).not.toBeInTheDocument();
    expect(onSaveLinkName).not.toHaveBeenCalled();
  });

  it('hides the actions menu for non-admins', () => {
    render(<LinkRow link={baseLink} index={0} isCurrentLink={false} isAdmin={false} />);

    expect(screen.queryByTestId('link-actions-link1')).not.toBeInTheDocument();
  });

  it('shows the (you) badge for the current link', () => {
    render(<LinkRow link={baseLink} index={0} isCurrentLink isAdmin />);

    expect(screen.getByTestId('link-you-badge')).toBeInTheDocument();
  });
});
