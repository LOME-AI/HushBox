import { describe, it, expect } from 'vitest';
import { roadmapResponseSchema } from '@hushbox/shared';
import { placeholderRoadmap } from './placeholder-data';

describe('placeholderRoadmap', () => {
  it('parses through roadmapResponseSchema', () => {
    expect(() => roadmapResponseSchema.parse(placeholderRoadmap)).not.toThrow();
  });

  it('includes at least one project in every status so the skeleton mirrors all sections', () => {
    const statuses = new Set(
      placeholderRoadmap.nodes.filter((node) => node.kind === 'project').map((node) => node.status)
    );
    expect(statuses).toEqual(new Set(['in_progress', 'planned', 'shipped']));
  });

  it('includes non-project nodes of both feature and bug types so type chips render non-zero counts', () => {
    const types = new Set(
      placeholderRoadmap.nodes
        .filter((node) => node.kind !== 'project')
        .map((node) => node.type)
        .filter((t): t is 'feature' | 'bug' => t !== null)
    );
    expect(types).toEqual(new Set(['feature', 'bug']));
  });
});
