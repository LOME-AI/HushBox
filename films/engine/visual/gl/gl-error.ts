/** Why the GL layer could not draw a frame. */
export type GlFailure =
  | 'unsupported'
  | 'context-lost'
  | 'shader-compile'
  | 'program-link'
  | 'framebuffer';

/** A failure of the GL layer, named so a failed render says which layer failed and why. */
export class GlError extends Error {
  override readonly name = 'GlError';
  readonly failure: GlFailure;

  constructor(failure: GlFailure, detail: string) {
    super(`GlCanvas ${failure}: ${detail}`);
    this.failure = failure;
  }
}
