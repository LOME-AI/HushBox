import { z } from 'zod';
import { PROGRESS_STATUSES } from '@hushbox/docket/types';

/**
 * Whether an action replaces a value outright, or appends to one. `true` and
 * `false` where the action alone decides; a predicate where its body does.
 *
 * A replacement is what a stale read can silently undo — a reader acting on a
 * screen taken before an implementation agent blocked the finding would put the
 * block back to whatever they saw — so a replacement names the version it was
 * decided on and the server refuses it if those fields have moved since.
 *
 * An append that only appends is left unfenced deliberately. A progress note
 * and a question cannot lose anything by arriving late. An answer is the case
 * that would actively break: the store values all of a finding's answers as one
 * field, so fencing it would make two agents answering different questions
 * collide, while a second answer to the same question is already refused. A
 * write that appends and replaces is fenced over both, for the reason its own
 * entry gives.
 */
export type ReplacePolicy = boolean | ((body: object) => boolean);

interface FindingActionSpec {
  /** What the route accepts, and the only description of that shape. */
  readonly schema: z.ZodType;
  readonly replaces: ReplacePolicy;
}

const optionalText = z.string().nullish();
/** The file version the caller's copy came from; absent means an unfenced write. */
const version = z.string().optional();
/**
 * A dedication decision riding the write that took it. Optional everywhere it
 * appears, and absent means the write says nothing about the mark: naming the
 * field on every ruling would fence every ruling on it, and refuse a decision
 * that raced a mark nobody was arguing about.
 */
const mark = z.boolean().optional();

/**
 * Every write the console can make, declared once. The server's route table is
 * keyed by this, so an action added here has a route and cannot compile without
 * a transition; the client's action union is derived from it, so the console can
 * post exactly the actions the server serves; and the fence policy is read from
 * it, so no action reaches the wire without a decision about what it overwrites.
 */
export const FINDING_ACTIONS = {
  rule: {
    schema: z.object({
      option: z.string().min(1),
      text: optionalText,
      note: optionalText,
      dedicated: mark,
      base: version,
    }),
    replaces: true,
  },
  /** The mark as a decision of its own, where {@link mark} rides another. */
  dedicate: {
    schema: z.object({ dedicated: z.boolean(), base: version }),
    replaces: true,
  },
  deny: {
    schema: z.object({ reason: optionalText, base: version }),
    replaces: true,
  },
  reopen: {
    schema: z.object({ base: version }),
    replaces: true,
  },
  ask: {
    schema: z.object({ text: z.string().min(1), base: version }),
    replaces: false,
  },
  withdraw: {
    schema: z.object({ index: z.number().int().min(0), base: version }),
    replaces: true,
  },
  unblock: {
    // The note is the answer the work stopped for, so the action cannot be taken
    // without one: unblocking on silence would hand the finding back with the
    // same question on it.
    schema: z.object({ note: z.string().min(1), dedicated: mark, base: version }),
    // It moves the status, and a note that landed since the reader's screen was
    // drawn is a different question than the one this answers.
    replaces: true,
  },
  progress: {
    // A status is a claim about the work and `verified` is the reader's judgement
    // of that claim, so one call cannot carry both: verifying in the same act
    // that sets the status would be the reader confirming their own edit.
    schema: z
      .object({
        status: z.enum(PROGRESS_STATUSES).optional(),
        note: z.string().min(1).optional(),
        verified: z.boolean().optional(),
        base: version,
      })
      .refine((input) => input.status === undefined || input.verified === undefined, {
        message: 'a status and a verification are different claims, so they need separate calls',
      }),
    // A progress call carries exactly one of the three, so it is a replacement or
    // an append according to which field the reader used.
    replaces: (body) => 'status' in body || 'verified' in body,
  },
} satisfies Record<string, FindingActionSpec>;

/** The route token, so the set is the finding routes the console posts to. */
export type FindingAction = keyof typeof FINDING_ACTIONS;
