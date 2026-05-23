import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectCard } from './ProjectCard';
import type { RoadmapNode } from '@hushbox/shared';
import type { FilterType } from './use-filter-state';

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

  it('renders the progress bar with the project progress numbers', () => {
    const project = makeProject({ progress: { done: 3, total: 4 } });
    render(<ProjectCard project={project} tasks={[]} activeTypes={allTypes} />);
    expect(screen.getByText(/3 of 4 done/i)).toBeInTheDocument();
    expect(screen.getByText(/75%/)).toBeInTheDocument();
  });

  it('falls back to 0/0 when the project has no progress field (defensive)', () => {
    const project = makeProject();
    delete project.progress;
    render(<ProjectCard project={project} tasks={[]} activeTypes={allTypes} />);
    expect(screen.getByText(/0 of 0 done/i)).toBeInTheDocument();
  });

  it('renders the task tree', () => {
    const project = makeProject();
    const tasks = [
      {
        task: makeTask({ id: 'a00000000001', title: 'Schema design' }),
        subtasks: [],
      },
      {
        task: makeTask({ id: 'a00000000002', title: 'Settings UI', status: 'in_progress' as const }),
        subtasks: [],
      },
    ];
    render(<ProjectCard project={project} tasks={tasks} activeTypes={allTypes} />);
    expect(screen.getByText('Schema design')).toBeInTheDocument();
    expect(screen.getByText('Settings UI')).toBeInTheDocument();
  });

  it('shows a hidden-by-filter note when a bug task is hidden', () => {
    const project = makeProject();
    const tasks = [
      { task: makeTask({ id: 'a00000000001', title: 'Feat A', type: 'feature' as const }), subtasks: [] },
      { task: makeTask({ id: 'a00000000002', title: 'Bug A', type: 'bug' as const }), subtasks: [] },
    ];
    render(
      <ProjectCard
        project={project}
        tasks={tasks}
        activeTypes={new Set<FilterType>(['feature'])}
      />
    );
    expect(screen.getByText(/1 bug hidden by filter/i)).toBeInTheDocument();
  });

  it('pluralizes the hidden note ("2 bugs")', () => {
    const project = makeProject();
    const tasks = [
      { task: makeTask({ id: 'a00000000001', title: 'Bug 1', type: 'bug' as const }), subtasks: [] },
      { task: makeTask({ id: 'a00000000002', title: 'Bug 2', type: 'bug' as const }), subtasks: [] },
    ];
    render(
      <ProjectCard
        project={project}
        tasks={tasks}
        activeTypes={new Set<FilterType>(['feature'])}
      />
    );
    expect(screen.getByText(/2 bugs hidden by filter/i)).toBeInTheDocument();
  });

  it('counts hidden subtasks too', () => {
    const project = makeProject();
    const tasks = [
      {
        task: makeTask({ id: 'a00000000001', title: 'Feat', type: 'feature' as const }),
        subtasks: [
          { ...makeTask({ id: 'b00000000001', parentId: 'a00000000001', title: 'Bug sub' }), kind: 'subtask' as const, type: 'bug' as const },
        ],
      },
    ];
    render(
      <ProjectCard
        project={project}
        tasks={tasks}
        activeTypes={new Set<FilterType>(['feature'])}
      />
    );
    expect(screen.getByText(/1 bug hidden by filter/i)).toBeInTheDocument();
  });

  it('counts subtasks under hidden parents in the hidden total', () => {
    const project = makeProject();
    const tasks = [
      {
        task: makeTask({ id: 'a00000000001', title: 'Bug parent', type: 'bug' as const }),
        subtasks: [
          { ...makeTask({ id: 'b00000000001', parentId: 'a00000000001', title: 'Bug sub' }), kind: 'subtask' as const, type: 'bug' as const },
        ],
      },
    ];
    render(
      <ProjectCard
        project={project}
        tasks={tasks}
        activeTypes={new Set<FilterType>(['feature'])}
      />
    );
    expect(screen.getByText(/2 bugs hidden by filter/i)).toBeInTheDocument();
  });

  it('does not show the hidden-by-filter note when nothing is hidden', () => {
    const project = makeProject();
    const tasks = [
      { task: makeTask({ id: 'a00000000001', title: 'Feat', type: 'feature' as const }), subtasks: [] },
    ];
    render(<ProjectCard project={project} tasks={tasks} activeTypes={allTypes} />);
    expect(screen.queryByText(/hidden by filter/i)).not.toBeInTheDocument();
  });

  it('reports a "features hidden" note when features are filtered out', () => {
    const project = makeProject();
    const tasks = [
      { task: makeTask({ id: 'a00000000001', title: 'Feat', type: 'feature' as const }), subtasks: [] },
      { task: makeTask({ id: 'a00000000002', title: 'Bug', type: 'bug' as const }), subtasks: [] },
    ];
    render(
      <ProjectCard
        project={project}
        tasks={tasks}
        activeTypes={new Set<FilterType>(['bug'])}
      />
    );
    expect(screen.getByText(/1 feature hidden by filter/i)).toBeInTheDocument();
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
