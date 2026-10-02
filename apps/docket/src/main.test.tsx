import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { renderMock, keepAliveMock } = vi.hoisted(() => ({
  renderMock: vi.fn(),
  keepAliveMock: vi.fn(() => () => {}),
}));

vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: renderMock }) }));
vi.mock('./keep-alive', () => ({ startKeepAlive: keepAliveMock }));

describe('main entry', () => {
  beforeEach(() => {
    renderMock.mockClear();
    keepAliveMock.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.resetModules();
  });

  it('mounts the console into #root', async () => {
    document.body.innerHTML = '<div id="root"></div>';

    await import('./main.js');

    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it('starts the visibility-gated keep-alive ping', async () => {
    document.body.innerHTML = '<div id="root"></div>';

    await import('./main.js');

    expect(keepAliveMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast when #root is missing', async () => {
    document.body.innerHTML = '';

    await expect(import('./main.js')).rejects.toThrow('Root element not found');
  });
});
