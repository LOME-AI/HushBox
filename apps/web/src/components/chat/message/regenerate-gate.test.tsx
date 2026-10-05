import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { SECOND_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { serializeSegments } from '@hushbox/shared';
import { usePromptBudget } from '@/hooks/billing/use-prompt-budget';
import { turnNoticeForCode, turnNoticeText } from '@/lib/chat/turn-notice';
import { RegenerateGate } from '@/components/chat/message/regenerate-gate';
import type { NoticeReason } from '@hushbox/shared';
import type { PromptBudgetResult } from '@/hooks/billing/use-prompt-budget';
import type { Message } from '@/lib/api/api';

// The send gate's answer: only its verdict varies here, the rest is a funded, settled text turn.
type GateAnswer = Pick<PromptBudgetResult, 'sendRefusal' | 'fundingSource'>;
const { gateRef, gateWith } = vi.hoisted(() => {
  const gateRef: { current: GateAnswer } = {
    current: { sendRefusal: undefined, fundingSource: 'personal_balance' },
  };
  function gateWith(answer: GateAnswer): PromptBudgetResult {
    return {
      ...answer,
      notifications: [],
      notices: [],
      payerSwitch: undefined,
      capacityPercent: 1,
      capacityBand: 'room_to_spare',
      capacityCurrentUsage: 1000,
      capacityMaxCapacity: 100_000,
      estimatedCostNanoUsd: undefined,
      isOverCapacity: false,
      hasBlockingError: false,
      hasPersistentBlockingError: false,
      isBillingLoading: false,
      hasContent: false,
      isAffordabilitySettled: true,
      maxOutputTokens: 8000,
      estimatedInputTokens: 10,
      mediaOptions: undefined,
      effortDimension: undefined,
    };
  }
  return { gateRef, gateWith };
});
vi.mock('@/hooks/billing/use-prompt-budget', () => ({
  usePromptBudget: vi.fn((): PromptBudgetResult => gateWith(gateRef.current)),
}));

const question: Message = {
  id: 'q-1',
  conversationId: 'conv-1',
  role: 'user',
  content: 'Hello!',
  createdAt: isoAt(TEST_DAY_START),
};
const answer: Message = {
  id: 'a-1',
  conversationId: 'conv-1',
  role: 'assistant',
  content: serializeSegments([
    { kind: 'reasoning', children: [{ kind: 'text', text: 'chain of thought' }] },
    { kind: 'text', text: 'Hi there!' },
  ]),
  createdAt: isoAt(TEST_DAY_START + SECOND_MS),
};
const notice = turnNoticeForCode('UNAVAILABLE');
const noticeRow: Message = {
  id: 'tile-1',
  conversationId: 'conv-1',
  role: 'assistant',
  content: turnNoticeText(notice),
  turnNotice: notice,
  createdAt: isoAt(TEST_DAY_START + 2 * SECOND_MS),
};

describe('RegenerateGate', () => {
  beforeEach(() => {
    gateRef.current = { sendRefusal: undefined, fundingSource: 'personal_balance' };
    vi.mocked(usePromptBudget).mockClear();
  });

  it('prices the re-run against the scope it is given, with no draft', () => {
    render(
      <RegenerateGate
        messages={[question]}
        scope={{ conversationId: 'conv-1', currentUserPrivilege: 'write' }}
        onRefusal={vi.fn<(refusal: NoticeReason | undefined) => void>()}
      />
    );
    expect(vi.mocked(usePromptBudget).mock.calls[0]?.[0]).toEqual({
      value: '',
      historyCharacters: 'Hello!'.length,
      conversationId: 'conv-1',
      currentUserPrivilege: 'write',
    });
  });

  it('counts the replayed history: answers without their reasoning, and no notice row', () => {
    render(
      <RegenerateGate
        messages={[question, answer, noticeRow]}
        scope={{}}
        onRefusal={vi.fn<(refusal: NoticeReason | undefined) => void>()}
      />
    );
    expect(vi.mocked(usePromptBudget).mock.calls[0]?.[0]).toMatchObject({
      historyCharacters: 'Hello!'.length + 'Hi there!'.length,
    });
  });

  it('reports a money refusal to its owner', () => {
    gateRef.current = { sendRefusal: 'insufficient_funds', fundingSource: 'personal_balance' };
    const onRefusal = vi.fn<(refusal: NoticeReason | undefined) => void>();
    render(<RegenerateGate messages={[question]} scope={{}} onRefusal={onRefusal} />);
    expect(onRefusal).toHaveBeenLastCalledWith('insufficient_funds');
  });

  it('reports no refusal for the premium entitlement a re-run does not re-buy', () => {
    const onRefusal = vi.fn<(refusal: NoticeReason | undefined) => void>();
    const { rerender } = render(
      <RegenerateGate messages={[question]} scope={{}} onRefusal={onRefusal} />
    );
    gateRef.current = { sendRefusal: 'insufficient_funds', fundingSource: 'personal_balance' };
    rerender(<RegenerateGate messages={[question]} scope={{}} onRefusal={onRefusal} />);
    gateRef.current = { sendRefusal: 'premium_requires_credit', fundingSource: 'personal_balance' };
    rerender(<RegenerateGate messages={[question]} scope={{}} onRefusal={onRefusal} />);
    expect(onRefusal).toHaveBeenCalled();
    expect(onRefusal.mock.lastCall?.[0]).toBeUndefined();
  });

  it('reports the new refusal when the verdict changes', () => {
    const onRefusal = vi.fn<(refusal: NoticeReason | undefined) => void>();
    const { rerender } = render(
      <RegenerateGate messages={[question]} scope={{}} onRefusal={onRefusal} />
    );
    gateRef.current = { sendRefusal: undefined, fundingSource: 'no_verdict' };
    rerender(<RegenerateGate messages={[question]} scope={{}} onRefusal={onRefusal} />);
    expect(onRefusal).toHaveBeenLastCalledWith('send_check_unavailable');
  });

  it('reports nothing while the gate refuses nothing, which is where its owner starts', () => {
    const onRefusal = vi.fn<(refusal: NoticeReason | undefined) => void>();
    render(<RegenerateGate messages={[question]} scope={{}} onRefusal={onRefusal} />);
    expect(onRefusal).not.toHaveBeenCalled();
  });

  it('withdraws its refusal when it unmounts', () => {
    gateRef.current = { sendRefusal: 'insufficient_funds', fundingSource: 'personal_balance' };
    const onRefusal = vi.fn<(refusal: NoticeReason | undefined) => void>();
    const { unmount } = render(
      <RegenerateGate messages={[question]} scope={{}} onRefusal={onRefusal} />
    );
    unmount();
    expect(onRefusal).toHaveBeenCalled();
    expect(onRefusal.mock.lastCall?.[0]).toBeUndefined();
  });

  it('reports its refusal again after a remount under strict mode', () => {
    gateRef.current = { sendRefusal: 'insufficient_funds', fundingSource: 'personal_balance' };
    const onRefusal = vi.fn<(refusal: NoticeReason | undefined) => void>();
    render(
      <React.StrictMode>
        <RegenerateGate messages={[question]} scope={{}} onRefusal={onRefusal} />
      </React.StrictMode>
    );
    expect(onRefusal).toHaveBeenLastCalledWith('insufficient_funds');
  });

  it('draws nothing', () => {
    const { container } = render(
      <RegenerateGate
        messages={[question]}
        scope={{}}
        onRefusal={vi.fn<(refusal: NoticeReason | undefined) => void>()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
