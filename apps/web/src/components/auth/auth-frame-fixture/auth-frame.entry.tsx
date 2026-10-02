import { createRoot } from 'react-dom/client';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { TEST_IDS } from '@hushbox/shared';
import { Route as AuthRoute } from '@/routes/_auth';
import { ThemeProvider } from '@/providers/theme-provider';
import './auth-frame.css';

/**
 * Real-browser fixture for `auth-frame.browser.test.ts`. Mounts the auth route's own
 * layout component under a router and the theme provider, and exposes the geometry the
 * test asserts: whether the wall shows, the two columns' widths, and the form column's
 * padding.
 *
 * Test infrastructure, not shipped runtime, and not exempted from lint: it is served to a
 * real browser and never imported by the Node test process, so V8 coverage cannot observe
 * it executing; `apps/web/vitest.config.ts` excludes `src/**\/*-fixture/**` from the
 * coverage gate for that reason.
 */

const AuthFrame = AuthRoute.options.component;
if (AuthFrame === undefined) throw new Error('the auth route has no layout component');
const Frame = AuthFrame;

function requireElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`missing element ${selector}`);
  return element;
}

interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface FrameReading {
  coarse: boolean;
  rootPx: number;
  frameWidth: number;
  wallShown: boolean;
  formWidth: number;
  wallWidth: number;
  formPadding: Padding;
}

function columns(): { form: HTMLElement; wall: HTMLElement } {
  const frame = requireElement(`[data-testid="${TEST_IDS.authLayout}"]`);
  const [form, wall] = frame.children;
  if (!(form instanceof HTMLElement) || !(wall instanceof HTMLElement)) {
    throw new TypeError('the auth frame lacks its form and wall columns');
  }
  return { form, wall };
}

function read(): FrameReading {
  const frame = requireElement(`[data-testid="${TEST_IDS.authLayout}"]`);
  const { form, wall } = columns();
  const canvas = wall.querySelector(`[data-testid="${TEST_IDS.cipherWall}"]`);
  const padding = getComputedStyle(form);
  const wallRect = wall.getBoundingClientRect();
  return {
    coarse: globalThis.matchMedia('(pointer: coarse)').matches,
    rootPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    frameWidth: frame.getBoundingClientRect().width,
    wallShown:
      canvas !== null &&
      getComputedStyle(wall).display !== 'none' &&
      wallRect.width > 0 &&
      wallRect.height > 0,
    formWidth: form.getBoundingClientRect().width,
    wallWidth: wallRect.width,
    formPadding: {
      top: Number.parseFloat(padding.paddingTop),
      right: Number.parseFloat(padding.paddingRight),
      bottom: Number.parseFloat(padding.paddingBottom),
      left: Number.parseFloat(padding.paddingLeft),
    },
  };
}

declare global {
  // Optional: unset until the frame has mounted — the property the driving test polls to
  // know the fixture page is ready.
  var __authFrame: { read(): FrameReading } | undefined;
}

function FixtureRoot(): React.JSX.Element {
  return (
    <ThemeProvider>
      <Frame />
    </ThemeProvider>
  );
}

const router = createRouter({
  routeTree: createRootRoute({ component: FixtureRoot }),
  history: createMemoryHistory({ initialEntries: ['/'] }),
});

createRoot(requireElement('#root')).render(<RouterProvider router={router} />);

const observer = new MutationObserver(() => {
  if (document.querySelector(`[data-testid="${TEST_IDS.authLayout}"]`) === null) return;
  observer.disconnect();
  globalThis.__authFrame = { read };
});
observer.observe(document.body, { childList: true, subtree: true });
