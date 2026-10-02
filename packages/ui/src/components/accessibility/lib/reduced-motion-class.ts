/**
 * The single CSS hook every reduce-motion rule keys off. Exported because a
 * host that renders its own markup (Astro's static layouts) has to stamp the
 * same class the broadcaster toggles — the two must agree or the broadcaster
 * clears the host's.
 *
 * It sits in a leaf of its own because the pre-paint script generator needs the
 * name and nothing else: reaching it through the broadcaster would pull React
 * and the zustand store into a build-time module graph that has no DOM.
 */
export const REDUCED_MOTION_CLASS = 'reduced-motion';
