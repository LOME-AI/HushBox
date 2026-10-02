import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { RoadmapBoard } from './RoadmapBoard';
import * as queryModule from '../../lib/use-public-query';
import type { RoadmapResponse, RoadmapNode } from '@hushbox/shared';

function makeProject(id: string, overrides: Partial<RoadmapNode> = {}): RoadmapNode {
  return {
    id,
    kind: 'project',
    parentId: null,
    title: `Project ${id}`,
    status: 'in_progress',
    type: null,
    ...overrides,
  };
}

function makeTask(id: string, parentId: string, overrides: Partial<RoadmapNode> = {}): RoadmapNode {
  return {
    id,
    kind: 'task',
    parentId,
    title: `Task ${id}`,
    status: 'in_progress',
    type: 'feature',
    ...overrides,
  };
}

function mockQuery(state: {
  data: RoadmapResponse | null;
  error: Error | null;
  isLoading: boolean;
}): void {
  vi.spyOn(queryModule, 'usePublicQuery').mockReturnValue(state);
}

function renderLoading(): HTMLElement {
  mockQuery({ data: null, error: null, isLoading: true });
  render(<RoadmapBoard />);
  return screen.getByTestId(TEST_IDS.roadmapLoading);
}

describe('RoadmapBoard', () => {
  beforeEach(() => {
    globalThis.history.replaceState(null, '', '/roadmap');
    vi.restoreAllMocks();
  });

  it('renders a loading skeleton while data is loading', () => {
    expect(renderLoading()).toBeInTheDocument();
  });

  it('marks the loading wrapper with data-skeleton and inert', () => {
    const wrapper = renderLoading();
    expect(wrapper).toHaveAttribute('data-skeleton');
    expect(wrapper).toHaveAttribute('inert');
  });

  it('exposes the loading wrapper to assistive tech as a status region', () => {
    const wrapper = renderLoading();
    expect(wrapper).toHaveAttribute('role', 'status');
    expect(wrapper).toHaveAttribute('aria-label', 'Loading roadmap');
    expect(wrapper).toHaveAttribute('aria-busy', 'true');
  });

  it('renders the type filter, the three columns and project cards inside the loading wrapper', () => {
    const wrapper = renderLoading();
    expect(within(wrapper).getByRole('group', { name: 'Type' })).toBeInTheDocument();
    expect(wrapper.querySelectorAll('section[data-status]')).toHaveLength(3);
    expect(wrapper.querySelectorAll('article[data-project-id]').length).toBeGreaterThan(0);
  });

  it('does not mark the loading wrapper with data-roadmap-ready', () => {
    renderLoading();
    expect(document.querySelector('[data-roadmap-ready]')).toBeNull();
  });

  it('renders an error message when the query fails', () => {
    mockQuery({ data: null, error: new Error('boom'), isLoading: false });
    render(<RoadmapBoard />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('offers the type filter with counts over tasks and subtasks', async () => {
    mockQuery({
      data: {
        nodes: [
          makeProject('a00000000001', { status: 'in_progress', title: 'Now-A' }),
          makeTask('b00000000001', 'a00000000001', { type: 'feature' }),
          makeTask('b00000000002', 'a00000000001', { type: 'bug' }),
          makeTask('c00000000001', 'b00000000001', { kind: 'subtask', type: 'feature' }),
        ],
      },
      error: null,
      isLoading: false,
    });
    render(<RoadmapBoard />);
    const group = await screen.findByRole('group', { name: 'Type' });
    expect(
      within(group)
        .getAllByRole('button')
        .map((pill) => pill.textContent)
    ).toEqual(['All3', 'Features2', 'Bugs1']);
  });

  it('renders the Now, Next and Shipped columns in that order', async () => {
    mockQuery({
      data: {
        nodes: [
          makeProject('a00000000001', { status: 'shipped', title: 'Shipped-Z' }),
          makeProject('a00000000002', { status: 'in_progress', title: 'Now-A' }),
          makeProject('a00000000003', { status: 'planned', title: 'Next-A' }),
        ],
      },
      error: null,
      isLoading: false,
    });
    const { container } = render(<RoadmapBoard />);
    await screen.findByRole('heading', { level: 2, name: 'Now' });
    const sections = [...container.querySelectorAll<HTMLElement>('section[data-status]')];
    expect(sections.map((section) => section.dataset['status'])).toEqual([
      'in_progress',
      'planned',
      'shipped',
    ]);
    expect(screen.getAllByRole('heading', { level: 2 }).map((head) => head.textContent)).toEqual([
      'Now',
      'Next',
      'Shipped',
    ]);
  });

  it('keeps a column whose status has no projects', async () => {
    mockQuery({
      data: { nodes: [makeProject('a00000000001', { status: 'in_progress' })] },
      error: null,
      isLoading: false,
    });
    render(<RoadmapBoard />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Shipped' })).toBeInTheDocument();
  });

  it('lays the columns side by side from 768 and stacks them on phones', async () => {
    mockQuery({
      data: { nodes: [makeProject('a00000000001')] },
      error: null,
      isLoading: false,
    });
    const { container } = render(<RoadmapBoard />);
    await screen.findByRole('heading', { level: 2, name: 'Now' });
    const grid = container.querySelector('section[data-status]')?.parentElement;
    expect(grid).toHaveClass('grid', 'gap-8', 'md:grid-cols-3');
    expect(grid).not.toHaveClass('grid-cols-3');
  });

  it('eases the column gap in from 0.75rem at 768 to 1.25rem at 832', async () => {
    mockQuery({
      data: { nodes: [makeProject('a00000000001')] },
      error: null,
      isLoading: false,
    });
    const { container } = render(<RoadmapBoard />);
    await screen.findByRole('heading', { level: 2, name: 'Now' });
    const grid = container.querySelector('section[data-status]')?.parentElement;
    expect(grid).toHaveClass(
      'md:gap-[clamp(0.75rem,calc(0.75rem_+_(100vw_-_768px)_*_0.1328),1.25rem)]'
    );
  });

  it('shows every column whatever an old status parameter asks for', async () => {
    mockQuery({
      data: { nodes: [makeProject('a00000000001', { status: 'in_progress' })] },
      error: null,
      isLoading: false,
    });
    globalThis.history.replaceState(null, '', '/roadmap?status=shipped');
    const { container } = render(<RoadmapBoard />);
    await screen.findByRole('heading', { level: 2, name: 'Now' });
    expect(container.querySelectorAll('section[data-status]')).toHaveLength(3);
  });

  it('hides the bugs and notes them when Features is chosen', async () => {
    const user = userEvent.setup();
    mockQuery({
      data: {
        nodes: [
          makeProject('a00000000001'),
          makeTask('b00000000001', 'a00000000001', { type: 'feature', title: 'Feature task' }),
          makeTask('b00000000002', 'a00000000001', { type: 'bug', title: 'Bug task' }),
        ],
      },
      error: null,
      isLoading: false,
    });
    render(<RoadmapBoard />);
    await user.click(await screen.findByRole('button', { name: /^Features/ }));
    const rows = screen.getAllByRole('listitem').map((row) => row.textContent);
    expect(rows).toEqual([expect.stringContaining('Feature task')]);
    expect(screen.getByText(/1 bug hidden by filter/)).toBeInTheDocument();
  });

  it('writes the chosen type to the URL', async () => {
    const user = userEvent.setup();
    mockQuery({
      data: { nodes: [makeProject('a00000000001')] },
      error: null,
      isLoading: false,
    });
    render(<RoadmapBoard />);
    await user.click(await screen.findByRole('button', { name: /^Bugs/ }));
    expect(screen.getByRole('button', { name: /^Bugs/ })).toHaveAttribute('aria-pressed', 'true');
    expect(globalThis.location.search).toBe('?type=bug');
  });

  it('starts on the type the URL names', async () => {
    mockQuery({
      data: { nodes: [makeProject('a00000000001')] },
      error: null,
      isLoading: false,
    });
    globalThis.history.replaceState(null, '', '/roadmap?type=feature');
    render(<RoadmapBoard />);
    expect(await screen.findByRole('button', { name: /^Features/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('shows no empty state and no reset control', async () => {
    mockQuery({
      data: { nodes: [makeProject('a00000000001')] },
      error: null,
      isLoading: false,
    });
    render(<RoadmapBoard />);
    await screen.findByRole('heading', { level: 2, name: 'Now' });
    expect(screen.queryByRole('button', { name: /reset filters/i })).not.toBeInTheDocument();
  });

  it('renders the project cards for the loaded data', async () => {
    mockQuery({
      data: {
        nodes: [
          makeProject('a00000000001', { status: 'in_progress', title: 'Custom Prompts' }),
          makeTask('b00000000001', 'a00000000001', { title: 'Schema design' }),
        ],
      },
      error: null,
      isLoading: false,
    });
    render(<RoadmapBoard />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Custom Prompts/i })).toBeInTheDocument();
      expect(screen.getByRole('listitem')).toHaveTextContent('Schema design');
    });
  });

  it('marks the loaded board with a data-roadmap-ready attribute', async () => {
    mockQuery({
      data: { nodes: [makeProject('a00000000001')] },
      error: null,
      isLoading: false,
    });
    const { container } = render(<RoadmapBoard />);
    await waitFor(() => {
      expect(container.querySelector('[data-roadmap-ready]')).not.toBeNull();
    });
  });

  it('fetches /public/roadmap and renders the schema-validated payload', async () => {
    let requestedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) => {
        requestedUrl = String(url);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              nodes: [makeProject('a00000000001', { title: 'Wired Project' })],
            }),
        });
      })
    );
    render(<RoadmapBoard />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Wired Project/i })).toBeInTheDocument();
    });
    expect(requestedUrl).toContain('/public/roadmap');
    vi.unstubAllGlobals();
  });
});
