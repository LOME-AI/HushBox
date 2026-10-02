import { describe, expect, it } from 'vitest';
import { errAsync, okAsync } from '../../../../lib/result/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import {
  canRegenerate,
  deleteSetBlockedByOtherUser,
  linearDeleteSetIds,
  regenerateBlockedByOtherUser,
} from './regenerate-guard.js';
import type { ConversationsStores, SenderChainRow } from '../../../conversations/index.js';

const CALLER = 'user-caller';
const OTHER = 'user-other';

// `sequenceNumber` defaults to 0 because the ancestry walk never reads it; the
// delete-set cases that do read it always state it.
function assistant(id: string, parentMessageId: string | null, sequenceNumber = 0): SenderChainRow {
  return { id, parentMessageId, senderType: 'assistant', senderId: null, sequenceNumber };
}
function userMsg(
  id: string,
  parentMessageId: string | null,
  senderId: string | null,
  sequenceNumber = 0
): SenderChainRow {
  return { id, parentMessageId, senderType: 'user', senderId, sequenceNumber };
}

// The walk must PROVE the anchor was reached, not merely that no other user was
// seen on the way: every early exit leaves the stretch between the break and the
// anchor unread, and that stretch is exactly where a co-member's message would
// sit. So a walk that ends anywhere but on the anchor blocks.
describe('regenerateBlockedByOtherUser', () => {
  it('blocks when the tip is null (no chain to walk, so the anchor is never reached)', () => {
    expect(regenerateBlockedByOtherUser([], null, 'target', CALLER)).toBe(true);
  });

  it('allows when the tip is the target itself', () => {
    expect(regenerateBlockedByOtherUser([], 'target', 'target', CALLER)).toBe(false);
  });

  it('allows a chain of only the caller and assistants', () => {
    const rows = [
      userMsg('target', null, CALLER),
      assistant('a1', 'target'),
      userMsg('u2', 'a1', CALLER),
      assistant('tip', 'u2'),
    ];
    expect(regenerateBlockedByOtherUser(rows, 'tip', 'target', CALLER)).toBe(false);
  });

  it("blocks when another user's message sits between tip and target", () => {
    const rows = [
      userMsg('target', null, CALLER),
      userMsg('u2', 'target', OTHER),
      assistant('tip', 'u2'),
    ];
    expect(regenerateBlockedByOtherUser(rows, 'tip', 'target', CALLER)).toBe(true);
  });

  it('ignores assistant messages (only user senders can intervene)', () => {
    const rows = [userMsg('target', null, CALLER), assistant('tip', 'target')];
    expect(regenerateBlockedByOtherUser(rows, 'tip', 'target', CALLER)).toBe(false);
  });

  it('treats a scrubbed (null) senderId as nobody, not another user', () => {
    const rows = [
      userMsg('target', null, CALLER),
      userMsg('u2', 'target', null),
      assistant('tip', 'u2'),
    ];
    expect(regenerateBlockedByOtherUser(rows, 'tip', 'target', CALLER)).toBe(false);
  });

  it('blocks when the chain dangles on a missing row before reaching the target', () => {
    const rows = [assistant('tip', 'gone')];
    expect(regenerateBlockedByOtherUser(rows, 'tip', 'target', CALLER)).toBe(true);
  });

  it('blocks when a parent pointer goes null before reaching the target', () => {
    const rows = [assistant('tip', null)];
    expect(regenerateBlockedByOtherUser(rows, 'tip', 'target', CALLER)).toBe(true);
  });

  it('reports not-blocked over a co-member message re-parented off the walked path', () => {
    // Why this walk cannot be the linear delete's guard: it completes on the
    // anchor in one hop and never inspects `victim`, which the sequence-scoped
    // delete would nonetheless destroy. `deleteSetBlockedByOtherUser` is what
    // judges that arm.
    const rows = [
      userMsg('target', null, CALLER, 1),
      userMsg('victim', 'fresh', OTHER, 5),
      assistant('fresh', 'target', 6),
    ];
    expect(regenerateBlockedByOtherUser(rows, 'fresh', 'target', CALLER)).toBe(false);
  });

  it('blocks on a cyclic parent reference instead of looping', () => {
    const rows = [assistant('tip', 'loop'), assistant('loop', 'tip')];
    expect(regenerateBlockedByOtherUser(rows, 'tip', 'target', CALLER)).toBe(true);
  });
});

// The one expression that decides which rows a linear regenerate removes. Both
// the guard and the settlement consume its output, so the set that is judged and
// the set that is deleted are the same object, not two spellings of a boundary.
describe('linearDeleteSetIds', () => {
  const rows = [
    userMsg('anchor', null, CALLER, 10),
    assistant('reply', 'anchor', 20),
    userMsg('earlier', null, CALLER, 5),
  ];

  it('holds every row above the boundary and not the boundary row itself', () => {
    expect([...linearDeleteSetIds(rows, 10, [])]).toEqual(['reply']);
  });

  it('holds an appended id that sits at or below the boundary', () => {
    // Insertion order: the rows above the boundary, then the appended id.
    expect([...linearDeleteSetIds(rows, 10, ['anchor'])]).toEqual(['reply', 'anchor']);
  });

  it('does not duplicate an appended id already above the boundary', () => {
    expect([...linearDeleteSetIds(rows, 10, ['reply'])]).toEqual(['reply']);
  });
});

// The predicate the LINEAR delete itself runs on, asked directly instead of
// modelled: a retry-all/edit removes every row above the deletion anchor's
// sequence, so the question is whether that set — and the rows the set would
// strand — belongs to anyone but the caller. An ancestry walk cannot answer it,
// because a re-parented subtree sits inside the blast radius and off every path.
describe('deleteSetBlockedByOtherUser', () => {
  it('allows when only the caller and assistants sit above the deletion anchor', () => {
    const rows = [
      userMsg('anchor', null, CALLER, 1),
      assistant('a1', 'anchor', 2),
      userMsg('u2', 'a1', CALLER, 3),
    ];
    expect(deleteSetBlockedByOtherUser(rows, linearDeleteSetIds(rows, 1, []), CALLER)).toBe(false);
  });

  it("blocks when another member's message sits above the deletion anchor", () => {
    const rows = [
      userMsg('anchor', null, CALLER, 1),
      assistant('a1', 'anchor', 2),
      userMsg('victim', 'a1', OTHER, 3),
    ];
    expect(deleteSetBlockedByOtherUser(rows, linearDeleteSetIds(rows, 1, []), CALLER)).toBe(true);
  });

  it('allows when nothing sits above the deletion anchor', () => {
    const rows = [userMsg('anchor', null, CALLER, 5), userMsg('victim', null, OTHER, 2)];
    expect(deleteSetBlockedByOtherUser(rows, linearDeleteSetIds(rows, 5, []), CALLER)).toBe(false);
  });

  it('treats a scrubbed (null) senderId above the anchor as nobody, not another member', () => {
    const rows = [userMsg('anchor', null, CALLER, 1), userMsg('scrubbed', 'anchor', null, 2)];
    expect(deleteSetBlockedByOtherUser(rows, linearDeleteSetIds(rows, 1, []), CALLER)).toBe(false);
  });

  it("blocks a re-parented co-member message that hangs off the anchor's own fresh reply", () => {
    // What a retry-one leaves behind: the co-member reply keeps its lower
    // sequence but hangs below the FRESH reply, so the highest-sequence row
    // reaches the anchor in one hop and no ancestry walk ever sees the victim.
    // The delete's sequence predicate sees it immediately.
    const rows = [
      userMsg('anchor', null, CALLER, 1),
      assistant('tile-b', 'anchor', 3),
      assistant('tile-c', 'anchor', 4),
      userMsg('victim', 'fresh', OTHER, 5),
      assistant('fresh', 'anchor', 6),
    ];
    expect(deleteSetBlockedByOtherUser(rows, linearDeleteSetIds(rows, 1, []), CALLER)).toBe(true);
  });

  it('blocks when the delete would strand a surviving co-member message on its deleted parent', () => {
    // The victim survives the sequence cut but its parent does not, so the
    // delete's `SET NULL` cascade would detach it from the tree — the orphan
    // class the very delete this predicate guards would mint.
    const rows = [
      userMsg('anchor', null, CALLER, 10),
      userMsg('victim', 'reply', OTHER, 5),
      assistant('reply', 'anchor', 20),
    ];
    expect(deleteSetBlockedByOtherUser(rows, linearDeleteSetIds(rows, 10, []), CALLER)).toBe(true);
  });

  it('allows a surviving co-member message whose parent also survives', () => {
    const rows = [
      userMsg('anchor', null, CALLER, 10),
      userMsg('bystander', 'earlier', OTHER, 5),
      assistant('earlier', null, 4),
      assistant('reply', 'anchor', 20),
    ];
    expect(deleteSetBlockedByOtherUser(rows, linearDeleteSetIds(rows, 10, []), CALLER)).toBe(false);
  });

  it("blocks when an appended id names a co-member's row", () => {
    // The root anchor of an edit reaches the delete as an appended id rather
    // than through the sequence range; it is judged like every other id in the
    // set, so an anchor the ownership gate never proved cannot slip past.
    const rows = [userMsg('anchor', null, OTHER, 10), assistant('reply', 'anchor', 20)];
    expect(
      deleteSetBlockedByOtherUser(rows, linearDeleteSetIds(rows, 10, ['anchor']), CALLER)
    ).toBe(true);
  });

  it("does not block on the caller's own message being stranded by the delete", () => {
    const rows = [
      userMsg('anchor', null, CALLER, 10),
      userMsg('mine', 'reply', CALLER, 5),
      assistant('reply', 'anchor', 20),
    ];
    expect(deleteSetBlockedByOtherUser(rows, linearDeleteSetIds(rows, 10, []), CALLER)).toBe(false);
  });
});

interface FakeReads {
  readonly present?: boolean;
  readonly presentFails?: boolean;
  readonly forkTip?: string | null;
  /** The conversation's forks (the fork-required gate reads only their count). */
  readonly forkList?: readonly { readonly id: string }[];
  readonly rows?: readonly SenderChainRow[];
}

function fakeStores(reads: FakeReads): ConversationsStores {
  return {
    forks: {
      list: () => okAsync(reads.forkList ?? []),
      byId: () => okAsync(reads.forkTip === undefined ? null : { tipMessageId: reads.forkTip }),
    },
    messages: {
      inConversation: () =>
        reads.presentFails === true
          ? errAsync(unavailableError('inConversation read failed'))
          : okAsync(reads.present ?? true),
      senderChainRows: () => okAsync(reads.rows ?? []),
    },
  } as unknown as ConversationsStores;
}

describe('canRegenerate', () => {
  const base = {
    conversationId: 'c1',
    targetMessageId: 'target',
    userId: CALLER,
    action: 'retry',
  } as const;

  it('reports target-missing when the target is not in the conversation', async () => {
    const decision = await canRegenerate(fakeStores({ present: false }), base);
    expect(decision._unsafeUnwrap().decision).toBe('target-missing');
  });

  it('propagates a read failure as an error', async () => {
    const decision = await canRegenerate(fakeStores({ presentFails: true }), base);
    expect(decision._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('allows a retry-all whose delete set is empty', async () => {
    const stores = fakeStores({ rows: [userMsg('target', null, CALLER)] });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('allowed');
  });

  // Membership and the delete's blast radius are different questions. The
  // settlement fence has no membership notion at all — it judges every row whose
  // sender is a different principal — and a member who left, was removed, or had
  // their share link revoked keeps their `messages.senderId`. So an active-member
  // count can never stand in front of the delete-set predicate.
  it("blocks a retry-all over a departed member's message", async () => {
    const stores = fakeStores({
      rows: [userMsg('target', null, CALLER, 1), userMsg('departed', 'target', OTHER, 2)],
    });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  it("blocks the edit variant over a departed member's message", async () => {
    const stores = fakeStores({
      rows: [userMsg('target', null, CALLER, 1), userMsg('departed', 'target', OTHER, 2)],
    });
    const decision = await canRegenerate(stores, { ...base, action: 'edit' });
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  it('allows when no other user intervened on a linear tip', async () => {
    const stores = fakeStores({
      rows: [userMsg('target', null, CALLER, 1), assistant('tip', 'target', 2)],
    });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('allowed');
  });

  it('blocks when another user intervened on the linear tip', async () => {
    const stores = fakeStores({
      rows: [
        userMsg('target', null, CALLER, 1),
        userMsg('u2', 'target', OTHER, 2),
        assistant('tip', 'u2', 3),
      ],
    });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  it('blocks a group retry-all whose delete set holds a co-member message off the walked path', async () => {
    // The orphaned-subtree shape: `victim` sits above the anchor's sequence but
    // off the ancestry path, because `orphan`'s parent pointer was nulled. The
    // walk ends on a root that is not the anchor and never sees the victim; the
    // delete's own sequence predicate does.
    const stores = fakeStores({
      rows: [
        userMsg('target', null, CALLER, 1),
        userMsg('victim', 'target', OTHER, 2),
        userMsg('orphan', null, CALLER, 3),
        assistant('tip', 'orphan', 4),
      ],
    });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  it('blocks the retry-all of the four-step chain: a co-member reply re-parented under the fresh reply', async () => {
    // The graph a retry-one leaves behind. The highest-sequence row (`fresh`)
    // reaches the anchor in ONE hop, so the ancestry walk completes and reports
    // not-blocked, while the sequence-scoped delete would sweep `victim`.
    const rows = [
      userMsg('target', null, CALLER, 1),
      assistant('tile-b', 'target', 3),
      assistant('tile-c', 'target', 4),
      userMsg('victim', 'fresh', OTHER, 5),
      assistant('fresh', 'target', 6),
    ];
    const stores = fakeStores({ rows });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  it('blocks the edit variant of that same chain', async () => {
    const rows = [
      userMsg('target', null, CALLER, 1),
      assistant('tile-b', 'target', 3),
      userMsg('victim', 'fresh', OTHER, 5),
      assistant('fresh', 'target', 6),
    ];
    const stores = fakeStores({ rows });
    const decision = await canRegenerate(stores, { ...base, action: 'edit' });
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  // An edit replaces the anchor user message itself, so its delete starts at the
  // anchor's PARENT — one node higher than a retry-all's. Same rows, same
  // anchor, different blast radius, and therefore different verdicts.
  it('allows a retry-all whose delete stops below a co-member sibling of the anchor', async () => {
    const stores = fakeStores({
      rows: [
        userMsg('root', null, CALLER, 1),
        userMsg('victim', 'root', OTHER, 2),
        userMsg('target', 'root', CALLER, 3),
        assistant('reply', 'target', 4),
      ],
    });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('allowed');
  });

  it('blocks the edit of that same anchor, whose delete starts one node higher', async () => {
    const stores = fakeStores({
      rows: [
        userMsg('root', null, CALLER, 1),
        userMsg('victim', 'root', OTHER, 2),
        userMsg('target', 'root', CALLER, 3),
        assistant('reply', 'target', 4),
      ],
    });
    const decision = await canRegenerate(stores, { ...base, action: 'edit' });
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  it('measures a root anchor edit from the anchor itself, having no parent to start from', async () => {
    const stores = fakeStores({
      rows: [userMsg('target', null, CALLER, 1), assistant('reply', 'target', 2)],
    });
    const decision = await canRegenerate(stores, { ...base, action: 'edit' });
    expect(decision._unsafeUnwrap().decision).toBe('allowed');
  });

  it("fails closed when the edit's deletion boundary — the anchor's parent — has no row", async () => {
    const stores = fakeStores({
      rows: [userMsg('target', 'gone', CALLER, 3)],
    });
    const decision = await canRegenerate(stores, { ...base, action: 'edit' });
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  // Retry-one deletes one id, already validated as a direct assistant reply of
  // the caller's own anchor — a row no principal owns. Nothing it does can
  // delete a co-member's message, so the ancestry walk gates it on a property
  // its delete cannot violate.
  it('allows a retry-one though a co-member message hangs beneath the replaced reply', async () => {
    const stores = fakeStores({
      rows: [
        userMsg('target', null, CALLER, 1),
        assistant('reply', 'target', 2),
        userMsg('victim', 'reply', OTHER, 3),
      ],
    });
    const decision = await canRegenerate(stores, { ...base, replaceAssistantId: 'reply' });
    expect(decision._unsafeUnwrap().decision).toBe('allowed');
  });

  // The permanent lockout: a member's own turn re-parented beneath someone
  // else's fresh reply sits off every walk from the highest-sequence tip, and
  // no later turn re-attaches it. Gating retry-one on that walk refused the
  // member forever.
  it('allows a retry-one whose anchor sits off the walk from the highest-sequence tip', async () => {
    const stores = fakeStores({
      rows: [
        userMsg('elsewhere', null, OTHER, 1),
        assistant('fresh', 'elsewhere', 6),
        userMsg('target', 'fresh', CALLER, 3),
        assistant('reply', 'target', 4),
      ],
    });
    const decision = await canRegenerate(stores, { ...base, replaceAssistantId: 'reply' });
    expect(decision._unsafeUnwrap().decision).toBe('allowed');
  });

  // A member who left, was removed, or had their share link revoked keeps their
  // `messages.senderId`, so their message stays on the fork's chain however the
  // conversation's membership reads — and the fork tail delete is cut from
  // exactly that chain.
  it("blocks a fork regenerate whose chain holds a departed member's message", async () => {
    const stores = fakeStores({
      forkTip: 'fork-tip',
      rows: [
        userMsg('target', null, CALLER, 1),
        userMsg('departed', 'target', OTHER, 2),
        assistant('fork-tip', 'departed', 3),
      ],
    });
    const decision = await canRegenerate(stores, { ...base, forkId: 'fork-1' });
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  it('resolves the tip from the fork when a forkId is supplied', async () => {
    const stores = fakeStores({
      forkTip: 'tip',
      rows: [
        userMsg('target', null, CALLER),
        userMsg('u2', 'target', OTHER),
        assistant('tip', 'u2'),
      ],
    });
    const decision = await canRegenerate(stores, { ...base, forkId: 'fork-1' });
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  it('surfaces the fork tip it observed on an allowed fork regenerate', async () => {
    const stores = fakeStores({
      forkList: [{ id: 'fork-1' }],
      forkTip: 'fork-tip',
      rows: [userMsg('target', null, CALLER), assistant('fork-tip', 'target')],
    });
    const verdict = await canRegenerate(stores, { ...base, forkId: 'fork-1' });
    expect(verdict._unsafeUnwrap()).toEqual({ decision: 'allowed', observedForkTipId: 'fork-tip' });
  });

  it('surfaces a null observed tip on a linear regenerate', async () => {
    const stores = fakeStores({ rows: [userMsg('target', null, CALLER)] });
    const verdict = await canRegenerate(stores, base);
    expect(verdict._unsafeUnwrap()).toEqual({ decision: 'allowed', observedForkTipId: null });
  });

  it('surfaces a null observed tip when the fork has no tip yet', async () => {
    const stores = fakeStores({
      forkList: [{ id: 'fork-1' }],
      forkTip: null,
      rows: [userMsg('target', null, CALLER)],
    });
    const verdict = await canRegenerate(stores, { ...base, forkId: 'fork-1' });
    expect(verdict._unsafeUnwrap()).toEqual({ decision: 'allowed', observedForkTipId: null });
  });

  it('carries the observed fork tip even on a blocked fork verdict', async () => {
    const stores = fakeStores({
      forkTip: 'tip',
      rows: [
        userMsg('target', null, CALLER),
        userMsg('u2', 'target', OTHER),
        assistant('tip', 'u2'),
      ],
    });
    const verdict = await canRegenerate(stores, { ...base, forkId: 'fork-1' });
    expect(verdict._unsafeUnwrap()).toEqual({ decision: 'blocked', observedForkTipId: 'tip' });
  });
});

// The retry-one delete is scoped to `replaceAssistantId`, so that id must be a
// direct assistant reply of the anchor — otherwise a caller could name ANY
// message (a co-member's) and have the settlement delete it.
describe('canRegenerate — replaceAssistantId must be a direct assistant reply of the target', () => {
  const base = {
    conversationId: 'c1',
    targetMessageId: 'target',
    userId: CALLER,
    action: 'retry',
  } as const;

  it("rejects a replaceAssistantId naming another member's message (not a reply of the target)", async () => {
    const stores = fakeStores({
      rows: [userMsg('target', null, CALLER), userMsg('victim', 'elsewhere', OTHER)],
    });
    const decision = await canRegenerate(stores, { ...base, replaceAssistantId: 'victim' });
    expect(decision._unsafeUnwrap().decision).toBe('invalid-replace');
  });

  it('rejects a replaceAssistantId that is an assistant reply of a DIFFERENT anchor', async () => {
    const stores = fakeStores({
      rows: [
        userMsg('target', null, CALLER),
        userMsg('other-anchor', null, CALLER),
        assistant('reply', 'other-anchor'),
      ],
    });
    const decision = await canRegenerate(stores, { ...base, replaceAssistantId: 'reply' });
    expect(decision._unsafeUnwrap().decision).toBe('invalid-replace');
  });

  it('rejects a replaceAssistantId absent from the conversation', async () => {
    const stores = fakeStores({ rows: [userMsg('target', null, CALLER)] });
    const decision = await canRegenerate(stores, { ...base, replaceAssistantId: 'ghost' });
    expect(decision._unsafeUnwrap().decision).toBe('invalid-replace');
  });

  it('rejects a replaceAssistantId that is a USER message parented on the target', async () => {
    const stores = fakeStores({
      rows: [userMsg('target', null, CALLER), userMsg('child', 'target', CALLER)],
    });
    const decision = await canRegenerate(stores, { ...base, replaceAssistantId: 'child' });
    expect(decision._unsafeUnwrap().decision).toBe('invalid-replace');
  });

  it('allows a replaceAssistantId that IS a direct assistant reply of the target', async () => {
    const stores = fakeStores({
      rows: [userMsg('target', null, CALLER), assistant('reply', 'target')],
    });
    const decision = await canRegenerate(stores, { ...base, replaceAssistantId: 'reply' });
    expect(decision._unsafeUnwrap().decision).toBe('allowed');
  });

  it('refuses the crafted exploit: target = the tip (empty walk) + a co-member message as the replace id', async () => {
    const stores = fakeStores({
      rows: [userMsg('target', null, CALLER), userMsg('victim', 'elsewhere', OTHER)],
    });
    const decision = await canRegenerate(stores, { ...base, replaceAssistantId: 'victim' });
    expect(decision._unsafeUnwrap().decision).toBe('invalid-replace');
  });
});

// `replaceAssistantId` is a retry-only field, and the settlement dispatches on
// `action` before it ever reads one: an edit takes the sequence-scoped delete
// whatever the field holds. So a guard arm keyed on the field alone would judge
// a single id while the delete sweeps a range — admitting a paid run the
// settlement fence then refuses. The wire body refuses the combination outright;
// this pins the guard's own verdict on it.
describe('canRegenerate — an edit is judged as an edit whatever replaceAssistantId holds', () => {
  const base = {
    conversationId: 'c1',
    targetMessageId: 'target',
    userId: CALLER,
    action: 'edit',
  } as const;
  const rows = [
    userMsg('target', null, CALLER, 1),
    assistant('reply', 'target', 2),
    userMsg('victim', 'reply', OTHER, 3),
  ];

  it("blocks an edit whose delete set holds a co-member's message", async () => {
    const stores = fakeStores({ rows });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  it('blocks that same edit when it also carries a valid replaceAssistantId', async () => {
    const stores = fakeStores({ rows });
    const decision = await canRegenerate(stores, { ...base, replaceAssistantId: 'reply' });
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });
});

// A no-forkId retry-all/edit deletes by sequence across the WHOLE conversation;
// forks share one sequence space, so it is safe only on a fork-less conversation.
describe('canRegenerate — a no-forkId regenerate is refused once the conversation has forks', () => {
  const base = {
    conversationId: 'c1',
    targetMessageId: 'target',
    userId: CALLER,
    action: 'retry',
  } as const;

  it('requires a forkId when the conversation has forks and none was supplied', async () => {
    const stores = fakeStores({ forkList: [{ id: 'fork-1' }] });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('fork-required');
  });

  it('allows a no-forkId regenerate on a fork-less conversation', async () => {
    const stores = fakeStores({
      forkList: [],
      rows: [userMsg('target', null, CALLER)],
    });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('allowed');
  });

  it('skips the fork-required gate when a forkId is supplied', async () => {
    const stores = fakeStores({
      forkList: [{ id: 'fork-1' }],
      forkTip: 'target',
      rows: [userMsg('target', null, CALLER)],
    });
    const decision = await canRegenerate(stores, { ...base, forkId: 'fork-1' });
    expect(decision._unsafeUnwrap().decision).toBe('allowed');
  });
});

// The regenerate/edit anchor MUST be the caller's OWN user message. The
// settlement deletes the anchor's reply(s) (edit/retry-all delete by sequence
// from the anchor), so anchoring on another member's turn — or an assistant /
// scrubbed message — would destroy content the caller does not own. The
// tip→target walk is exclusive of the target, so a foreign anchor slips past
// every other gate; this ownership check is the root fix.
describe("canRegenerate — the anchor must be the caller's own user message", () => {
  const base = {
    conversationId: 'c1',
    targetMessageId: 'm3',
    userId: CALLER,
    action: 'retry',
  } as const;

  it("blocks anchoring on another member's user message (edit / retry-all)", async () => {
    const stores = fakeStores({
      rows: [
        userMsg('m1', null, CALLER),
        assistant('a1', 'm1'),
        userMsg('m3', 'a1', OTHER),
        assistant('m4', 'm3'),
      ],
    });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  it("blocks anchoring on another member's message even with a valid replaceAssistantId (retry-one)", async () => {
    const stores = fakeStores({
      rows: [userMsg('m3', 'a1', OTHER), assistant('m4', 'm3')],
    });
    const decision = await canRegenerate(stores, { ...base, replaceAssistantId: 'm4' });
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  it('blocks anchoring on an assistant message (not a user turn)', async () => {
    const stores = fakeStores({
      rows: [userMsg('m1', null, CALLER), assistant('m3', 'm1')],
    });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  it('blocks anchoring on a scrubbed (null senderId) user message', async () => {
    const stores = fakeStores({ rows: [userMsg('m3', null, null)] });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  it('fails closed (blocked) when the target is absent from the sender chain', async () => {
    const stores = fakeStores({ present: true, rows: [] });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  it("allows anchoring on the caller's own user message in a group turn", async () => {
    const stores = fakeStores({
      rows: [userMsg('m3', null, CALLER, 1), assistant('tip', 'm3', 2)],
    });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('allowed');
  });
});
