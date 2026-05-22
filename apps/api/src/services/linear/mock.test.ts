import { describe, it, expect } from 'vitest';
import { createMockLinearClient } from './mock.js';
import { MOCK_PROJECTS, MOCK_ISSUES } from './mock-fixtures/roadmap.js';

describe('createMockLinearClient', () => {
  it('returns the committed projects fixture', async () => {
    const client = createMockLinearClient();
    const data = await client.fetchRoadmap('HUS');
    expect(data.projects).toBe(MOCK_PROJECTS);
  });

  it('returns the committed issues fixture', async () => {
    const client = createMockLinearClient();
    const data = await client.fetchRoadmap('HUS');
    expect(data.issues).toBe(MOCK_ISSUES);
  });

  it('returns the same fixture regardless of team key', async () => {
    const client = createMockLinearClient();
    const a = await client.fetchRoadmap('HUS');
    const b = await client.fetchRoadmap('OTHER');
    expect(a).toEqual(b);
  });

  it('includes at least one cross-project dependency in the fixture', async () => {
    const client = createMockLinearClient();
    const data = await client.fetchRoadmap('HUS');
    const issuesWithRelations = data.issues.filter((i) => i.relations.length > 0);
    expect(issuesWithRelations.length).toBeGreaterThan(0);
    const crossProject = issuesWithRelations.some((src) =>
      src.relations.some((rel) => {
        const target = data.issues.find((i) => i.id === rel.relatedIssueId);
        return target !== undefined && target.projectId !== src.projectId;
      })
    );
    expect(crossProject).toBe(true);
  });

  it('includes at least one orphan issue (no project) so normalize tests have coverage', async () => {
    const client = createMockLinearClient();
    const data = await client.fetchRoadmap('HUS');
    expect(data.issues.some((i) => i.projectId === null)).toBe(true);
  });

  it('includes both feature and bug typed issues', async () => {
    const client = createMockLinearClient();
    const data = await client.fetchRoadmap('HUS');
    expect(data.issues.some((i) => i.labelNames.includes('type:feature'))).toBe(true);
    expect(data.issues.some((i) => i.labelNames.includes('type:bug'))).toBe(true);
  });

  it('includes a multi-level hierarchy (project → task → subtask)', async () => {
    const client = createMockLinearClient();
    const data = await client.fetchRoadmap('HUS');
    const subtask = data.issues.find((i) => i.parentId !== null);
    expect(subtask).toBeDefined();
    const parent = data.issues.find((i) => i.id === subtask?.parentId);
    expect(parent).toBeDefined();
    expect(parent?.parentId).toBeNull();
  });
});
