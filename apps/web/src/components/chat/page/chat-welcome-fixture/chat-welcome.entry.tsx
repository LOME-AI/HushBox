import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { TEST_IDS } from '@hushbox/shared';
import { ChatWelcome } from '@/components/chat/page/chat-welcome';
import { useAuthStore } from '@/lib/auth/auth';
import { resetCatalog, resolveCatalog } from './catalog-stub';
import { resetConversations, resolveConversations } from './conversations-stub';
import './chat-welcome.css';
import type { PromptPredictor } from '@/lib/prediction/predictor';

/**
 * Real-browser fixture for `chat-welcome.browser.test.ts`. It mounts the real new chat page
 * in a stand-in for the app shell (an optional 18rem docked sidebar, the header's height,
 * then the page region) and reads back where its blocks sit. What loads after first paint
 * is under the test's control: the catalog, the conversation list, and the predictor's
 * candidates, each answered when the test says so.
 *
 * Test infrastructure, not shipped runtime, and not exempted from lint: it is served to a
 * real browser and never imported by the Node test process, so V8 coverage cannot observe
 * it executing; `apps/web/vitest.config.ts` excludes `src/**\/*-fixture/**` from the
 * coverage gate for that reason.
 */

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface WelcomeReading {
  /** Whether the page matched `pointer: coarse`, so a touch reading measured the touch layout. */
  coarse: boolean;
  scroller: Box;
  scrollTop: number;
  composer: Box;
  modelChip: Box;
  /** The candidate list's block under the composer; absent where the page draws none. */
  candidateList: Box | null;
  candidateRows: number;
  suggestions: Box;
  continueShown: boolean;
  modelInfoShown: boolean;
}

interface MountOptions {
  signedIn: boolean;
  /** Docks an 18rem sidebar beside the page, as the app does from 768. */
  sidebar: boolean;
}

declare global {
  // Optional: unset until the entry has run — the property the driving test polls to know
  // the fixture page is ready.
  var __chatWelcome:
    | {
        mount(options: MountOptions): void;
        resolveCatalog(): void;
        resolveConversations(): void;
        /** Answers the predictor's request in flight with this many rival continuations. */
        answerCandidates(count: number): void;
        read(): WelcomeReading;
      }
    | undefined;
}

/** The inline hint; its trailing stop keeps its last word from being dropped as unfinished. */
const COMPLETION = ' the quiet harbour at dawn.';
const ALTERNATIVES = [
  ' the morning rain on slate.',
  ' a winter forest at noon.',
  ' an old lighthouse keeper.',
  ' the city after midnight.',
] as const;

let answer: ((count: number) => void) | undefined;

/**
 * Inlines its completion at once and holds the rival continuations until the test answers
 * them, so the composer reads the same with the list closed and open.
 */
const predictor: PromptPredictor = {
  predict(_text, signal, onCompletion) {
    onCompletion(COMPLETION);
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(new Error('aborted'));
      });
      answer = (count) => {
        resolve({ completion: COMPLETION, alternatives: ALTERNATIVES.slice(0, count) });
      };
    });
  },
};

function boxOf(element: Element): Box {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
}

function requireElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`the fixture has no ${selector}`);
  return element;
}

function read(): WelcomeReading {
  const welcome = requireElement(`[data-testid="${TEST_IDS.chatWelcome}"]`);
  const scroller = welcome.lastElementChild;
  if (scroller === null) throw new Error('the new chat page has no scroller');
  const candidateList = document.querySelector('[data-slot="prediction-suggestion-list"]');
  return {
    coarse: matchMedia('(pointer: coarse)').matches,
    scroller: boxOf(scroller),
    scrollTop: scroller.scrollTop,
    composer: boxOf(requireElement('[data-slot="composer"]')),
    modelChip: boxOf(requireElement(`[data-testid="${TEST_IDS.modelSelectorButton}"]`)),
    candidateList: candidateList === null ? null : boxOf(candidateList),
    candidateRows: document.querySelectorAll('[data-slot="prediction-suggestion-row"]').length,
    suggestions: boxOf(requireElement(`[data-testid="${TEST_IDS.suggestionChips}"]`)),
    continueShown: document.querySelector(`[data-testid="${TEST_IDS.continueList}"]`) !== null,
    modelInfoShown:
      document.querySelector(`[data-testid="${TEST_IDS.modelInfo}"]:not([aria-hidden="true"])`) !==
      null,
  };
}

function ShellStandIn({ options }: Readonly<{ options: MountOptions }>): React.JSX.Element {
  return (
    <div className="flex h-dvh">
      {options.sidebar ? <aside className="border-border w-72 shrink-0 border-r" /> : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-[var(--app-header-height)] shrink-0 border-b" />
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-full flex-col">
            <ChatWelcome
              onSend={() => undefined}
              isAuthenticated={options.signedIn}
              predictor={predictor}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

let root: Root | undefined;

function mount(options: MountOptions): void {
  root?.unmount();
  resetCatalog();
  resetConversations();
  useAuthStore.getState().setUser(
    options.signedIn
      ? {
          id: 'fixture-user',
          email: 'fixture@hushbox.ai',
          username: 'fixture',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: true,
        }
      : null
  );
  useAuthStore.getState().setLoading(false);
  const rootRoute = createRootRoute({ component: () => <ShellStandIn options={options} /> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  root = createRoot(requireElement('#root'));
  root.render(<RouterProvider router={router} />);
}

globalThis.__chatWelcome = {
  mount,
  resolveCatalog,
  resolveConversations,
  answerCandidates(count) {
    if (answer === undefined) throw new Error('no prediction is in flight');
    answer(count);
  },
  read,
};
