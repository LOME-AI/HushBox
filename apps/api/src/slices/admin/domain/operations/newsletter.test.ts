import { describe, expect, it } from 'vitest';
import { ADMIN_OP_CONTRACTS } from '@hushbox/shared';
import { okAsync } from '../../../../lib/result/index.js';
import { defineAdminOp } from '../registry.js';
import type { AdminNewsletterDeps, AdminNewsletterPostDeps } from './newsletter.js';

const testSendContract = ADMIN_OP_CONTRACTS['newsletter.testSend'];

/**
 * The compile half of the newsletter dependency partition. The live email
 * sender is declared on the post-commit half, so a body naming
 * `ctx.deps.newsletterTestEmail` does not typecheck — that is what the
 * `@ts-expect-error` directive in this file pins, and all it pins: a read the
 * type refuses, not a cast that goes around it.
 *
 * The cast is answered at runtime instead. The composition root builds the
 * transaction-scoped and post-commit sets as two literals sharing no key, so a
 * cast to the post-commit half reads `undefined`; the colocated composition
 * test asserts that empty intersection. The two halves are load-bearing
 * together — remove the runtime disjointness and this file still passes while a
 * body reaches the sender again.
 *
 * Preview runs the real body inside a transaction that is then rolled back, and
 * a send issued from inside one would leave a delivered email that no rollback
 * recalls. Every syntactic check passes such a send, because the sender arrives
 * injected rather than minted in the body.
 */
describe('newsletter op dependency partition', () => {
  it('keeps the live sender out of an op body', () => {
    const op = defineAdminOp<
      AdminNewsletterDeps,
      (typeof testSendContract)['input'],
      AdminNewsletterPostDeps
    >(testSendContract, {
      // Never invoked: this body exists to be typechecked. The
      // `@ts-expect-error` directive on the `ctx.deps` read is the
      // load-bearing assertion — put a post-commit dependency back on the
      // transaction-scoped half and its directive goes unused, which `tsc`
      // rejects.
      execute: (ctx, input) => {
        // @ts-expect-error — the live email sender is declared on `AdminNewsletterPostDeps`, so it is not on `ctx.deps`; the registered effect's `run` receives it after commit
        const sender: unknown = ctx.deps.newsletterTestEmail;
        ctx.registerEphemeral({
          name: 'newsletter.testSend.email',
          // The permitted form: the same sender, handed over after commit.
          run: async (post): Promise<void> => {
            const sent = await post.newsletterTestEmail.send({
              subject: input.subject,
              bodyMarkdown: input.bodyMarkdown,
              to: ctx.deps.actorEmail(),
            });
            if (sent.isErr()) throw new Error('test send failed');
          },
        });
        return okAsync({ effects: [{ label: 'partition', after: { sender } }] });
      },
    });

    expect(op.contract.name).toBe('newsletter.testSend');
  });
});
