import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Node } from './Node';
import type { RoadmapNode } from '@hushbox/shared';

function makeNode(overrides: Partial<RoadmapNode> = {}): RoadmapNode {
  return {
    id: '000000000001',
    kind: 'project',
    parentId: null,
    title: 'Custom prompts',
    status: 'in_progress',
    type: null,
    color: '#ec4755',
    ...overrides,
  };
}

const position = { x: 100, y: 100, r: 24 };

function renderNode(node: RoadmapNode, onClick: (id: string) => void = () => {}) {
  return render(
    <svg>
      <Node
        node={node}
        position={position}
        dependencyCount={0}
        isNarrow={false}
        onClick={onClick}
      />
    </svg>
  );
}

describe('Node', () => {
  it('renders the title as a text label', () => {
    const { container } = renderNode(makeNode());
    expect(container.textContent).toContain('Custom prompts');
  });

  it('applies the project color via inline fill for projects', () => {
    const { container } = renderNode(makeNode({ color: '#ec4755' }));
    const circle = container.querySelector('circle');
    // jsdom normalises hex to rgb(...). Either form means we set the fill.
    const style = circle?.getAttribute('style') ?? '';
    expect(style).toMatch(/fill: (#ec4755|rgb\(236, 71, 85\))/);
  });

  it('uses status-based fill class for issue nodes (no inline color)', () => {
    const { container } = renderNode(
      makeNode({ kind: 'task', status: 'planned', color: null, type: 'feature' })
    );
    const circle = container.querySelector('circle');
    expect(circle?.getAttribute('style')).toBeNull();
    expect(circle?.getAttribute('class')).toContain('fill-muted-foreground');
  });

  it('renders an F glyph for feature type', () => {
    const { container } = renderNode(makeNode({ kind: 'task', type: 'feature', color: null }));
    expect(container.textContent).toContain('F');
  });

  it('renders a B glyph for bug type', () => {
    const { container } = renderNode(makeNode({ kind: 'task', type: 'bug', color: null }));
    expect(container.textContent).toContain('B');
  });

  it('does not render a type glyph for projects (null type)', () => {
    const { container } = renderNode(makeNode());
    const innerText = container.querySelectorAll('text');
    // Project nodes render only the label text, not the type glyph.
    expect(innerText.length).toBe(1);
  });

  it('emits aria-label combining kind, title, and status', () => {
    const { container } = renderNode(makeNode());
    const group = container.querySelector('g');
    expect(group?.getAttribute('aria-label')).toBe('project: Custom prompts, status in progress');
  });

  it('calls onClick when the group is clicked', async () => {
    const handle = vi.fn();
    const { container } = renderNode(makeNode(), handle);
    const group = container.querySelector('g');
    if (!group) throw new Error('expected a node group');
    await userEvent.click(group);
    expect(handle).toHaveBeenCalledWith('000000000001');
  });

  it('calls onClick when Enter is pressed on the focused group', async () => {
    const handle = vi.fn();
    const { container } = renderNode(makeNode(), handle);
    const group = container.querySelector('g');
    if (!group) throw new Error('expected a node group');
    group.focus();
    await userEvent.keyboard('{Enter}');
    expect(handle).toHaveBeenCalledWith('000000000001');
  });

  it('renders the ↬ deps chip on narrow when dependencyCount > 0', () => {
    const { container } = render(
      <svg>
        <Node
          node={makeNode({ kind: 'task', color: null })}
          position={position}
          dependencyCount={3}
          isNarrow={true}
          onClick={() => {}}
        />
      </svg>
    );
    expect(container.textContent).toContain('↬ 3 deps');
  });

  it('omits the deps chip in wide layout', () => {
    const { container } = render(
      <svg>
        <Node
          node={makeNode({ kind: 'task', color: null })}
          position={position}
          dependencyCount={3}
          isNarrow={false}
          onClick={() => {}}
        />
      </svg>
    );
    expect(container.textContent).not.toContain('deps');
  });
});
