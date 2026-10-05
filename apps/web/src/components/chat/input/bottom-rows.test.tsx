import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';

const { mockUseModels } = vi.hoisted(() => ({
  mockUseModels: vi.fn(
    (): UseModelsStub => ({
      data: { models: [], premiumIds: new Set<string>() },
    })
  ),
}));

vi.mock('@/hooks/models/models', () => ({
  useModels: mockUseModels,
}));

const modelStoreStubRef: { current: ModelStoreStub } = { current: createModelStoreStub() };
function resetStub(overrides: Partial<ModelStoreStub> = {}): void {
  modelStoreStubRef.current = createModelStoreStub(overrides);
}

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const store = vi.fn((selector?: (s: ModelStoreStub) => unknown) =>
    selector ? selector(modelStoreStubRef.current) : modelStoreStubRef.current
  );
  (store as unknown as Record<string, unknown>)['setState'] = vi.fn();
  (store as unknown as Record<string, unknown>)['getState'] = () => modelStoreStubRef.current;
  return { ...actual, useModelStore: store };
});

import { BottomRows, drawsTextRow, TextBottomRow } from '@/components/chat/input/bottom-rows';
import type { UseModelsStub } from '@/test-utils/models-hook-stub';

const TOOLBAR = <div data-testid="test-toolbar">toolbar</div>;
const SEND = <button data-testid="test-send">send</button>;

describe('TextBottomRow', () => {
  it('draws no context meter, which the composer seats on its top edge', () => {
    const { container } = render(<TextBottomRow toolbar={TOOLBAR} sendButton={SEND} />);

    expect(screen.queryByTestId(TEST_IDS.capacityBar)).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="meter"]')).toBeNull();
  });

  it('keeps the toolbar and send button at the right edge', () => {
    render(<TextBottomRow toolbar={TOOLBAR} sendButton={SEND} />);

    const row = screen.getByTestId('test-toolbar').parentElement;
    expect(row).toHaveClass('justify-end');
    expect(row).toContainElement(screen.getByTestId('test-send'));
  });

  it('takes no room when it is handed nothing to hold', () => {
    const { container } = render(<TextBottomRow toolbar={null} sendButton={null} />);

    const row = container.firstElementChild;
    expect(row).toBeEmptyDOMElement();
    expect(row).toHaveClass('empty:hidden');
  });
});

describe('drawsTextRow', () => {
  it.each([undefined, 'text'] as const)('draws the text row for %s', (modality) => {
    expect(drawsTextRow(modality, true)).toBe(true);
  });

  it('draws the text row for audio when audio is not offered', () => {
    expect(drawsTextRow('audio', false)).toBe(true);
  });

  it('draws the audio row, not the text row, when audio is offered', () => {
    expect(drawsTextRow('audio', true)).toBe(false);
  });

  it.each(['image', 'video'] as const)('draws its own row for %s', (modality) => {
    expect(drawsTextRow(modality, false)).toBe(false);
  });
});

describe('BottomRows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStub();
  });

  it.each(['image', 'video'] as const)(
    'draws no row for %s, whose settings and estimate sit in the composer bar',
    (modality) => {
      const { container } = render(
        <BottomRows
          activeModality={modality}
          toolbar={TOOLBAR}
          sendButton={SEND}
          audioModalityEnabled={false}
        />
      );
      expect(container).toBeEmptyDOMElement();
    }
  );

  it('draws the text row for a text turn', () => {
    render(
      <BottomRows
        activeModality="text"
        toolbar={TOOLBAR}
        sendButton={SEND}
        audioModalityEnabled={false}
      />
    );
    expect(screen.getByTestId('test-toolbar').parentElement).toHaveClass('justify-end');
  });

  it('draws the audio row when audio is offered', () => {
    render(
      <BottomRows activeModality="audio" toolbar={TOOLBAR} sendButton={SEND} audioModalityEnabled />
    );
    expect(screen.getByRole('slider', { name: /audio max duration/i })).toBeInTheDocument();
  });
});
