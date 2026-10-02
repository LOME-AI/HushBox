/**
 * The finishing pass over the scene, every value one the caller computes from the frame.
 * - `bloom`: how strongly light above the threshold glows, 0 for none.
 * - `aberration`: the chromatic split at the frame's edges, 0 for none; drive it with
 *   an impact envelope such as `pulse`.
 * - `vignette`: how far the corners darken, in [0, 1].
 * - `flash`: light added over the whole frame before tone mapping, 0 for none.
 */
export interface PostSettings {
  bloom: number;
  aberration: number;
  vignette: number;
  flash: number;
}

/** The chain with every effect off; its highlight roll-off and dither still finish the frame. */
export const NEUTRAL_POST: PostSettings = { bloom: 0, aberration: 0, vignette: 0, flash: 0 };

/** Refuses a setting no frame can draw, naming it. */
export function assertPost(post: PostSettings): void {
  for (const key of ['bloom', 'aberration', 'flash'] as const) {
    const value = post[key];
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(
        `post.${key} must be a finite number of at least 0, got ${String(value)}`
      );
    }
  }
  if (!(post.vignette >= 0 && post.vignette <= 1)) {
    throw new RangeError(`post.vignette must lie in [0, 1], got ${String(post.vignette)}`);
  }
}

/**
 * The post chain a canvas finishes its frame with: its one `PostChain`'s
 * settings, checked, or null when it holds none and the frame goes unfinished.
 */
export function framePost(posts: readonly PostSettings[]): PostSettings | null {
  if (posts.length > 1) {
    throw new RangeError(
      `a GlCanvas takes one PostChain, and this one holds ${String(posts.length)}`
    );
  }
  const [post] = posts;
  if (post === undefined) {
    return null;
  }
  assertPost(post);
  return post;
}

/**
 * One side of a normalised Gaussian blur kernel: the centre tap first, then the
 * taps outward, weighted so the centre plus both sides sum to 1.
 */
export function gaussianKernel(radius: number, sigma: number): number[] {
  if (!Number.isInteger(radius) || radius < 1) {
    throw new RangeError(
      `a blur kernel reaches a whole number of at least one tap, got ${String(radius)}`
    );
  }
  if (!Number.isFinite(sigma) || sigma <= 0) {
    throw new RangeError(`a blur kernel's width must be above 0, got ${String(sigma)}`);
  }
  const raw = Array.from({ length: radius + 1 }, (_, tap) =>
    Math.exp(-(tap * tap) / (2 * sigma * sigma))
  );
  const [centre = 0, ...side] = raw;
  const total = centre + 2 * side.reduce((sum, weight) => sum + weight, 0);
  return raw.map((weight) => weight / total);
}
