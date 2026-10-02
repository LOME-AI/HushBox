import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskTree, type TaskWithSubtasks } from './TaskTree';
import type { RoadmapNode } from '@hushbox/shared';

type FilterType = NonNullable<RoadmapNode['type']>;

const allTypes = new Set<FilterType>(['feature', 'bug']);

function isRowWithTitle(title: string): (content: string, element: Element | null) => boolean {
  return (_content, element) => element?.tagName === 'LI' && element.textContent.includes(title);
}

function rowFor(title: string): HTMLElement {
  return screen.getByText(isRowWithTitle(title));
}

function queryRowFor(title: string): HTMLElement | null {
  return screen.queryByText(isRowWithTitle(title));
}

function makeTask(overrides: Partial<RoadmapNode> = {}): RoadmapNode {
  return {
    id: '000000000001',
    kind: 'task',
    parentId: '000000000099',
    title: 'A task',
    status: 'in_progress',
    type: 'feature',
    ...overrides,
  };
}

function makeSubtask(overrides: Partial<RoadmapNode>): RoadmapNode {
  return makeTask({ kind: 'subtask', ...overrides });
}

describe('TaskTree', () => {
  it('renders one row per task with its title', () => {
    const tasks: TaskWithSubtasks[] = [
      { task: makeTask({ id: 'a00000000001', title: 'Schema design' }), subtasks: [] },
      { task: makeTask({ id: 'a00000000002', title: 'Settings UI' }), subtasks: [] },
    ];
    render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    expect(rowFor('Schema design')).toBeInTheDocument();
    expect(rowFor('Settings UI')).toBeInTheDocument();
  });

  it('renders subtasks under their parent task', () => {
    const tasks: TaskWithSubtasks[] = [
      {
        task: makeTask({ id: 'a00000000001', title: 'Cross-device sync' }),
        subtasks: [
          makeSubtask({
            id: 'b00000000001',
            parentId: 'a00000000001',
            title: 'Conflict resolution',
          }),
          makeSubtask({
            id: 'b00000000002',
            parentId: 'a00000000001',
            title: 'Migration backfill',
          }),
        ],
      },
    ];
    render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    expect(rowFor('Cross-device sync')).toBeInTheDocument();
    expect(rowFor('Conflict resolution')).toBeInTheDocument();
    expect(rowFor('Migration backfill')).toBeInTheDocument();
  });

  it('hides tasks whose type is not in activeTypes', () => {
    const tasks: TaskWithSubtasks[] = [
      {
        task: makeTask({ id: 'a00000000001', title: 'Schema feature', type: 'feature' }),
        subtasks: [],
      },
      { task: makeTask({ id: 'a00000000002', title: 'Schema bug', type: 'bug' }), subtasks: [] },
    ];
    render(<TaskTree tasks={tasks} activeTypes={new Set<FilterType>(['feature'])} />);
    expect(rowFor('Schema feature')).toBeInTheDocument();
    expect(queryRowFor('Schema bug')).not.toBeInTheDocument();
  });

  it('hides a subtask whose type is not in activeTypes (parent visible)', () => {
    const tasks: TaskWithSubtasks[] = [
      {
        task: makeTask({ id: 'a00000000001', title: 'Cross-device sync', type: 'feature' }),
        subtasks: [
          makeSubtask({
            id: 'b00000000001',
            parentId: 'a00000000001',
            title: 'Migration bug',
            type: 'bug',
          }),
        ],
      },
    ];
    render(<TaskTree tasks={tasks} activeTypes={new Set<FilterType>(['feature'])} />);
    expect(rowFor('Cross-device sync')).toBeInTheDocument();
    expect(queryRowFor('Migration bug')).not.toBeInTheDocument();
  });

  it('hides subtasks when their parent task is hidden (hierarchy wins)', () => {
    const tasks: TaskWithSubtasks[] = [
      {
        task: makeTask({ id: 'a00000000001', title: 'A bug task', type: 'bug' }),
        subtasks: [
          makeSubtask({
            id: 'b00000000001',
            parentId: 'a00000000001',
            title: 'Feature subtask',
            type: 'feature',
          }),
        ],
      },
    ];
    render(<TaskTree tasks={tasks} activeTypes={new Set<FilterType>(['feature'])} />);
    expect(queryRowFor('A bug task')).not.toBeInTheDocument();
    expect(queryRowFor('Feature subtask')).not.toBeInTheDocument();
  });

  it('shows a status icon for each visible task', () => {
    const tasks: TaskWithSubtasks[] = [
      { task: makeTask({ id: 'a00000000001', title: 'Done', status: 'shipped' }), subtasks: [] },
      { task: makeTask({ id: 'a00000000002', title: 'WIP', status: 'in_progress' }), subtasks: [] },
      { task: makeTask({ id: 'a00000000003', title: 'Plan', status: 'planned' }), subtasks: [] },
    ];
    render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    expect(rowFor('Done')).toHaveAttribute('data-status', 'shipped');
    expect(rowFor('WIP')).toHaveAttribute('data-status', 'in_progress');
    expect(rowFor('Plan')).toHaveAttribute('data-status', 'planned');
  });

  it('marks tasks with their type via data-type', () => {
    const tasks: TaskWithSubtasks[] = [
      {
        task: makeTask({ id: 'a00000000001', title: 'A feature task', type: 'feature' }),
        subtasks: [],
      },
      { task: makeTask({ id: 'a00000000002', title: 'A bug task', type: 'bug' }), subtasks: [] },
    ];
    render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    expect(rowFor('A feature task')).toHaveAttribute('data-type', 'feature');
    expect(rowFor('A bug task')).toHaveAttribute('data-type', 'bug');
  });

  it('renders subtask rows with data-kind="subtask" for styling', () => {
    const tasks: TaskWithSubtasks[] = [
      {
        task: makeTask({ id: 'a00000000001', title: 'Parent' }),
        subtasks: [makeSubtask({ id: 'b00000000001', parentId: 'a00000000001', title: 'Child' })],
      },
    ];
    render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    expect(rowFor('Parent')).toHaveAttribute('data-kind', 'task');
    expect(rowFor('Child')).toHaveAttribute('data-kind', 'subtask');
  });

  it('always shows a typeless task and renders no type badge for it', () => {
    const tasks: TaskWithSubtasks[] = [
      {
        task: makeTask({ id: 'a00000000001', title: 'Untyped milestone', type: null }),
        subtasks: [],
      },
    ];
    render(<TaskTree tasks={tasks} activeTypes={new Set<FilterType>(['feature'])} />);
    const row = rowFor('Untyped milestone');
    // A null-type node bypasses the type filter (hierarchy/section headers
    // stay visible) and carries no data-type / badge.
    expect(row).toBeInTheDocument();
    expect(row).not.toHaveAttribute('data-type');
    expect(screen.queryByText('Feature')).not.toBeInTheDocument();
    expect(screen.queryByText('Bug')).not.toBeInTheDocument();
  });

  it('renders an empty list element when every task is filtered out', () => {
    const tasks: TaskWithSubtasks[] = [
      { task: makeTask({ id: 'a00000000001', title: 'Bug-only', type: 'bug' }), subtasks: [] },
    ];
    const { container } = render(
      <TaskTree tasks={tasks} activeTypes={new Set<FilterType>(['feature'])} />
    );
    // The component renders no <li> elements when nothing is visible.
    expect(container.querySelectorAll('li')).toHaveLength(0);
  });

  it.each([
    ['in_progress', 'lucide-rotate-cw', 'text-primary'],
    ['planned', 'lucide-circle', 'text-info'],
    ['shipped', 'lucide-circle-check', 'text-success'],
  ] as const)('draws the %s status as the %s icon in its colour', (status, iconClass, colour) => {
    const tasks: TaskWithSubtasks[] = [{ task: makeTask({ status }), subtasks: [] }];
    const { container } = render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    const svg = container.querySelector('li svg');
    expect(svg).toHaveClass(iconClass);
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg?.parentElement).toHaveClass(colour);
  });

  it.each([
    ['in_progress', 'In progress:'],
    ['planned', 'Planned:'],
    ['shipped', 'Shipped:'],
  ] as const)('prefixes a %s row with "%s" for screen readers', (status, prefix) => {
    const tasks: TaskWithSubtasks[] = [
      { task: makeTask({ status, title: 'Group chat presence indicators' }), subtasks: [] },
    ];
    const { container } = render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    const hidden = screen.getByText(prefix);
    expect(hidden).toHaveClass('sr-only');
    expect(container.querySelector('li')?.textContent).toMatch(
      new RegExp(`^${prefix}Group chat presence indicators`)
    );
  });

  it('sets every row in the snug ui role, the kit task row’s size and leading', () => {
    const tasks: TaskWithSubtasks[] = [
      {
        task: makeTask({ id: 'a00000000001', title: 'Parent' }),
        subtasks: [makeSubtask({ id: 'b00000000001', parentId: 'a00000000001', title: 'Child' })],
      },
    ];
    const { container } = render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    for (const row of container.querySelectorAll('li')) {
      expect(row).toHaveClass('text-ui-snug');
      expect(row).not.toHaveClass('text-sm');
    }
  });

  it("keeps the status icon on the title's first line rather than centring it", () => {
    const tasks: TaskWithSubtasks[] = [{ task: makeTask(), subtasks: [] }];
    const { container } = render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    expect(container.querySelector('li')).toHaveClass('items-start');
    expect(container.querySelector('li')).not.toHaveClass('items-center');
  });

  it('binds the last word of the title and the type badge in one unbreakable group', () => {
    const tasks: TaskWithSubtasks[] = [
      { task: makeTask({ title: 'Save and reuse prompt presets', type: 'feature' }), subtasks: [] },
    ];
    render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    const group = screen.getByText('Feature').closest('.max-w-full');
    expect(group).toHaveClass('inline-flex');
    expect(group?.textContent).toBe('presets Feature');
    expect(group?.parentElement?.firstChild?.textContent).toBe('Save and reuse prompt ');
  });

  it('drops the badge under its word only when the pair is wider than a whole line', () => {
    const tasks: TaskWithSubtasks[] = [{ task: makeTask({ type: 'feature' }), subtasks: [] }];
    render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    const badgeBox = screen.getByText('Feature').parentElement;
    const group = screen.getByText('Feature').closest('.max-w-full');
    expect(group).toHaveClass('inline-flex');
    expect(group).not.toHaveClass('whitespace-nowrap');
    expect(badgeBox?.parentElement).not.toHaveClass('whitespace-nowrap');
  });

  it('spaces the badge from its word with a real space and a quarter rem, as the reference does', () => {
    const tasks: TaskWithSubtasks[] = [
      { task: makeTask({ title: 'Save and reuse prompt presets', type: 'feature' }), subtasks: [] },
    ];
    render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    const badgeBox = screen.getByText('Feature').parentElement;
    expect(badgeBox).toHaveClass('ml-1');
    expect(badgeBox?.previousSibling?.textContent).toBe(' ');
    expect(badgeBox?.parentElement?.firstChild?.textContent).toBe('presets');
    const group = screen.getByText('Feature').closest('.max-w-full');
    expect([...(group?.classList ?? [])].filter((token) => token.startsWith('gap'))).toEqual([]);
  });

  it('breaks a last word that is wider than a whole line rather than overflowing', () => {
    const tasks: TaskWithSubtasks[] = [
      { task: makeTask({ title: 'Internationalisation', type: 'bug' }), subtasks: [] },
    ];
    render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    expect(screen.getByText('Internationalisation')).toHaveClass('min-w-0', 'wrap-anywhere');
  });

  it('breaks any other word that is wider than a whole line', () => {
    const tasks: TaskWithSubtasks[] = [
      { task: makeTask({ title: 'Untyped milestone', type: null }), subtasks: [] },
    ];
    render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    expect(screen.getByText('Untyped milestone')).toHaveClass('wrap-break-word');
  });

  it('binds a one-word title whole to its badge', () => {
    const tasks: TaskWithSubtasks[] = [
      { task: makeTask({ title: 'Typing', type: 'bug' }), subtasks: [] },
    ];
    render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    expect(screen.getByText('Bug').parentElement?.parentElement?.textContent).toBe('Typing Bug');
  });

  it('lets the title wrap instead of truncating it', () => {
    const tasks: TaskWithSubtasks[] = [
      { task: makeTask({ title: 'Fix preset deletion not clearing local state' }), subtasks: [] },
    ];
    const { container } = render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    expect(container.querySelector('.truncate')).toBeNull();
    expect(container.querySelector('li')?.textContent).toContain(
      'Fix preset deletion not clearing local state'
    );
  });

  it('shows a feature as a neutral badge', () => {
    const tasks: TaskWithSubtasks[] = [{ task: makeTask({ type: 'feature' }), subtasks: [] }];
    render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    const badge = screen.getByText('Feature');
    expect(badge).toHaveAttribute('data-slot', 'badge');
    expect(badge).toHaveClass('bg-muted', 'text-muted-foreground');
  });

  it('shows a bug as a warning badge', () => {
    const tasks: TaskWithSubtasks[] = [{ task: makeTask({ type: 'bug' }), subtasks: [] }];
    render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    const badge = screen.getByText('Bug');
    expect(badge).toHaveAttribute('data-slot', 'badge');
    expect(badge).toHaveClass('bg-warning/12', 'text-warning-text');
  });

  it('sets the badge at the compact size', () => {
    const tasks: TaskWithSubtasks[] = [{ task: makeTask({ type: 'bug' }), subtasks: [] }];
    render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    expect(screen.getByText('Bug')).toHaveClass('uppercase', 'text-[0.625rem]', 'font-semibold');
  });

  it('raises the badge a twentieth of a rem off the word’s baseline, as the reference does', () => {
    const tasks: TaskWithSubtasks[] = [{ task: makeTask({ type: 'feature' }), subtasks: [] }];
    render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    expect(screen.getByText('Feature').parentElement).toHaveClass('align-[0.05rem]');
  });

  it('keeps the badge’s own height when it drops under its word', () => {
    const tasks: TaskWithSubtasks[] = [{ task: makeTask({ type: 'feature' }), subtasks: [] }];
    render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    expect(screen.getByText('Feature').parentElement).toHaveClass('inline-flex');
  });

  it('styles the badge only through its own props, never from the row', () => {
    const tasks: TaskWithSubtasks[] = [{ task: makeTask({ type: 'feature' }), subtasks: [] }];
    const { container } = render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    const reachIn = [...container.querySelectorAll('*')].flatMap((element) =>
      [...element.classList].filter((token) => token.includes('data-slot=badge'))
    );
    expect(reachIn).toEqual([]);
  });

  it('indents a subtask on a hairline in muted text', () => {
    const tasks: TaskWithSubtasks[] = [
      {
        task: makeTask({ id: 'a00000000001', title: 'Parent' }),
        subtasks: [makeSubtask({ id: 'b00000000001', parentId: 'a00000000001', title: 'Child' })],
      },
    ];
    const { container } = render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    const [parent, child] = container.querySelectorAll('li');
    expect(child).toHaveClass(
      'ml-2',
      'pl-2.5',
      'border-l',
      'border-border',
      'text-muted-foreground'
    );
    expect(parent).not.toHaveClass('border-l');
    expect(parent).not.toHaveClass('text-muted-foreground');
  });
});
