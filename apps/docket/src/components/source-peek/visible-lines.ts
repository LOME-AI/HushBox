/**
 * How many of the painted lines a reader can actually see. What bounds the
 * peek is the room above the citation rather than the height of the viewport,
 * so a citation high in a pane leaves a box that ends part way down the code;
 * a line whose foot falls past that edge is off screen, whatever the notice
 * above it says, and the layer takes no pointer events so nothing scrolls it
 * into view.
 *
 * An environment that lays nothing out reports every edge at zero, which reads
 * here as nothing being cut — the honest answer where nothing is drawn.
 */
export function linesInView(lineBottoms: readonly number[], clipBottom: number): number {
  if (clipBottom <= 0) return lineBottoms.length;
  const firstCut = lineBottoms.findIndex((bottom) => bottom > clipBottom);
  return firstCut === -1 ? lineBottoms.length : firstCut;
}
