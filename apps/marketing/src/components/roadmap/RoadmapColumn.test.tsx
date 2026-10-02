import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RoadmapColumn } from './RoadmapColumn';
import type { RoadmapNode } from '@hushbox/shared';
import type { FilterType, ProjectWithTasks, RoadmapStatus } from './types';

const allTypes: ReadonlySet<FilterType> = new Set<FilterType>(['feature', 'bug']);

function makeProject(overrides: Partial<RoadmapNode> = {}): RoadmapNode {
  return {
    id: '000000000099',
    kind: 'project',
    parentId: null,
    title: 'A project',
    status: 'in_progress',
    type: null,
    ...overrides,
  };
}

function renderColumn(
  status: RoadmapStatus,
  projects: readonly ProjectWithTasks[]
): ReturnType<typeof render> {
  return render(<RoadmapColumn status={status} projects={projects} activeTypes={allTypes} />);
}

const two: readonly ProjectWithTasks[] = [
  { project: makeProject({ id: 'a00000000001', title: 'A' }), tasks: [] },
  { project: makeProject({ id: 'a00000000002', title: 'B' }), tasks: [] },
];

describe('RoadmapColumn', () => {
  it.each<[RoadmapStatus, string]>([
    ['in_progress', 'Now'],
    ['planned', 'Next'],
    ['shipped', 'Shipped'],
  ])('heads the %s column with %s at level 2', (status, name) => {
    renderColumn(status, two);
    expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
  });

  it('sets the head in the title-2 role, in the signal red', () => {
    renderColumn('in_progress', two);
    const head = screen.getByRole('heading', { level: 2 });
    expect(head).toHaveClass('text-title-2');
    expect(head).not.toHaveClass('text-foreground');
  });

  it('names the section by its head', () => {
    renderColumn('planned', two);
    expect(screen.getByRole('region', { name: 'Next' })).toBeInTheDocument();
  });

  it('tags the section with its status', () => {
    const { container } = renderColumn('shipped', two);
    expect(container.querySelector('section')).toHaveAttribute('data-status', 'shipped');
  });

  it.each<[RoadmapStatus, string]>([
    ['in_progress', 'bg-primary'],
    ['planned', 'bg-info'],
    ['shipped', 'bg-success'],
  ])('marks the %s head with a %s dot hidden from assistive technology', (status, colour) => {
    renderColumn(status, two);
    const dot = screen.getByRole('heading', { level: 2 }).querySelector('[aria-hidden="true"]');
    expect(dot).toHaveClass(colour, 'rounded-full');
  });

  it('sets the dot and name as a block-level row, so the head keeps its own line height', () => {
    renderColumn('in_progress', two);
    const row = screen.getByRole('heading', { level: 2 }).firstElementChild;
    expect(row).toHaveClass('flex', 'items-center');
    expect(row).not.toHaveClass('inline-flex');
  });

  it('counts the column projects in mono beside the head', () => {
    renderColumn('in_progress', two);
    expect(screen.getByText('2 projects')).toHaveClass('font-mono');
  });

  it('counts a single project in the singular', () => {
    renderColumn('in_progress', two.slice(0, 1));
    expect(screen.getByText('1 project')).toBeInTheDocument();
  });

  it('keeps its head when the status has no projects', () => {
    renderColumn('shipped', []);
    expect(screen.getByRole('heading', { level: 2, name: 'Shipped' })).toBeInTheDocument();
    expect(screen.getByText('0 projects')).toBeInTheDocument();
  });

  it('renders one card per project', () => {
    renderColumn('in_progress', two);
    expect(screen.getByRole('heading', { level: 3, name: 'A' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'B' })).toBeInTheDocument();
  });

  it('never splits the project count across lines', () => {
    renderColumn('shipped', two);
    expect(screen.getByText('2 projects')).toHaveClass('whitespace-nowrap');
  });

  it('moves the count below the name only when the pair does not fit, by its own content', () => {
    renderColumn('shipped', two);
    const row = screen.getByRole('heading', { level: 2 }).parentElement;
    expect(row).toHaveClass('flex', 'flex-wrap', 'justify-between');
  });

  it('wraps each head on its own, with no switch shared by the columns', () => {
    const { container } = renderColumn('shipped', two);
    const tokens = [container.querySelector('section'), ...container.querySelectorAll('section *')]
      .flatMap((element) => [...(element?.classList ?? [])])
      .filter((token) => token.startsWith('@'));
    expect(tokens).toEqual([]);
  });

  it('keeps the column from growing past its grid track', () => {
    const { container } = renderColumn('in_progress', two);
    expect(container.querySelector('section')).toHaveClass('min-w-0');
  });
});
