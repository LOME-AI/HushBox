// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StreamdownContext } from 'streamdown';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeBlockHeader } from '@/components/chat/message/code-block-header';
import type { StreamdownContextType } from 'streamdown';

const downloadMock = vi.hoisted(() => ({
  downloadTextFile: vi.fn<(filename: string, text: string) => void>(),
}));

vi.mock('@/lib/download-text-file', () => downloadMock);

const CODE = 'const answer = 42;\nconsole.log(answer);\n';

const ANIMATING_CONTEXT: StreamdownContextType = {
  controls: true,
  isAnimating: true,
  lineNumbers: true,
  mode: 'streaming',
  shikiTheme: ['github-light', 'github-dark'],
};

afterEach(() => {
  downloadMock.downloadTextFile.mockReset();
  vi.useRealTimers();
});

describe('CodeBlockHeader', () => {
  it('shows the block language', () => {
    render(<CodeBlockHeader language="rust" code={CODE} />);

    expect(screen.getByText('rust')).toBeInTheDocument();
  });

  it('labels the download control with the word Download', () => {
    render(<CodeBlockHeader language="rust" code={CODE} />);

    expect(screen.getByRole('button', { name: 'Download' })).toHaveTextContent('Download');
  });

  it('labels the copy control with the word Copy', () => {
    render(<CodeBlockHeader language="rust" code={CODE} />);

    expect(screen.getByRole('button', { name: 'Copy' })).toHaveTextContent('Copy');
  });

  it('downloads a common language under its own extension', async () => {
    const user = userEvent.setup();
    render(<CodeBlockHeader language="typescript" code={CODE} />);

    await user.click(screen.getByRole('button', { name: 'Download' }));

    expect(downloadMock.downloadTextFile).toHaveBeenCalledWith('file.ts', CODE);
  });

  it('downloads an unknown language under the language as its extension', async () => {
    const user = userEvent.setup();
    render(<CodeBlockHeader language="brainfog" code={CODE} />);

    await user.click(screen.getByRole('button', { name: 'Download' }));

    expect(downloadMock.downloadTextFile).toHaveBeenCalledWith('file.brainfog', CODE);
  });

  it('downloads a block with no language as a text file', async () => {
    const user = userEvent.setup();
    render(<CodeBlockHeader language="" code={CODE} />);

    await user.click(screen.getByRole('button', { name: 'Download' }));

    expect(downloadMock.downloadTextFile).toHaveBeenCalledWith('file.txt', CODE);
  });

  it('copies the exact code', async () => {
    const user = userEvent.setup();
    render(<CodeBlockHeader language="rust" code={CODE} />);

    await user.click(screen.getByRole('button', { name: 'Copy' }));

    expect(await navigator.clipboard.readText()).toBe(CODE);
  });

  it('reads Copied once the code is on the clipboard', async () => {
    const user = userEvent.setup();
    render(<CodeBlockHeader language="rust" code={CODE} />);

    await user.click(screen.getByRole('button', { name: 'Copy' }));

    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('announces the copy to assistive technology', async () => {
    const user = userEvent.setup();
    render(<CodeBlockHeader language="rust" code={CODE} />);

    await user.click(screen.getByRole('button', { name: 'Copy' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Code copied');
  });

  it('returns to Copy after the acknowledgement', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    render(<CodeBlockHeader language="rust" code={CODE} />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await screen.findByRole('button', { name: 'Copied' });

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('disables both controls while the message is still streaming', () => {
    render(
      <StreamdownContext.Provider value={ANIMATING_CONTEXT}>
        <CodeBlockHeader language="rust" code={CODE} />
      </StreamdownContext.Provider>
    );

    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled();
  });
});
