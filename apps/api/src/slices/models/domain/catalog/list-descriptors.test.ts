import { describe, expect, it } from 'vitest';
import { CATALOG_GENERATION_HEX_LENGTH, WorkflowDefinition } from '@hushbox/shared';
import { exposedCatalogGeneration } from './list-descriptors.js';

const OPUS = { id: 'anthropic/claude-opus', fetchedAt: 1000 };
const MINI = { id: 'openai/gpt-mini', fetchedAt: 2000 };

describe('exposedCatalogGeneration', () => {
  it('is the generation length of lowercase hex characters from a digest', async () => {
    await expect(exposedCatalogGeneration([OPUS, MINI])).resolves.toMatch(
      new RegExp(`^[0-9a-f]{${String(CATALOG_GENERATION_HEX_LENGTH)}}$`)
    );
  });

  it('does not depend on the order the rows arrive in', async () => {
    const forward = await exposedCatalogGeneration([OPUS, MINI]);
    const backward = await exposedCatalogGeneration([MINI, OPUS]);
    expect(backward).toBe(forward);
  });

  it('moves when a model is admin-enabled although no fetchedAt moves', async () => {
    const disabled = await exposedCatalogGeneration([OPUS]);
    const enabled = await exposedCatalogGeneration([OPUS, MINI]);
    expect(enabled).not.toBe(disabled);
  });

  it('moves when a refresh rewrites one row', async () => {
    const before = await exposedCatalogGeneration([OPUS, MINI]);
    const after = await exposedCatalogGeneration([OPUS, { ...MINI, fetchedAt: 3000 }]);
    expect(after).not.toBe(before);
  });

  it('moves when a fetchedAt passes from one row to another', async () => {
    const before = await exposedCatalogGeneration([OPUS, MINI]);
    const swapped = await exposedCatalogGeneration([
      { ...OPUS, fetchedAt: MINI.fetchedAt },
      { ...MINI, fetchedAt: OPUS.fetchedAt },
    ]);
    expect(swapped).not.toBe(before);
  });

  it('is a generation the workflow definition schema accepts', async () => {
    const parsed = WorkflowDefinition.safeParse({
      version: 1,
      deadlineClass: 'text',
      hooks: { admission: 'chat', settlement: 'chat' },
      nodes: [],
      edges: [],
      catalogGeneration: await exposedCatalogGeneration([OPUS, MINI]),
    });
    expect(parsed.success).toBe(true);
  });
});
