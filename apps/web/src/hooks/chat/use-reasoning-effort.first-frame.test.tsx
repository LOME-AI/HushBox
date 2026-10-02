// @vitest-environment jsdom
import * as React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import {
  effectiveReasoningSelection,
  useEffortAvailabilityPublisher,
  type EffortModel,
} from '@/hooks/chat/use-reasoning-effort';
import { useReasoningEffortStore } from '@/stores/reasoning-effort';
import type { DimensionAvailability, EffortChoice } from '@hushbox/shared';

/**
 * Two models with the SAME ladder, so the model clamp answers identically for
 * both and nothing but the graded set can move the rung the send carries. A
 * difference between them is a publication-timing difference and can be nothing
 * else.
 */
const ROOMY_ID = 'roomy';
const CAPPED_ID = 'capped';

function effortModel(id: string): EffortModel {
  return { id, contextLength: 200_000, reasoning: { supportedEfforts: ['high', 'medium', 'low'] } };
}

/**
 * The effort dimension as the turn producer grades it — every rung present and
 * marked, never filtered. `roomy` funds its whole ladder; `capped` cannot write
 * a usable answer at High, which is the completion-cap refusal a picker that
 * grades a model at its cheapest feasible rung now hands the composer.
 */
function gradedDimension(modelIds: readonly string[]): DimensionAvailability {
  const highFits = !modelIds.includes(CAPPED_ID);
  return {
    dimensionId: 'effort',
    options: [
      { optionId: 'low', label: 'Low', availability: { available: true } },
      { optionId: 'medium', label: 'Mid', availability: { available: true } },
      {
        optionId: 'high',
        label: 'High',
        availability: highFits
          ? { available: true }
          : { available: false, reason: 'model_output_cap_too_low' },
      },
    ],
  };
}

/**
 * The send gate reduced to the one term this file is about: the request rides
 * the rung `effective` names, and the turn is refused when the graded set does
 * not enable that rung. `auto` delegates the rung to the server, so it sends.
 */
function sendableWith(
  modelIds: readonly string[],
  published: readonly EffortChoice[] | undefined
): boolean {
  const sent = effectiveReasoningSelection({
    preferred: useReasoningEffortStore.getState().preferredReasoningEffort,
    models: modelIds.map((id) => effortModel(id)),
    modality: 'text',
    enabled: published,
  });
  if (sent === undefined) return false;
  if (sent === 'auto') return true;
  const option = gradedDimension(modelIds).options.find((entry) => entry.optionId === sent);
  return option?.availability.available === true;
}

/** The composer's effort control: the one surface that publishes the graded set. */
function EffortControl({
  dimension,
}: Readonly<{ dimension?: DimensionAvailability | undefined }>): null {
  useEffortAvailabilityPublisher(dimension);
  return null;
}

interface Frame {
  readonly modelIds: readonly string[];
  readonly sendable: boolean;
}

/**
 * One recorded frame per commit, read in the composer's layout phase.
 *
 * That phase is the last moment before the browser paints the commit, and it
 * runs after the effects of the control below it, so what it reads is what the
 * user is about to see. A frame recorded here answers the question the settled
 * value cannot: whether an unsendable turn ever reached the screen on the way to
 * a sendable one.
 */
function Composer({
  modelIds,
  frames,
}: Readonly<{ modelIds: readonly string[]; frames: Frame[] }>): React.JSX.Element {
  const published = useReasoningEffortStore((state) => state.enabledEffortChoices);
  React.useLayoutEffect(() => {
    // Read at commit time, not from the render above: a publication made in
    // this commit's layout phase has already queued the correcting render, and
    // that render lands before the browser paints. What the layout phase can
    // read is therefore what the next paint shows.
    const atCommit = useReasoningEffortStore.getState().enabledEffortChoices;
    frames.push({ modelIds, sendable: sendableWith(modelIds, atCommit) });
  });
  return (
    <>
      <span>{sendableWith(modelIds, published) ? 'send' : 'blocked'}</span>
      <EffortControl dimension={gradedDimension(modelIds)} />
    </>
  );
}

describe('the frame a selection change paints', () => {
  let frames: Frame[];

  beforeEach(() => {
    frames = [];
    useReasoningEffortStore.setState({
      preferredReasoningEffort: 'high',
      enabledEffortChoices: undefined,
    });
  });

  it('never paints an unsendable turn after selecting a model that cannot fund the pin', () => {
    const { rerender } = render(<Composer modelIds={[ROOMY_ID]} frames={frames} />);
    frames.length = 0;

    rerender(<Composer modelIds={[CAPPED_ID]} frames={frames} />);

    expect(frames.map((frame) => frame.sendable)).not.toContain(false);
  });

  it('never paints an unsendable turn when the selection carries several models', () => {
    const { rerender } = render(<Composer modelIds={[ROOMY_ID]} frames={frames} />);
    frames.length = 0;

    rerender(<Composer modelIds={[ROOMY_ID, CAPPED_ID]} frames={frames} />);

    expect(frames.map((frame) => frame.sendable)).not.toContain(false);
  });

  it('settles sendable however late the graded set arrives', () => {
    const { container, rerender } = render(<Composer modelIds={[ROOMY_ID]} frames={frames} />);

    rerender(<Composer modelIds={[CAPPED_ID]} frames={frames} />);

    expect(container.textContent).toBe('send');
  });

  it('lowers the sent rung onto the newly selected model without touching the preference', () => {
    const { rerender } = render(<Composer modelIds={[ROOMY_ID]} frames={frames} />);

    rerender(<Composer modelIds={[CAPPED_ID]} frames={frames} />);

    expect(useReasoningEffortStore.getState().enabledEffortChoices).toStrictEqual([
      'low',
      'medium',
    ]);
    expect(useReasoningEffortStore.getState().preferredReasoningEffort).toBe('high');
  });

  it('publishes nothing while the turn carries no graded dimension', () => {
    render(<EffortControl />);

    expect(useReasoningEffortStore.getState().enabledEffortChoices).toBeUndefined();
  });
});
