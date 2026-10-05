import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SMART_MODEL_ID, TEST_ID_BUILDERS, TEST_IDS } from '@hushbox/shared';
import {
  MINUTE_MS,
  SECOND_MS,
  TEST_DAY_START,
  freezeClock,
  isoAt,
} from '@hushbox/shared/test-time';
import { assignModelSwatches, modelSwatch } from '@/lib/utils/model-color';
import { useModelStore, type SelectedModelEntry } from '@/stores/model';
import { CompareGroup } from './compare-group';
import type { Message } from '@/lib/api/api';
import type { Model } from '@hushbox/shared';
import type { ComparePresentation } from './ai-message-block';

const SONNET_ID = 'anthropic/claude-sonnet-4.5';
const GPT_ID = 'openai/gpt-5';
const GEMINI_ID = 'google/gemini-2.5-pro';

function model(
  id: string,
  name: string,
  provider: string,
  modality: Model['modality'] = 'text'
): Model {
  return {
    id,
    name,
    description: 'desc',
    provider,
    modality,
    contextLength: 8000,
    supportedParameters: [],
    pricing: { inputPerToken: '10000', outputPerToken: '30000' },
  };
}

const MODELS: readonly Model[] = [
  model(SONNET_ID, 'Claude Sonnet 4.5', 'Anthropic'),
  model(GPT_ID, 'GPT-5', 'OpenAI'),
  model(GEMINI_ID, 'Gemini 2.5 Pro', 'Google'),
];

function reply(index: number, modelName: string, extra: Partial<Message> = {}): Message {
  return {
    id: `reply-${String(index)}`,
    conversationId: 'conv-1',
    role: 'assistant',
    content: `Answer ${String(index)}`,
    createdAt: isoAt(TEST_DAY_START + index * SECOND_MS),
    parentMessageId: 'question',
    modelName,
    ...extra,
  };
}

const THREE: readonly Message[] = [
  reply(0, SONNET_ID, { cost: '6100000' }),
  reply(1, GPT_ID, { cost: '5200000' }),
  reply(2, GEMINI_ID, { cost: '3800000' }),
];

/** The composer's selection a three-model turn was sent with. */
const SELECTED_THREE: SelectedModelEntry[] = [
  { id: SONNET_ID, name: 'Claude Sonnet 4.5' },
  { id: GPT_ID, name: 'GPT-5' },
  { id: GEMINI_ID, name: 'Gemini 2.5 Pro' },
];

const DEEPSEEK_ID = 'deepseek/deepseek-v3.1';
const GROK_ID = 'x-ai/grok-4';
const SIXTH_ID = 'vendor/sixth';

const FIVE_MODELS: readonly Model[] = [
  ...MODELS,
  model(DEEPSEEK_ID, 'DeepSeek V3.1', 'DeepSeek'),
  model(GROK_ID, 'Grok 4', 'xAI'),
];

const FIVE: readonly Message[] = [...THREE, reply(3, DEEPSEEK_ID), reply(4, GROK_ID)];

const SELECTED_FIVE: SelectedModelEntry[] = [
  ...SELECTED_THREE,
  { id: DEEPSEEK_ID, name: 'DeepSeek V3.1' },
  { id: GROK_ID, name: 'Grok 4' },
];

const IMAGE_A_ID = 'vendor/image-a';
const IMAGE_B_ID = 'vendor/image-b';
const IMAGE_A = model(IMAGE_A_ID, 'Image A', 'Vendor', 'image');
const IMAGE_B = model(IMAGE_B_ID, 'Image B', 'Vendor', 'image');

/** What the group asked of each reply it drew, by reply id. */
let asked = new Map<string, ComparePresentation>();

/**
 * Draws the group. Each reply stands in for the thread's row, which draws whatever leading
 * control the group asks it to; `canSend` is whether the viewer may send to the conversation.
 */
function drawn(
  messages: readonly Message[] = THREE,
  models: readonly Model[] = MODELS,
  { canSend = false }: Readonly<{ canSend?: boolean }> = {}
): void {
  asked = new Map();
  const replies = messages.map((message) => ({
    message,
    render: (compare: ComparePresentation): React.JSX.Element => {
      asked.set(message.id, compare);
      return (
        <>
          <p>{message.content}</p>
          {compare.leadingControl}
        </>
      );
    },
  }));
  render(<CompareGroup replies={replies} models={models} canSend={canSend} />);
}

function tab(index: number): HTMLElement {
  return screen.getByTestId(TEST_ID_BUILDERS.compareTab(index));
}

function column(index: number): HTMLElement {
  return screen.getByTestId(TEST_ID_BUILDERS.compareColumn(index));
}

/** The swatch a tab draws, read from the colour class the swatch mark carries. */
function swatchOf(element: HTMLElement): string | undefined {
  const mark = element.querySelector('[data-slot="swatch"]');
  return [...(mark?.classList ?? [])].find((name) => name.startsWith('bg-model-'));
}

/** Two model ids whose own swatches are the same, so a set holding both must move one. */
function collidingIds(): readonly [string, string] {
  const firstId = 'vendor/model-0';
  const own = modelSwatch(firstId);
  for (let index = 1; index < 1000; index++) {
    const candidate = `vendor/model-${String(index)}`;
    if (modelSwatch(candidate) === own) return [firstId, candidate];
  }
  throw new Error('no two ids share a swatch');
}

describe('CompareGroup', () => {
  it('renders every reply, each in its own column', () => {
    drawn();

    expect(within(column(0)).getByText('Answer 0')).toBeInTheDocument();
    expect(within(column(1)).getByText('Answer 1')).toBeInTheDocument();
    expect(within(column(2)).getByText('Answer 2')).toBeInTheDocument();
  });

  it('marks the group for the transcript', () => {
    drawn();

    expect(screen.getByTestId(TEST_IDS.compareGroup)).toBeInTheDocument();
  });

  it('offers one tab per reply in a list named Replies', () => {
    drawn();

    const list = screen.getByRole('tablist', { name: 'Replies' });
    expect(within(list).getAllByRole('tab')).toHaveLength(3);
  });

  it("names each tab by its model's short name", () => {
    drawn();

    expect(tab(0)).toHaveTextContent('Claude Sonnet 4.5');
    expect(tab(1)).toHaveTextContent('GPT-5');
    expect(tab(2)).toHaveTextContent('Gemini 2.5 Pro');
  });

  it('names the tab of a reply that names no model as its nameplate does', () => {
    drawn([reply(0, SONNET_ID), reply(1, SONNET_ID, { modelName: null })]);

    expect(tab(1).textContent).toBe('AI');
  });

  it("shows each reply's own cost on its tab", () => {
    drawn();

    expect(tab(0)).toHaveTextContent('$0.0061');
    expect(tab(1)).toHaveTextContent('$0.0052');
  });

  it("never marks a tab's cost as a reply's cost figure", () => {
    drawn();

    expect(within(screen.getByRole('tablist')).queryByTestId(TEST_IDS.messageCost)).toBeNull();
  });

  it('shows no cost on the tab of a reply that has none yet', () => {
    drawn([reply(0, SONNET_ID), reply(1, GPT_ID, { cost: '5200000' })]);

    expect(tab(0).textContent).toBe('Claude Sonnet 4.5');
  });

  it('shows no cost for a cost that is not a canonical figure', () => {
    drawn([reply(0, SONNET_ID, { cost: '0.01' }), reply(1, GPT_ID)]);

    expect(tab(0).textContent).toBe('Claude Sonnet 4.5');
  });

  it("marks a failed model's tab with the error mark in place of its cost", () => {
    drawn([
      reply(0, SONNET_ID, { cost: '6100000' }),
      reply(1, GPT_ID, { errorCode: 'STREAM_ERROR' }),
    ]);

    expect(within(tab(1)).getByRole('img', { name: 'Failed' })).toBeInTheDocument();
    expect(tab(1)).not.toHaveTextContent('$');
  });

  it('keeps the cost muted on the selected tab', () => {
    drawn();

    expect(within(tab(0)).getByText('$0.0061')).toHaveClass('text-muted-foreground');
  });

  it("keeps the turn's space below the group, which its replies leave to it", () => {
    drawn();

    expect(screen.getByTestId(TEST_IDS.compareGroup)).toHaveClass('pb-7.5');
  });

  it('draws no error mark on a tab whose reply answered', () => {
    drawn();

    expect(within(tab(0)).queryByRole('img', { name: 'Failed' })).toBeNull();
  });

  it("gives each tab the swatch the turn's set assigns it", () => {
    const [firstId, secondId] = collidingIds();
    drawn([reply(0, firstId), reply(1, secondId)], []);

    const assigned = assignModelSwatches([firstId, secondId]);
    expect(swatchOf(tab(0))).toBe(`bg-model-${String(assigned.get(firstId))}`);
    expect(swatchOf(tab(1))).toBe(`bg-model-${String(assigned.get(secondId))}`);
    expect(swatchOf(tab(0))).not.toBe(swatchOf(tab(1)));
  });

  it('asks each reply to wear the swatch its tab wears', () => {
    const [firstId, secondId] = collidingIds();
    drawn([reply(0, firstId), reply(1, secondId)], []);

    expect(`bg-model-${String(asked.get('reply-0')?.swatch)}`).toBe(swatchOf(tab(0)));
    expect(`bg-model-${String(asked.get('reply-1')?.swatch)}`).toBe(swatchOf(tab(1)));
  });

  it('asks each reply to drop the chat column gutters the group already gives it', () => {
    drawn();

    expect(asked.get('reply-0')?.sidePadding).toBe('px-0');
  });

  it('asks each reply to set its answer a step smaller where the group shows columns', () => {
    drawn();

    expect(asked.get('reply-0')?.textScale).toBe('@cmp-columns/cmp:text-body-sub');
  });

  it('styles no reply from outside: no important utility and no reach into a slot', () => {
    drawn();

    const classes = [...screen.getByTestId(TEST_IDS.compareGroup).querySelectorAll('*')].flatMap(
      (element) => [...element.classList]
    );
    expect(classes.filter((name) => name.endsWith('!') || name.includes('data-slot'))).toEqual([]);
  });

  it('selects the first reply at first', () => {
    drawn();

    expect(tab(0)).toHaveAttribute('aria-selected', 'true');
    expect(tab(1)).toHaveAttribute('aria-selected', 'false');
    expect(column(0)).toHaveAttribute('data-current', 'true');
    expect(column(1)).toHaveAttribute('data-current', 'false');
  });

  it('shows the reply whose tab is pressed', async () => {
    drawn();

    await userEvent.click(tab(2));

    expect(tab(2)).toHaveAttribute('aria-selected', 'true');
    expect(tab(0)).toHaveAttribute('aria-selected', 'false');
    expect(column(2)).toHaveAttribute('data-current', 'true');
    expect(column(0)).toHaveAttribute('data-current', 'false');
  });

  it('ties each tab to the panel it controls', () => {
    drawn();

    expect(tab(1)).toHaveAttribute('aria-controls', column(1).id);
    expect(column(1)).toHaveAttribute('role', 'tabpanel');
  });

  it("names each panel by its model's name", () => {
    drawn();

    expect(screen.getByRole('tabpanel', { name: 'GPT-5', hidden: true })).toBe(column(1));
  });

  it('keeps only the selected tab in the tab order', () => {
    drawn();

    expect(tab(0)).toHaveAttribute('tabindex', '0');
    expect(tab(1)).toHaveAttribute('tabindex', '-1');
    expect(tab(2)).toHaveAttribute('tabindex', '-1');
  });

  it('moves to the next tab with the right arrow', async () => {
    drawn();
    tab(0).focus();

    await userEvent.keyboard('{ArrowRight}');

    expect(tab(1)).toHaveFocus();
    expect(tab(1)).toHaveAttribute('aria-selected', 'true');
  });

  it('wraps from the last tab to the first with the right arrow', async () => {
    drawn();
    await userEvent.click(tab(2));

    await userEvent.keyboard('{ArrowRight}');

    expect(tab(0)).toHaveFocus();
  });

  it('wraps from the first tab to the last with the left arrow', async () => {
    drawn();
    tab(0).focus();

    await userEvent.keyboard('{ArrowLeft}');

    expect(tab(2)).toHaveFocus();
    expect(tab(2)).toHaveAttribute('aria-selected', 'true');
  });

  it('jumps to the last tab with End', async () => {
    drawn();
    tab(0).focus();

    await userEvent.keyboard('{End}');

    expect(tab(2)).toHaveFocus();
  });

  it('jumps to the first tab with Home', async () => {
    drawn();
    await userEvent.click(tab(2));

    await userEvent.keyboard('{Home}');

    expect(tab(0)).toHaveFocus();
  });

  it('leaves other keys to the page', async () => {
    drawn();
    tab(0).focus();

    await userEvent.keyboard('{ArrowDown}');

    expect(tab(0)).toHaveFocus();
    expect(tab(0)).toHaveAttribute('aria-selected', 'true');
  });
  describe('the tab strip fade', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('fades the strip while its tabs are wider than it', () => {
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(480);
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320);
      drawn();

      expect(screen.getByRole('tablist')).toHaveAttribute('data-many', 'true');
    });

    it('draws no fade while every tab fits', () => {
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(320);
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320);
      drawn();

      expect(screen.getByRole('tablist')).not.toHaveAttribute('data-many');
    });
  });

  describe('Continue with this model', () => {
    beforeEach(() => {
      useModelStore.setState({
        activeModality: 'text',
        selections: { text: SELECTED_THREE, image: [], audio: [], video: [] },
      });
    });

    function continueIn(index: number): HTMLElement {
      return within(column(index)).getByTestId(TEST_IDS.continueWithModel);
    }

    it('asks each reply to start its control row with Continue', () => {
      drawn(THREE, MODELS, { canSend: true });

      expect(continueIn(0)).toHaveAccessibleName('Continue with this model');
      expect(continueIn(1)).toHaveAccessibleName('Continue with this model');
      expect(continueIn(2)).toHaveAccessibleName('Continue with this model');
    });

    it("makes the reply's model the composer's only selection", async () => {
      drawn(THREE, MODELS, { canSend: true });

      await userEvent.click(continueIn(1));

      expect(useModelStore.getState().selections.text).toEqual([{ id: GPT_ID, name: 'GPT-5' }]);
    });

    it("selects the model in its own modality and makes that modality the composer's", async () => {
      drawn([reply(0, IMAGE_A_ID), reply(1, IMAGE_B_ID)], [...MODELS, IMAGE_A, IMAGE_B], {
        canSend: true,
      });

      await userEvent.click(continueIn(1));

      const state = useModelStore.getState();
      expect(state.activeModality).toBe('image');
      expect(state.selections.image).toEqual([{ id: IMAGE_B_ID, name: 'Image B' }]);
      expect(state.selections.text).toEqual(SELECTED_THREE);
    });

    it('offers no Continue to a viewer who cannot send', () => {
      drawn(THREE, MODELS, { canSend: false });

      expect(screen.queryByTestId(TEST_IDS.continueWithModel)).toBeNull();
    });

    it("selects a Smart Model reply's resolved model, the model that answered", async () => {
      drawn([reply(0, SONNET_ID, { isSmartModel: true }), reply(1, GPT_ID)], MODELS, {
        canSend: true,
      });

      await userEvent.click(continueIn(0));

      expect(useModelStore.getState().selections.text).toEqual([
        { id: SONNET_ID, name: 'Claude Sonnet 4.5' },
      ]);
    });

    it('offers no Continue for a reply whose model the catalog does not offer', () => {
      drawn(THREE, MODELS.slice(0, 2), { canSend: true });

      expect(within(column(2)).queryByTestId(TEST_IDS.continueWithModel)).toBeNull();
    });
  });

  describe('the summary under the replies', () => {
    function summary(): HTMLElement {
      const total = screen.getByText(/for this question/);
      const line = total.closest('[data-chrome]');
      if (!(line instanceof HTMLElement)) throw new Error('Expected the summary line');
      return line;
    }

    it("states the turn's total for this question", () => {
      drawn();

      expect(summary()).toHaveTextContent('$0.0151 for this question');
    });

    it('sums only the replies that carry a cost', () => {
      drawn([
        reply(0, SONNET_ID, { cost: '6100000' }),
        reply(1, GPT_ID),
        reply(2, GEMINI_ID, { cost: '0.01' }),
      ]);

      expect(summary()).toHaveTextContent('$0.0061 for this question');
    });

    it('states no total while no reply carries a cost', () => {
      drawn([reply(0, SONNET_ID), reply(1, GPT_ID)]);

      expect(screen.queryByText(/for this question/)).toBeNull();
    });

    it("never marks the total as a reply's cost figure", () => {
      drawn();

      expect(within(summary()).queryByTestId(TEST_IDS.messageCost)).toBeNull();
    });

    it('says Saved encrypted once every reply is stored', () => {
      drawn(THREE.map((message) => ({ ...message, wrappedContentKey: 'wrapped' })));

      expect(within(summary()).getByText('Saved encrypted')).toBeInTheDocument();
    });

    it('says nothing about storage while a reply is not yet stored', () => {
      drawn([
        reply(0, SONNET_ID, { cost: '6100000', wrappedContentKey: 'wrapped' }),
        reply(1, GPT_ID),
      ]);

      expect(within(summary()).queryByText('Saved encrypted')).toBeNull();
    });

    it('draws each later dot on the fact it precedes, so a wrapped line starts on it', () => {
      drawn(THREE.map((message) => ({ ...message, wrappedContentKey: 'wrapped' })));

      const facts = [...(summary().firstElementChild?.children ?? [])];
      expect(facts.map((fact) => fact.classList.contains('before:rounded-full'))).toEqual([
        false,
        true,
        true,
      ]);
    });

    it("dates a stored turn by its first reply's instant", () => {
      freezeClock(TEST_DAY_START + MINUTE_MS, { toFake: ['Date'] });
      drawn(THREE.map((message) => ({ ...message, wrappedContentKey: 'wrapped' })));

      const time = summary().querySelector('time');
      expect(time).toHaveAttribute('dateTime', THREE[0]?.createdAt);
      expect(time).toHaveTextContent('Today');
      vi.useRealTimers();
    });
  });

  describe('where the next message goes', () => {
    beforeEach(() => {
      useModelStore.setState({
        activeModality: 'text',
        selections: { text: SELECTED_THREE, image: [], audio: [], video: [] },
      });
    });

    it("says the next message goes to all three while the selection is the turn's models", () => {
      drawn(THREE, MODELS, { canSend: true });

      expect(screen.getByText('Your next message goes to all three')).toBeInTheDocument();
    });

    it('holds whatever order the selection lists the models in', () => {
      useModelStore.setState({
        selections: { text: SELECTED_THREE.toReversed(), image: [], audio: [], video: [] },
      });
      drawn(THREE, MODELS, { canSend: true });

      expect(screen.getByText('Your next message goes to all three')).toBeInTheDocument();
    });

    it('reads a Smart Model reply as Smart Model, the model the turn asked', () => {
      useModelStore.setState({
        selections: {
          text: [
            { id: SMART_MODEL_ID, name: 'Smart Model' },
            { id: GPT_ID, name: 'GPT-5' },
          ],
          image: [],
          audio: [],
          video: [],
        },
      });
      drawn([reply(0, SONNET_ID, { isSmartModel: true }), reply(1, GPT_ID)], MODELS, {
        canSend: true,
      });

      expect(screen.getByText('Your next message goes to both')).toBeInTheDocument();
    });

    it('says both for two models', () => {
      useModelStore.setState({
        selections: { text: SELECTED_THREE.slice(0, 2), image: [], audio: [], video: [] },
      });
      drawn(THREE.slice(0, 2), MODELS, { canSend: true });

      expect(screen.getByText('Your next message goes to both')).toBeInTheDocument();
    });

    it('names five models in words', () => {
      useModelStore.setState({
        selections: { text: SELECTED_FIVE, image: [], audio: [], video: [] },
      });
      drawn(FIVE, FIVE_MODELS, { canSend: true });

      expect(screen.getByText('Your next message goes to all five')).toBeInTheDocument();
    });

    it('names a count past the selectable most in figures', () => {
      const six = [...FIVE, reply(5, SIXTH_ID)];
      useModelStore.setState({
        selections: {
          text: [...SELECTED_FIVE, { id: SIXTH_ID, name: 'Sixth' }],
          image: [],
          audio: [],
          video: [],
        },
      });
      drawn(six, [...FIVE_MODELS, model(SIXTH_ID, 'Sixth', 'Vendor')], { canSend: true });

      expect(screen.getByText('Your next message goes to all 6')).toBeInTheDocument();
    });

    it('says nothing once Continue narrows the selection', async () => {
      drawn(THREE, MODELS, { canSend: true });

      await userEvent.click(within(column(0)).getByTestId(TEST_IDS.continueWithModel));

      expect(screen.queryByText(/Your next message goes to/)).toBeNull();
    });

    it('says nothing while the composer is on another modality', () => {
      useModelStore.setState({ activeModality: 'image' });
      drawn(THREE, MODELS, { canSend: true });

      expect(screen.queryByText(/Your next message goes to/)).toBeNull();
    });

    it('says nothing to a viewer who cannot send', () => {
      drawn(THREE, MODELS, { canSend: false });

      expect(screen.queryByText(/Your next message goes to/)).toBeNull();
    });

    it("says nothing when the catalog offers none of the turn's models", () => {
      drawn(THREE, [], { canSend: true });

      expect(screen.queryByText(/Your next message goes to/)).toBeNull();
    });
  });
});
