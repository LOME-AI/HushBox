import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { TEST_IDS } from '@hushbox/shared';
import { PromptInput } from '@/components/chat/input/prompt-input';
import { ChatColumn } from '@/components/chat/layout/chat-column';
import { TypingIndicator } from '../typing-indicator';
import './typing-indicator.css';

/**
 * Real-browser fixture for `typing-indicator.browser.test.ts`: a group member's typing line at
 * the foot of the message column, above the input dock as the chat layout draws it (a hairline
 * and 1rem of padding above the composer), with the real `PromptInput` in the dock, its data
 * hooks stubbed so the context gauge sits on the composer's top edge. The query string sets
 * the text scale (`scale=141`) the way the app's classes do, the theme (`theme=dark`), and
 * `slot=renamed` renames the composer's top-edge slot, the control that shows the line's
 * clearance rests on that slot's name.
 *
 * Test infrastructure, not shipped runtime: it is served to a real browser and never
 * imported by the Node test process, so `apps/web/vitest.config.ts` excludes
 * `src/**\/*-fixture/**` from the coverage gate.
 */

const TOP_EDGE_SLOT = 'composer-top-edge';

const params = new URLSearchParams(globalThis.location.search);
const scale = params.get('scale');
if (scale !== null) document.documentElement.classList.add(`a11y-font-scale-${scale}`);
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark');

interface Measured {
  rootPx: number;
  /** From the typing line's text to the context gauge's top edge. */
  gapPx: number;
}

function boxOf(selector: string): DOMRect {
  const found = document.querySelector(selector);
  if (found === null) throw new Error(`the fixture has no ${selector}`);
  return found.getBoundingClientRect();
}

function measure(): Measured {
  const text = boxOf(`[data-testid="${TEST_IDS.typingIndicator}"] > span`);
  const gauge = boxOf('[role="meter"]');
  return {
    rootPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    gapPx: gauge.top - text.bottom,
  };
}

declare global {
  // Optional: unset until the entry has run, the property the driving test polls to know the
  // fixture page is ready.
  var __typingIndicator: { measure: typeof measure } | undefined;
}

const MEMBERS = [
  { userId: 'u-owner', username: 'alice' },
  { userId: 'u-writer', username: 'ines' },
];

function Conversation(): React.JSX.Element {
  const [value, setValue] = React.useState('');
  return (
    <div className="bg-background text-foreground flex h-dvh flex-col">
      <div className="flex min-h-0 flex-1 flex-col justify-end">
        <TypingIndicator typingUserIds={new Set(['u-writer'])} members={MEMBERS} />
      </div>
      <div className="bg-background flex-shrink-0 border-t py-4">
        <ChatColumn>
          <PromptInput
            value={value}
            onChange={setValue}
            onSubmit={() => undefined}
            isAuthenticated
            activeModality="text"
            onSelectModality={() => undefined}
          />
        </ChatColumn>
      </div>
    </div>
  );
}

const container = document.querySelector('#root');
if (container === null) throw new Error('missing #root');
const reactRoot = createRoot(container);
flushSync(() => {
  reactRoot.render(<Conversation />);
});

if (params.get('slot') === 'renamed') {
  const slot = document.querySelector<HTMLElement>(`[data-slot="${TOP_EDGE_SLOT}"]`);
  if (slot === null) throw new Error(`the fixture has no ${TOP_EDGE_SLOT} slot`);
  slot.dataset['slot'] = `${TOP_EDGE_SLOT}-renamed`;
}

globalThis.__typingIndicator = { measure };
