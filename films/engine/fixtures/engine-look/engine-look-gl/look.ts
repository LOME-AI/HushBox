import { GLSL_HEADER, multiply } from '../../../visual/gl/index.js';

import type { RenderFrame } from '../../../look/index.js';
import type { Mat4 } from '../../../visual/gl/index.js';

const VERTEX = `${GLSL_HEADER}
uniform mat4 u_transform;
in vec3 a_position;
in vec3 a_color;
out vec3 v_color;

void main() {
  v_color = a_color;
  gl_Position = u_transform * vec4(a_position, 1.0);
}
`;

const FRAGMENT = `${GLSL_HEADER}
in vec3 v_color;
out vec4 outColor;

void main() {
  outColor = vec4(v_color, 1.0);
}
`;

/** Each face of the unit cube as two triangles, with its shade of the face's colour. */
const FACES: readonly { corners: readonly (readonly [number, number, number])[]; shade: number }[] =
  [
    {
      corners: [
        [-1, -1, 1],
        [1, -1, 1],
        [1, 1, 1],
        [-1, 1, 1],
      ],
      shade: 1,
    },
    {
      corners: [
        [1, -1, -1],
        [-1, -1, -1],
        [-1, 1, -1],
        [1, 1, -1],
      ],
      shade: 0.45,
    },
    {
      corners: [
        [1, -1, 1],
        [1, -1, -1],
        [1, 1, -1],
        [1, 1, 1],
      ],
      shade: 0.8,
    },
    {
      corners: [
        [-1, -1, -1],
        [-1, -1, 1],
        [-1, 1, 1],
        [-1, 1, -1],
      ],
      shade: 0.6,
    },
    {
      corners: [
        [-1, 1, 1],
        [1, 1, 1],
        [1, 1, -1],
        [-1, 1, -1],
      ],
      shade: 0.9,
    },
    {
      corners: [
        [-1, -1, -1],
        [1, -1, -1],
        [1, -1, 1],
        [-1, -1, 1],
      ],
      shade: 0.5,
    },
  ];

/** Frames per turn of the cube. */
const TURN_FRAMES = 120;
const FIELD_OF_VIEW = Math.PI / 4;
const DISTANCE = 7;

/** A `#rrggbb` colour as the sRGB channels a canvas stores, each in [0, 1]. */
function srgb(hex: string): [number, number, number] {
  const channel = (index: number): number =>
    Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
  return [channel(0), channel(1), channel(2)];
}

interface Scene {
  program: WebGLProgram;
  vertices: WebGLVertexArrayObject;
  count: number;
  transform: WebGLUniformLocation | null;
}

/** Each context's compiled scene: built on its first frame, identical on every frame after. */
const scenes = new WeakMap<WebGL2RenderingContext, Scene>();

function compile(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) {
    throw new Error('engine-look-gl: the context made no shader');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    throw new Error(`engine-look-gl: ${gl.getShaderInfoLog(shader) ?? 'a shader did not compile'}`);
  }
  return shader;
}

function build(gl: WebGL2RenderingContext, red: readonly number[]): Scene {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    throw new Error(
      `engine-look-gl: ${gl.getProgramInfoLog(program) ?? 'the program did not link'}`
    );
  }
  const data = FACES.flatMap(({ corners, shade }) =>
    [0, 1, 2, 0, 2, 3].flatMap((index) => {
      const corner = corners[index];
      if (corner === undefined) {
        throw new RangeError(`engine-look-gl: a face has no corner ${String(index)}`);
      }
      return [...corner, ...red.map((channel) => channel * shade)];
    })
  );
  const vertices = gl.createVertexArray();
  gl.bindVertexArray(vertices);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
  const stride = 6 * Float32Array.BYTES_PER_ELEMENT;
  for (const [name, offset] of [
    ['a_position', 0],
    ['a_color', 3],
  ] as const) {
    const location = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(
      location,
      3,
      gl.FLOAT,
      false,
      stride,
      offset * Float32Array.BYTES_PER_ELEMENT
    );
  }
  gl.bindVertexArray(null);
  return {
    program,
    vertices,
    count: data.length / 6,
    transform: gl.getUniformLocation(program, 'u_transform'),
  };
}

function perspective(aspect: number): Mat4 {
  const focal = 1 / Math.tan(FIELD_OF_VIEW / 2);
  const near = 0.1;
  const far = 100;
  return [
    focal / aspect,
    0,
    0,
    0,
    0,
    focal,
    0,
    0,
    0,
    0,
    (far + near) / (near - far),
    -1,
    0,
    0,
    (2 * far * near) / (near - far),
    0,
  ];
}

function translation(z: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, z, 1];
}

function rotationY(angle: number): Mat4 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

function rotationX(angle: number): Mat4 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

/**
 * The look draws on a WebGL2 canvas and opts into motion blur. The look host
 * loads it by path, so no module imports these exports.
 * @toolContract
 */
export const context = 'webgl2';

/** @toolContract */
export const motionBlur = 4;

/**
 * A Signal Red cube turning once every two seconds over the brand's field,
 * drawn at the instant each call asks for.
 * @toolContract
 */
export const renderFrame: RenderFrame<'webgl2'> = (_frame, ctx) => {
  const gl = ctx.context;
  const scene = scenes.get(gl) ?? build(gl, srgb(ctx.brand.brandRed));
  scenes.set(gl, scene);
  const [red, green, blue] = srgb(ctx.brand.background);
  gl.clearColor(red, green, blue, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  const angle = (ctx.time / TURN_FRAMES) * Math.PI * 2;
  const transform = multiply(
    perspective(ctx.width / ctx.height),
    multiply(translation(-DISTANCE), multiply(rotationX(angle / 3), rotationY(angle)))
  );
  gl.useProgram(scene.program);
  gl.uniformMatrix4fv(scene.transform, false, new Float32Array(transform));
  gl.bindVertexArray(scene.vertices);
  gl.drawArrays(gl.TRIANGLES, 0, scene.count);
  gl.bindVertexArray(null);
  return [];
};
