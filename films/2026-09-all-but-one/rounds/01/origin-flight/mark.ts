/**
 * The HushBox mark as geometry: its centre dot and its seven swept strokes, each
 * a nine-point centreline with a half-width at every point, in units where the
 * mark's outermost edge sits at radius 1 and y points up. Measured from the
 * brand's logo file (packages/ui/src/assets/HushBoxLogo.png) by fitting the
 * strokes' pixels; the fitted outline covers the logo's at an intersection over
 * union of 0.93, so the mark can be drawn and flown through at any scale.
 */
export const MARK_DOT = 0.1617;

export const MARK_STROKES: readonly (readonly (readonly [number, number, number])[])[] = [
  [
    [0.4477, 0.1791, 0.0638],
    [0.4579, 0.3334, 0.0636],
    [0.4289, 0.4924, 0.071],
    [0.3595, 0.6249, 0.0738],
    [0.257, 0.7397, 0.0812],
    [0.1373, 0.8259, 0.0826],
    [0.0175, 0.8807, 0.0794],
    [-0.1435, 0.9127, 0.0808],
    [-0.2968, 0.8882, 0.0896],
  ],
  [
    [0.478, -0.1427, 0.062],
    [0.5789, -0.065, 0.0645],
    [0.649, 0.0676, 0.0686],
    [0.684, 0.1591, 0.0741],
    [0.7017, 0.2809, 0.0796],
    [0.7067, 0.4046, 0.0791],
    [0.6697, 0.5588, 0.0816],
    [0.6227, 0.6674, 0.0736],
    [0.5367, 0.7633, 0.0882],
  ],
  [
    [0.1688, 0.4716, 0.0705],
    [0.0693, 0.5671, 0.0669],
    [-0.0584, 0.6352, 0.0692],
    [-0.2187, 0.6712, 0.0806],
    [-0.319, 0.6725, 0.0814],
    [-0.4646, 0.6507, 0.0823],
    [-0.6197, 0.5898, 0.0786],
    [-0.7284, 0.5056, 0.0764],
    [-0.8082, 0.4009, 0.0893],
  ],
  [
    [-0.1905, 0.4382, 0.0721],
    [-0.3627, 0.4253, 0.0655],
    [-0.5091, 0.3614, 0.0694],
    [-0.6158, 0.2744, 0.0777],
    [-0.7122, 0.1676, 0.0831],
    [-0.7848, 0.0228, 0.0809],
    [-0.8289, -0.1586, 0.0818],
    [-0.8127, -0.3111, 0.0782],
    [-0.7643, -0.4623, 0.0835],
  ],
  [
    [0.0984, -0.4438, 0.0606],
    [0.2443, -0.4758, 0.0636],
    [0.4262, -0.4548, 0.0695],
    [0.5473, -0.4051, 0.074],
    [0.6704, -0.3269, 0.083],
    [0.7752, -0.2253, 0.0799],
    [0.8642, -0.0777, 0.0829],
    [0.9087, 0.0714, 0.0813],
    [0.9067, 0.2185, 0.0873],
  ],
  [
    [-0.4501, 0.1156, 0.0614],
    [-0.5328, -0.0382, 0.0584],
    [-0.5732, -0.2066, 0.0733],
    [-0.5592, -0.3683, 0.0747],
    [-0.5122, -0.5286, 0.0807],
    [-0.418, -0.6665, 0.0836],
    [-0.3078, -0.7746, 0.0836],
    [-0.17, -0.8628, 0.0775],
    [0.0049, -0.8929, 0.0925],
  ],
  [
    [-0.2532, -0.4188, 0.077],
    [-0.1875, -0.5286, 0.0671],
    [-0.0925, -0.6127, 0.0692],
    [0.0441, -0.6831, 0.0758],
    [0.1734, -0.7118, 0.0839],
    [0.2846, -0.7291, 0.08],
    [0.4418, -0.7078, 0.0806],
    [0.5648, -0.6644, 0.0797],
    [0.6704, -0.5873, 0.0878],
  ],
];

/** The strokes as a GLSL `vec3` array literal, stroke by stroke, point by point. */
export function markGlsl(): string {
  const points = MARK_STROKES.flat().map(
    ([x, y, w]) => `vec3(${x.toFixed(4)},${y.toFixed(4)},${w.toFixed(4)})`
  );
  return `const float MARK_DOT = ${MARK_DOT.toFixed(4)};
const int MARK_N = ${String(MARK_STROKES.length)};
const int MARK_P = 9;
const vec3 MARK[${String(points.length)}] = vec3[${String(points.length)}](${points.join(',')});
`;
}
