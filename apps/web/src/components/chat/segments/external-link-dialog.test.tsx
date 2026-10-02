import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { ExternalLinkDialog } from '@/components/chat/segments/external-link-dialog';

const { native, openExternalUrl } = vi.hoisted(() => ({
  native: { current: false },
  openExternalUrl: vi.fn<(url: string) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock('@/capacitor/platform', () => ({ isNative: () => native.current }));
vi.mock('@/capacitor/browser', () => ({ openExternalUrl }));

const URL_TEXT = 'https://lwn.net/Articles/1039270/';

beforeEach(() => {
  native.current = false;
  openExternalUrl.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExternalLinkDialog', () => {
  it('stays closed while no page is chosen', () => {
    render(<ExternalLinkDialog url={null} onClose={vi.fn()} />);
    expect(screen.queryByTestId(TEST_IDS.externalLinkDialog)).not.toBeInTheDocument();
  });

  it('hands the page to the system browser in the native shell', () => {
    native.current = true;
    const onClose = vi.fn();
    render(<ExternalLinkDialog url={URL_TEXT} onClose={onClose} />);
    fireEvent.click(screen.getByTestId(TEST_IDS.externalLinkOpenButton));
    expect(openExternalUrl).toHaveBeenCalledWith(URL_TEXT);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hands an http page to the system browser in the native shell', () => {
    native.current = true;
    render(<ExternalLinkDialog url="http://example.com/" onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId(TEST_IDS.externalLinkOpenButton));
    expect(openExternalUrl).toHaveBeenCalledWith('http://example.com/');
  });

  it('leaves a mailto link to the platform in the native shell', () => {
    native.current = true;
    const open = vi.spyOn(globalThis, 'open').mockImplementation(() => null);
    render(<ExternalLinkDialog url="mailto:hello@example.com" onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId(TEST_IDS.externalLinkOpenButton));
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith('mailto:hello@example.com', '_blank', 'noopener,noreferrer');
  });

  it('leaves a tel link to the platform in the native shell', () => {
    native.current = true;
    const open = vi.spyOn(globalThis, 'open').mockImplementation(() => null);
    render(<ExternalLinkDialog url="tel:+15555550100" onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId(TEST_IDS.externalLinkOpenButton));
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith('tel:+15555550100', '_blank', 'noopener,noreferrer');
  });

  it('copies the address and says so', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ExternalLinkDialog url={URL_TEXT} onClose={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId(TEST_IDS.externalLinkCopyButton));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(URL_TEXT);
    expect(screen.getByTestId(TEST_IDS.externalLinkCopyButton)).toHaveTextContent('Copied');
  });

  it('closes when the reader dismisses it', () => {
    const onClose = vi.fn();
    render(<ExternalLinkDialog url={URL_TEXT} onClose={onClose} />);
    fireEvent.keyDown(screen.getByTestId(TEST_IDS.externalLinkDialog), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
