import type { RoadmapResponse } from '@hushbox/shared';

/**
 * Fixture rendered through the real component tree while the API
 * response is in-flight. The ghost-UI skeleton (see `RoadmapBoard`)
 * stamps `data-skeleton` on the wrapper and a global CSS rule masks
 * text into shimmer bars, so the strings here are never visually
 * shown — but they're typed as a real {@link RoadmapResponse} so
 * the placeholder cannot drift away from the schema or the rendered
 * component shape. A schema tightening or a new required field
 * surfaces as a TypeScript / Zod error, not a silent visual bug.
 *
 * Shape goals (enforced by `placeholder-data.test.ts`):
 *  - at least one project per status, so all three status sections
 *    render and the skeleton mirrors the loaded multi-section layout;
 *  - non-project nodes covering both `feature` and `bug` types, so the
 *    type filter chips render with non-zero counts;
 *  - varied progress fractions, so the progress bars render at a mix
 *    of widths rather than a uniform single shimmer block;
 *  - at least one subtask, so the indented row pattern in {@link
 *    TaskTree} is exercised.
 */
export const placeholderRoadmap: RoadmapResponse = {
  nodes: [
    {
      id: 'aaaa00000001',
      kind: 'project',
      parentId: null,
      title: 'Streaming response improvements',
      status: 'in_progress',
      type: null,
      progress: { done: 1, total: 3 },
    },
    {
      id: 'aaaa00000002',
      kind: 'project',
      parentId: null,
      title: 'Settings panel polish',
      status: 'in_progress',
      type: null,
      progress: { done: 2, total: 4 },
    },
    {
      id: 'aaaa00000003',
      kind: 'project',
      parentId: null,
      title: 'Voice input on mobile',
      status: 'planned',
      type: null,
      progress: { done: 0, total: 2 },
    },
    {
      id: 'aaaa00000004',
      kind: 'project',
      parentId: null,
      title: 'Group chat invites refresh',
      status: 'planned',
      type: null,
      progress: { done: 0, total: 3 },
    },
    {
      id: 'aaaa00000005',
      kind: 'project',
      parentId: null,
      title: 'Cross-device sync rewrite',
      status: 'shipped',
      type: null,
      progress: { done: 4, total: 4 },
    },
    {
      id: 'aaaa00000006',
      kind: 'project',
      parentId: null,
      title: 'Markdown table rendering',
      status: 'shipped',
      type: null,
      progress: { done: 3, total: 3 },
    },
    {
      id: 'bbbb00000001',
      kind: 'task',
      parentId: 'aaaa00000001',
      title: 'Backpressure on slow clients',
      status: 'in_progress',
      type: 'feature',
    },
    {
      id: 'bbbb00000002',
      kind: 'task',
      parentId: 'aaaa00000001',
      title: 'Reconnect after dropped connection',
      status: 'planned',
      type: 'feature',
    },
    {
      id: 'bbbb00000003',
      kind: 'task',
      parentId: 'aaaa00000001',
      title: 'Memory leak on long streams',
      status: 'planned',
      type: 'bug',
    },
    {
      id: 'bbbb00000004',
      kind: 'task',
      parentId: 'aaaa00000002',
      title: 'Inline keybinding editor',
      status: 'shipped',
      type: 'feature',
    },
    {
      id: 'bbbb00000005',
      kind: 'task',
      parentId: 'aaaa00000002',
      title: 'Profile photo upload',
      status: 'shipped',
      type: 'feature',
    },
    {
      id: 'bbbb00000006',
      kind: 'task',
      parentId: 'aaaa00000002',
      title: 'Theme dropdown overflow on mobile',
      status: 'in_progress',
      type: 'bug',
    },
    {
      id: 'bbbb00000007',
      kind: 'task',
      parentId: 'aaaa00000003',
      title: 'Mic permission UX',
      status: 'planned',
      type: 'feature',
    },
    {
      id: 'bbbb00000008',
      kind: 'task',
      parentId: 'aaaa00000003',
      title: 'Background noise suppression',
      status: 'planned',
      type: 'feature',
    },
    {
      id: 'bbbb00000009',
      kind: 'task',
      parentId: 'aaaa00000004',
      title: 'Pending invite list',
      status: 'planned',
      type: 'feature',
    },
    {
      id: 'bbbb0000000a',
      kind: 'task',
      parentId: 'aaaa00000004',
      title: 'Resend invite action',
      status: 'planned',
      type: 'feature',
    },
    {
      id: 'bbbb0000000b',
      kind: 'task',
      parentId: 'aaaa00000004',
      title: 'Avatar fallbacks',
      status: 'planned',
      type: 'bug',
    },
    {
      id: 'bbbb0000000c',
      kind: 'task',
      parentId: 'aaaa00000005',
      title: 'Conflict resolution',
      status: 'shipped',
      type: 'feature',
    },
    {
      id: 'bbbb0000000d',
      kind: 'task',
      parentId: 'aaaa00000005',
      title: 'Offline queue',
      status: 'shipped',
      type: 'feature',
    },
    {
      id: 'bbbb0000000e',
      kind: 'task',
      parentId: 'aaaa00000006',
      title: 'GFM table parser',
      status: 'shipped',
      type: 'feature',
    },
    {
      id: 'bbbb0000000f',
      kind: 'task',
      parentId: 'aaaa00000006',
      title: 'Long-cell wrap bug',
      status: 'shipped',
      type: 'bug',
    },
    {
      id: 'cccc00000001',
      kind: 'subtask',
      parentId: 'bbbb00000001',
      title: 'Token rate limiting',
      status: 'in_progress',
      type: 'feature',
    },
  ],
};
