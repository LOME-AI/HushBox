import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectCard } from './ProjectCard';
import type { RoadmapNode } from '@hushbox/shared';
import type { FilterType } from './types';

const allTypes = new Set<FilterType>(['feature', 'bug']);

function makeProject(overrides: Partial<RoadmapNode> = {}): RoadmapNode {
  return {
    id: '000000000099',
    kind: 'project',
    parentId: null,
    title: 'Custom System Prompts',
    status: 'in_progress',
    type: null,
    progress: { done: 3, total: 4 },
    ...overrides,
  };
}

function makeTask(overrides: Partial<RoadmapNode> = {}): RoadmapNode {
  return {
    id: '000000000001',
    kind: 'task',
    parentId: '000000000099',
    title: 'Schema design',
    status: 'shipped',
    type: 'feature',
    ...overrides,
  };
}

describe('ProjectCard', () => {
  it('renders the project title', () => {
    const project = makeProject();
    render(<ProjectCard project={project} tasks={[]} activeTypes={allTypes} />);
    expect(screen.getByRole('heading', { name: /Custom System Prompts/i })).toBeInTheDocument();
  });

  it('states the progress in words over the tasks and their subtasks', () => {
    const project = makeProject({ status: 'in_progress' });
    const tasks = [
      {
        task: makeTask({ id: 'a00000000001', status: 'in_progress' as const }),
        subtasks: [
          {
            ...makeTask({ id: 'b00000000001', parentId: 'a00000000001', status: 'planned' }),
            kind: 'subtask' as const,
          },
        ],
      },
      { task: makeTask({ id: 'a00000000002', status: 'in_progress' as const }), subtasks: [] },
    ];
    render(<ProjectCard project={project} tasks={tasks} activeTypes={allTypes} />);
    expect(screen.getByText('2 of 3 in progress')).toBeInTheDocument();
  });

  it('reads the progress from the tasks, not from the API progress field', () => {
    const project = makeProject({ status: 'shipped', progress: { done: 1, total: 4 } });
    const tasks = [{ task: makeTask({ id: 'a00000000001', status: 'shipped' }), subtasks: [] }];
    render(<ProjectCard project={project} tasks={tasks} activeTypes={allTypes} />);
    expect(screen.getByText('All 1 shipped')).toBeInTheDocument();
  });

  it('counts tasks the type filter hides in the progress', () => {
    const project = makeProject({ status: 'shipped' });
    const tasks = [
      { task: makeTask({ id: 'a00000000001', status: 'shipped', type: 'feature' }), subtasks: [] },
      { task: makeTask({ id: 'a00000000002', status: 'planned', type: 'bug' }), subtasks: [] },
    ];
    render(
      <ProjectCard project={project} tasks={tasks} activeTypes={new Set<FilterType>(['feature'])} />
    );
    expect(screen.getByText('1 of 2 shipped')).toBeInTheDocument();
  });

  it('sets the progress words in muted mono', () => {
    render(
      <ProjectCard project={makeProject({ status: 'planned' })} tasks={[]} activeTypes={allTypes} />
    );
    expect(screen.getByText('Not started')).toHaveClass('font-mono', 'text-muted-foreground');
  });

  it('sets the progress words in the small mono role, the size and leading of the kit state line', () => {
    render(
      <ProjectCard project={makeProject({ status: 'planned' })} tasks={[]} activeTypes={allTypes} />
    );
    const state = screen.getByText('Not started');
    expect(state).toHaveClass('text-mono-sm');
    expect(state).not.toHaveClass('text-xs');
  });

  it('sets the title in the site card title role, in ink', () => {
    render(<ProjectCard project={makeProject()} tasks={[]} activeTypes={allTypes} />);
    const title = screen.getByRole('heading', { level: 3, name: 'Custom System Prompts' });
    expect(title).toHaveClass('text-site-card-title', 'font-serif', 'text-foreground');
    expect(title).not.toHaveClass('text-base');
  });

  it('draws no progress bar', () => {
    render(<ProjectCard project={makeProject()} tasks={[]} activeTypes={allTypes} />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('renders the task tree', () => {
    const project = makeProject();
    const tasks = [
      {
        task: makeTask({ id: 'a00000000001', title: 'Schema design' }),
        subtasks: [],
      },
      {
        task: makeTask({
          id: 'a00000000002',
          title: 'Settings UI',
          status: 'in_progress' as const,
        }),
        subtasks: [],
      },
    ];
    render(<ProjectCard project={project} tasks={tasks} activeTypes={allTypes} />);
    const rows = screen.getAllByRole('listitem').map((row) => row.textContent);
    expect(rows).toEqual([
      expect.stringContaining('Schema design'),
      expect.stringContaining('Settings UI'),
    ]);
  });

  it('shows a hidden-by-filter note when a bug task is hidden', () => {
    const project = makeProject();
    const tasks = [
      {
        task: makeTask({ id: 'a00000000001', title: 'Feat A', type: 'feature' as const }),
        subtasks: [],
      },
      {
        task: makeTask({ id: 'a00000000002', title: 'Bug A', type: 'bug' as const }),
        subtasks: [],
      },
    ];
    render(
      <ProjectCard project={project} tasks={tasks} activeTypes={new Set<FilterType>(['feature'])} />
    );
    expect(screen.getByText(/1 bug hidden by filter/i)).toBeInTheDocument();
  });

  it('pluralizes the hidden note ("2 bugs")', () => {
    const project = makeProject();
    const tasks = [
      {
        task: makeTask({ id: 'a00000000001', title: 'Bug 1', type: 'bug' as const }),
        subtasks: [],
      },
      {
        task: makeTask({ id: 'a00000000002', title: 'Bug 2', type: 'bug' as const }),
        subtasks: [],
      },
    ];
    render(
      <ProjectCard project={project} tasks={tasks} activeTypes={new Set<FilterType>(['feature'])} />
    );
    expect(screen.getByText(/2 bugs hidden by filter/i)).toBeInTheDocument();
  });

  it('counts hidden subtasks too', () => {
    const project = makeProject();
    const tasks = [
      {
        task: makeTask({ id: 'a00000000001', title: 'Feat', type: 'feature' as const }),
        subtasks: [
          {
            ...makeTask({ id: 'b00000000001', parentId: 'a00000000001', title: 'Bug sub' }),
            kind: 'subtask' as const,
            type: 'bug' as const,
          },
        ],
      },
    ];
    render(
      <ProjectCard project={project} tasks={tasks} activeTypes={new Set<FilterType>(['feature'])} />
    );
    expect(screen.getByText(/1 bug hidden by filter/i)).toBeInTheDocument();
  });

  it('counts subtasks under hidden parents in the hidden total', () => {
    const project = makeProject();
    const tasks = [
      {
        task: makeTask({ id: 'a00000000001', title: 'Bug parent', type: 'bug' as const }),
        subtasks: [
          {
            ...makeTask({ id: 'b00000000001', parentId: 'a00000000001', title: 'Bug sub' }),
            kind: 'subtask' as const,
            type: 'bug' as const,
          },
        ],
      },
    ];
    render(
      <ProjectCard project={project} tasks={tasks} activeTypes={new Set<FilterType>(['feature'])} />
    );
    expect(screen.getByText(/2 bugs hidden by filter/i)).toBeInTheDocument();
  });

  it('does not show the hidden-by-filter note when nothing is hidden', () => {
    const project = makeProject();
    const tasks = [
      {
        task: makeTask({ id: 'a00000000001', title: 'Feat', type: 'feature' as const }),
        subtasks: [],
      },
    ];
    render(<ProjectCard project={project} tasks={tasks} activeTypes={allTypes} />);
    expect(screen.queryByText(/hidden by filter/i)).not.toBeInTheDocument();
  });

  it('reports a "features hidden" note when features are filtered out', () => {
    const project = makeProject();
    const tasks = [
      {
        task: makeTask({ id: 'a00000000001', title: 'Feat', type: 'feature' as const }),
        subtasks: [],
      },
      { task: makeTask({ id: 'a00000000002', title: 'Bug', type: 'bug' as const }), subtasks: [] },
    ];
    render(
      <ProjectCard project={project} tasks={tasks} activeTypes={new Set<FilterType>(['bug'])} />
    );
    expect(screen.getByText(/1 feature hidden by filter/i)).toBeInTheDocument();
  });

  it('eases the side padding in from 0.75rem at 768 to 1rem at 832', () => {
    const { container } = render(
      <ProjectCard project={makeProject()} tasks={[]} activeTypes={allTypes} />
    );
    expect(container.querySelector('article')).toHaveClass(
      'p-4',
      'md:px-[clamp(0.75rem,calc(0.75rem_+_(100vw_-_768px)_*_0.0664),1rem)]'
    );
  });

  it('tags the card with data-project-id and data-status for E2E selectors', () => {
    const project = makeProject({ id: '000000000099', status: 'in_progress' });
    const { container } = render(
      <ProjectCard project={project} tasks={[]} activeTypes={allTypes} />
    );
    const card = container.querySelector('[data-project-id]');
    expect(card).toHaveAttribute('data-project-id', '000000000099');
    expect(card).toHaveAttribute('data-status', 'in_progress');
  });
});
