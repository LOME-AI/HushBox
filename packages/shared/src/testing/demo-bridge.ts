import { z } from 'zod';

/**
 * The one message the embedding marketing page sends into the scripted-demo
 * iframe, so playback can pause while the demo is off screen. Declared once
 * here and parsed by the receiving half rather than cast, so the shape the
 * receiver trusts cannot drift from the shape that is sent.
 *
 * The sender is established by window identity — the message must come from the
 * embedding parent — and never by origin. No origin value could serve: the
 * marketing page and the app are cross-origin in development and same-origin in
 * production, the marketing URL is backend-destined and reaches no frontend
 * bundle, and the development port is offset per worktree, so any literal would
 * be wrong somewhere. A hostile embedder still satisfies a parent check, which
 * is accepted rather than overlooked: the payload only toggles a boolean that
 * pauses scripted playback, and the demo holds no credentials and no real data.
 */
export const DemoVisibilityMessage = z.object({
  type: z.literal('hb-demo-visibility'),
  visible: z.boolean(),
});

/** A visibility message from the page embedding the scripted demo. */
export type DemoVisibilityMessage = z.infer<typeof DemoVisibilityMessage>;
