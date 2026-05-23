import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRealLinearClient, LinearApiError } from './real.js';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, unknown> };
}

const PROJECTS_RESPONSE = {
  data: {
    team: {
      projects: {
        nodes: [
          {
            id: 'proj-1',
            name: 'Project 1',
            color: '#ec4755',
            state: { type: 'started' },
          },
        ],
      },
    },
  },
};

const ISSUES_RESPONSE_PAGE_1 = {
  data: {
    issues: {
      pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
      nodes: [
        {
          id: 'iss-1',
          title: 'Issue 1',
          state: { name: 'In Progress', type: 'started' },
          labels: { nodes: [{ name: 'type:feature' }] },
          parent: null,
          project: { id: 'proj-1' },
          relations: {
            nodes: [
              { type: 'blocks', relatedIssue: { id: 'iss-2' } },
              { type: 'related', relatedIssue: { id: 'iss-3' } },
              { type: 'duplicate', relatedIssue: { id: 'iss-4' } },
            ],
          },
        },
      ],
    },
  },
};

const ISSUES_RESPONSE_PAGE_2 = {
  data: {
    issues: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        {
          id: 'iss-2',
          title: 'Issue 2',
          state: { name: 'Todo', type: 'unstarted' },
          labels: { nodes: [{ name: 'type:bug' }] },
          parent: { id: 'iss-1' },
          project: null,
          relations: { nodes: [] },
        },
      ],
    },
  },
};

describe('createRealLinearClient', () => {
  let captured: CapturedRequest[];

  beforeEach(() => {
    captured = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      const headers: Record<string, string> = {};
      const initHeaders = init.headers as Record<string, string> | undefined;
      if (initHeaders) Object.assign(headers, initHeaders);
      const bodyText = init.body as string;
      const parsedBody = JSON.parse(bodyText) as {
        query: string;
        variables: Record<string, unknown>;
      };
      captured.push({
        url,
        method: init.method ?? 'GET',
        headers,
        body: parsedBody,
      });
      let payload: unknown;
      if (parsedBody.query.includes('PublicRoadmapProjects')) {
        payload = PROJECTS_RESPONSE;
      } else if (parsedBody.variables['after'] === null) {
        payload = ISSUES_RESPONSE_PAGE_1;
      } else {
        payload = ISSUES_RESPONSE_PAGE_2;
      }
      return Promise.resolve(Response.json(payload, { status: 200 }));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the Linear GraphQL endpoint', async () => {
    const client = createRealLinearClient('test-key');
    await client.fetchRoadmap('HUS');
    expect(captured[0]?.url).toBe('https://api.linear.app/graphql');
  });

  it('sends the API key as a raw Authorization header without Bearer prefix', async () => {
    const client = createRealLinearClient('test-key');
    await client.fetchRoadmap('HUS');
    for (const request of captured) {
      expect(request.headers['Authorization']).toBe('test-key');
      expect(request.headers['Authorization']).not.toContain('Bearer');
    }
  });

  it('paginates issues until pageInfo.hasNextPage is false', async () => {
    const client = createRealLinearClient('test-key');
    const data = await client.fetchRoadmap('HUS');
    const issueRequests = captured.filter((c) => c.body.query.includes('PublicRoadmapIssues'));
    expect(issueRequests.length).toBe(2);
    expect(data.issues.length).toBe(2);
  });

  it('uses the previous response endCursor on the next page', async () => {
    const client = createRealLinearClient('test-key');
    await client.fetchRoadmap('HUS');
    const issueRequests = captured.filter((c) => c.body.query.includes('PublicRoadmapIssues'));
    expect(issueRequests[0]?.body.variables['after']).toBeNull();
    expect(issueRequests[1]?.body.variables['after']).toBe('cursor-1');
  });

  it('drops "related" and "duplicate" relations, keeping only blocks/blocked_by', async () => {
    const client = createRealLinearClient('test-key');
    const data = await client.fetchRoadmap('HUS');
    const issue = data.issues.find((index) => index.id === 'iss-1');
    expect(issue?.relations).toEqual([{ type: 'blocks', relatedIssueId: 'iss-2' }]);
  });

  it('maps GraphQL project nodes onto the internal shape', async () => {
    const client = createRealLinearClient('test-key');
    const data = await client.fetchRoadmap('HUS');
    expect(data.projects).toEqual([
      { id: 'proj-1', name: 'Project 1', color: '#ec4755', stateType: 'started' },
    ]);
  });

  it('throws LinearApiError when Linear returns a non-2xx response', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('forbidden', { status: 401 })));
    const client = createRealLinearClient('bad-key');
    await expect(client.fetchRoadmap('HUS')).rejects.toThrow(LinearApiError);
  });

  it('throws when Linear returns a payload that fails the response schema', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(Response.json({ data: { something: 'wrong' } }, { status: 200 }))
    );
    const client = createRealLinearClient('test-key');
    await expect(client.fetchRoadmap('HUS')).rejects.toThrow();
  });

  it('returns an empty project list when the team is null', async () => {
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      const bodyText = init.body as string;
      const parsed = JSON.parse(bodyText) as { query: string };
      if (parsed.query.includes('PublicRoadmapProjects')) {
        return Promise.resolve(Response.json({ data: { team: null } }, { status: 200 }));
      }
      return Promise.resolve(
        Response.json(
          {
            data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
          },
          { status: 200 }
        )
      );
    });
    const client = createRealLinearClient('test-key');
    const data = await client.fetchRoadmap('HUS');
    expect(data.projects).toEqual([]);
    expect(data.issues).toEqual([]);
  });

  it('handles missing parent and project gracefully (nullable in schema)', async () => {
    const client = createRealLinearClient('test-key');
    const data = await client.fetchRoadmap('HUS');
    const iss1 = data.issues.find((index) => index.id === 'iss-1');
    const iss2 = data.issues.find((index) => index.id === 'iss-2');
    expect(iss1?.parentId).toBeNull();
    expect(iss1?.projectId).toBe('proj-1');
    expect(iss2?.parentId).toBe('iss-1');
    expect(iss2?.projectId).toBeNull();
  });
});
