import { describe, it, expect, vi, afterEach } from 'vitest';
import { ROUTES } from '@hushbox/shared';

// `bootstrap.tsx` imports `@/routeTree.gen` (the ENTIRE app route tree → every
// page → every component) plus the real React/router/query-provider/chat-hook
// graphs. Loading those in jsdom takes ~75s and blows the 15s testTimeout.
// These tests only exercise the static fallback DOM and the boot try/catch, so
// stub the heavy graphs to bare shapes — the demo-internal collaborators below
// stay real (they're light) so the boot path itself is genuinely executed.
vi.mock('@/routeTree.gen', () => ({ routeTree: {} }));
vi.mock('@/providers/query-provider', () => ({ queryClient: {} }));
vi.mock('@/hooks/chat/chat', () => ({
  chatKeys: { conversation: (id: string) => ['chat', 'conversations', id] },
}));
const createRoot = vi.fn(() => ({ render: vi.fn(), unmount: vi.fn() }));
vi.mock('react-dom/client', () => ({ createRoot: () => createRoot() }));
vi.mock('@tanstack/react-router', () => ({
  RouterProvider: () => null,
  createRouter: vi.fn(() => ({ history: { push: vi.fn() } })),
  createMemoryHistory: vi.fn(() => ({})),
}));

const seedDemoSession = vi.fn(() => ({ accountPublicKey: 'demo-key' }));
vi.mock('./seed-session', () => ({
  seedDemoSession: () => seedDemoSession(),
}));

// The remaining boot collaborators are irrelevant once seeding throws, but they
// must still resolve as modules so the import graph loads.
vi.mock('./mock-backend/fetch-shim', () => ({ installFetchShim: vi.fn() }));
vi.mock('./mock-backend/ws-shim', () => ({
  installWebSocketShim: vi.fn(),
  emitDemoRealtimeEvent: vi.fn(),
}));
vi.mock('./mock-backend/store', () => ({ DemoBackendStore: vi.fn() }));
vi.mock('./director', () => ({ startDirector: vi.fn() }));
vi.mock('./guardrails', () => ({ installGuardrails: vi.fn() }));
vi.mock('./composer-cues', () => ({ installComposerCues: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('renderDemoFallback', () => {
  it('renders a static "Open HushBox" link into the root', async () => {
    const { renderDemoFallback } = await import('./bootstrap');
    const root = document.createElement('div');
    document.body.append(root);

    renderDemoFallback(root);

    const link = root.querySelector('a');
    expect(link?.textContent).toContain('Open HushBox');
    expect(link?.getAttribute('href')).toBe(ROUTES.CHAT);
  });
});

describe('mountDemo boot failure', () => {
  it('renders the static fallback when boot throws instead of leaving a blank iframe', async () => {
    seedDemoSession.mockImplementation(() => {
      throw new Error('seed failed');
    });
    const { mountDemo } = await import('./bootstrap');
    const root = document.createElement('div');
    document.body.append(root);

    expect(() => {
      mountDemo(root);
    }).not.toThrow();
    expect(root.querySelector('a')?.textContent).toContain('Open HushBox');
  });
});
