import { describe, it, expect } from 'vitest';

import { projectFactory } from './index';

describe('projectFactory', () => {
  it('builds a complete project object', () => {
    const project = projectFactory.build();

    expect(project.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(project.userId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(project.name).toBeTruthy();
    expect(project.createdAt).toBeInstanceOf(Date);
    expect(project.updatedAt).toBeInstanceOf(Date);
  });

  it('allows field overrides', () => {
    const project = projectFactory.build({ name: 'Custom Project' });
    expect(project.name).toBe('Custom Project');
  });

  it('builds a list with unique IDs', () => {
    const projectList = projectFactory.buildList(3);
    expect(projectList).toHaveLength(3);
    const ids = new Set(projectList.map((p) => p.id));
    expect(ids.size).toBe(3);
  });
});
