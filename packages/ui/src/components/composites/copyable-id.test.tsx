import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { testUuidV7 } from '@hushbox/shared/test-time';
import { CopyableId } from './copyable-id';

afterEach(() => {
  vi.restoreAllMocks();
});

function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

describe('CopyableId', () => {
  it('renders the id in monospace with a labeled copy button', () => {
    render(<CopyableId value="018f-abc" label="user id" />);

    expect(screen.getByText('018f-abc')).toHaveClass('font-mono');
    expect(screen.getByRole('button', { name: 'Copy user id' })).toBeInTheDocument();
  });

  it('never wraps the id mid-string and exposes the full value as a title', () => {
    render(<CopyableId value={testUuidV7(2)} label="job id" />);

    const id = screen.getByText(testUuidV7(2));
    expect(id).toHaveAttribute('title', testUuidV7(2));
    expect(id.className).toContain('whitespace-nowrap');
    expect(id.className).not.toContain('break-all');
  });

  it('copies the exact value to the clipboard', async () => {
    const user = userEvent.setup();
    // After setup(): userEvent installs its own clipboard stub this replaces.
    const writeText = stubClipboard();
    render(<CopyableId value="raw-wire-value" label="amount" />);

    await user.click(screen.getByTestId(TEST_IDS.adminCopyId));

    expect(writeText).toHaveBeenCalledWith('raw-wire-value');
  });

  it('confirms a successful copy on the button', async () => {
    const user = userEvent.setup();
    stubClipboard();
    render(<CopyableId value="raw-wire-value" label="amount" />);

    await user.click(screen.getByTestId(TEST_IDS.adminCopyId));

    expect(await screen.findByRole('button', { name: 'Copied amount' })).toBeInTheDocument();
  });

  it('has a data-slot attribute', () => {
    const { container } = render(<CopyableId value="018f-abc" label="user id" />);

    expect(container.querySelector('[data-slot="copyable-id"]')).toBeInTheDocument();
  });
});
