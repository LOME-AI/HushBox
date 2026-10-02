import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { stopTtsForMessageMock } = vi.hoisted(() => ({
  stopTtsForMessageMock: vi.fn(),
}));

vi.mock('@/lib/tts/chat-tts-stream', () => ({
  stopTtsForMessage: stopTtsForMessageMock,
}));

import { TEST_SIGNALS } from '@hushbox/shared';
import { useTtsPlaybackStore } from '@hushbox/ui/accessibility/store';
import { TtsStopButton } from '@/components/chat/indicators/tts-stop-button';

describe('TtsStopButton', () => {
  beforeEach(() => {
    stopTtsForMessageMock.mockReset();
    useTtsPlaybackStore.setState({
      speakingStreamId: null,
      stoppedStreamIds: new Set<string>(),
      audioStartedStreamIds: new Set<string>(),
    });
  });

  it('renders nothing when speakingStreamId is null', () => {
    const { container } = render(<TtsStopButton messageId="msg-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when speakingStreamId does not match this message', () => {
    useTtsPlaybackStore.getState().setSpeakingStream('other-msg');
    const { container } = render(<TtsStopButton messageId="msg-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a button when speakingStreamId matches this message', () => {
    useTtsPlaybackStore.getState().setSpeakingStream('msg-1');
    render(<TtsStopButton messageId="msg-1" />);
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('has an accessible label describing the action', () => {
    useTtsPlaybackStore.getState().setSpeakingStream('msg-1');
    render(<TtsStopButton messageId="msg-1" />);
    expect(screen.getByRole('button', { name: /stop reading/i })).toBeInTheDocument();
  });

  it('calls stopTtsForMessage with the message id on click', async () => {
    const user = userEvent.setup();
    useTtsPlaybackStore.getState().setSpeakingStream('msg-1');
    render(<TtsStopButton messageId="msg-1" />);
    await user.click(screen.getByRole('button'));
    expect(stopTtsForMessageMock).toHaveBeenCalledWith('msg-1');
  });

  it('matches the visual weight of the smart-model-chip (border + small uppercase text)', () => {
    useTtsPlaybackStore.getState().setSpeakingStream('msg-1');
    render(<TtsStopButton messageId="msg-1" />);
    const button = screen.getByRole('button');
    expect(button.className).toMatch(/border/);
    expect(button.className).toMatch(/uppercase/);
  });

  it('renders the "Stop reading" label text', () => {
    useTtsPlaybackStore.getState().setSpeakingStream('msg-1');
    render(<TtsStopButton messageId="msg-1" />);
    expect(screen.getByRole('button')).toHaveTextContent(/stop reading/i);
  });

  it('disappears when the speakingStreamId is cleared mid-render', () => {
    useTtsPlaybackStore.getState().setSpeakingStream('msg-1');
    const { container, rerender } = render(<TtsStopButton messageId="msg-1" />);
    expect(container.firstChild).not.toBeNull();
    useTtsPlaybackStore.getState().clearSpeakingStreamIfMatches('msg-1');
    rerender(<TtsStopButton messageId="msg-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('does not carry the chat-speaking signal before audio has actually started', () => {
    useTtsPlaybackStore.getState().setSpeakingStream('msg-1');
    render(<TtsStopButton messageId="msg-1" />);
    expect(screen.getByRole('button')).not.toHaveAttribute(TEST_SIGNALS.chatSpeaking);
  });

  it('carries the chat-speaking signal once audio has actually started for this message', () => {
    useTtsPlaybackStore.getState().setSpeakingStream('msg-1');
    useTtsPlaybackStore.getState().markAudioStarted('msg-1');
    render(<TtsStopButton messageId="msg-1" />);
    expect(screen.getByRole('button')).toHaveAttribute(TEST_SIGNALS.chatSpeaking, 'true');
  });

  it('does not carry the chat-speaking signal for a different message that started audio', () => {
    useTtsPlaybackStore.getState().setSpeakingStream('msg-1');
    useTtsPlaybackStore.getState().markAudioStarted('msg-2');
    render(<TtsStopButton messageId="msg-1" />);
    expect(screen.getByRole('button')).not.toHaveAttribute(TEST_SIGNALS.chatSpeaking);
  });
});
