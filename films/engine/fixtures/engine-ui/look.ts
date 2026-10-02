import { FULLSCREEN_VERTEX, GLSL_HEADER } from '../../visual/gl/index.js';
import { clockAt, placementAt, warpAt } from './timeline.js';

import type { LookContext, RenderFrame, UiPlacement } from '../../look/index.js';

/**
 * The field behind the UI: the brand's charcoal with drifting washes of red
 * and paper; on a texture frame, the UI's pixels bent by a ripple and laid
 * over it with the same premultiplied `over` the browser composites a layer
 * with, rounded where the browser rounds, so no bend draws what the live
 * layer draws.
 */
const FIELD_FRAGMENT = `${GLSL_HEADER}
uniform vec2 u_size;
uniform float u_clock;
uniform vec3 u_field;
uniform vec3 u_red;
uniform vec3 u_paper;
uniform sampler2D u_ui;
uniform bool u_textured;
uniform float u_warp;

in vec2 v_uv;
out vec4 outColor;

vec3 field(vec2 p) {
  vec3 colour = u_field;
  for (int i = 0; i < 4; i++) {
    float index = float(i);
    vec2 centre = u_size * vec2(
      0.5 + 0.32 * sin(u_clock * 0.021 + index * 1.7),
      0.5 + 0.36 * cos(u_clock * 0.017 + index * 2.3)
    );
    float reach = length(p - centre) / (u_size.x * (0.3 + 0.05 * index));
    colour = mix(colour, i == 0 ? u_red : u_paper, 0.3 * smoothstep(1.0, 0.0, reach));
  }
  return colour;
}

void main() {
  vec2 p = gl_FragCoord.xy;
  vec3 back = floor(field(p) * 255.0 + 0.5) / 255.0;
  if (!u_textured) {
    outColor = vec4(back, 1.0);
    return;
  }
  vec2 uv = vec2(p.x / u_size.x, 1.0 - p.y / u_size.y);
  uv += u_warp * vec2(
    0.04 * sin(uv.y * 23.0 + u_clock * 0.2),
    0.025 * sin(uv.x * 17.0 - u_clock * 0.15)
  );
  vec4 ui = texture(u_ui, uv);
  vec3 premultiplied = floor(ui.rgb * ui.a * 255.0 + 0.5) / 255.0;
  outColor = vec4(premultiplied + back * (1.0 - ui.a), 1.0);
}
`;

/** Sparks drifting up through the frame, premultiplied as the front canvas is shown. */
const SPARK_FRAGMENT = `${GLSL_HEADER}
const int SPARKS = 24;
uniform vec3 u_sparks[SPARKS];
uniform vec3 u_colour;
uniform float u_opacity;

in vec2 v_uv;
out vec4 outColor;

void main() {
  float cover = 0.0;
  for (int i = 0; i < SPARKS; i++) {
    float distance = length(gl_FragCoord.xy - u_sparks[i].xy);
    cover = max(cover, smoothstep(u_sparks[i].z, u_sparks[i].z - 1.5, distance));
  }
  float alpha = cover * u_opacity;
  outColor = vec4(u_colour * alpha, alpha);
}
`;

const SPARKS = 24;
/** The frames the sparks cross, over the UI while it sits in front and under it while it sits behind. */
const SPARKS_FROM = 30;
const SPARKS_TO = 84;
const SPARK_RISE = 14;

interface Programs {
  field: WebGLProgram;
  sparks: WebGLProgram;
  vertices: WebGLVertexArrayObject;
  texture: WebGLTexture;
}

/** Each context's programs, built on its first call and the same on every call after. */
const built = new WeakMap<WebGL2RenderingContext, Programs>();

function stage(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) {
    throw new Error('engine-ui: the context made no shader');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    throw new Error(`engine-ui: ${gl.getShaderInfoLog(shader) ?? 'a shader did not compile'}`);
  }
  return shader;
}

function linked(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const program = gl.createProgram();
  gl.attachShader(program, stage(gl, gl.VERTEX_SHADER, FULLSCREEN_VERTEX));
  gl.attachShader(program, stage(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    throw new Error(`engine-ui: ${gl.getProgramInfoLog(program) ?? 'a program did not link'}`);
  }
  return program;
}

function programsOf(gl: WebGL2RenderingContext): Programs {
  const existing = built.get(gl);
  if (existing !== undefined) {
    return existing;
  }
  const programs: Programs = {
    field: linked(gl, FIELD_FRAGMENT),
    sparks: linked(gl, SPARK_FRAGMENT),
    vertices: gl.createVertexArray(),
    texture: gl.createTexture(),
  };
  built.set(gl, programs);
  return programs;
}

/** A `#rrggbb` colour as the sRGB channels a canvas stores, each in [0, 1]. */
function channels(hex: string): [number, number, number] {
  return [0, 2, 4].map((at) => Number.parseInt(hex.slice(1 + at, 3 + at), 16) / 255) as [
    number,
    number,
    number,
  ];
}

function fullscreen(gl: WebGL2RenderingContext, { vertices }: Programs): void {
  gl.bindVertexArray(vertices);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
}

/** The field, and on a texture frame the UI's pixels bent over it. */
function drawField(frame: number, ctx: LookContext<'webgl2'>): void {
  const gl = ctx.context;
  const programs = programsOf(gl);
  const { field } = programs;
  gl.useProgram(field);
  const at = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(field, name);
  gl.uniform2f(at('u_size'), ctx.width, ctx.height);
  gl.uniform1f(at('u_clock'), clockAt(frame));
  gl.uniform3f(at('u_field'), ...channels(ctx.brand.background));
  gl.uniform3f(at('u_red'), ...channels(ctx.brand.brandRed));
  gl.uniform3f(at('u_paper'), ...channels(ctx.brand.paper));
  gl.uniform1i(at('u_textured'), ctx.ui === null ? 0 : 1);
  if (ctx.ui !== null) {
    const warp = warpAt(frame);
    const filter = warp === 0 ? gl.NEAREST : gl.LINEAR;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, programs.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, ctx.ui);
    gl.uniform1i(at('u_ui'), 0);
    gl.uniform1f(at('u_warp'), warp);
  }
  fullscreen(gl, programs);
}

/** The sparks on the front canvas, rising through the frames they cross. */
function drawSparks(frame: number, ctx: LookContext<'webgl2'>): void {
  if (ctx.front === null || frame < SPARKS_FROM || frame >= SPARKS_TO) {
    return;
  }
  const gl = ctx.front.context;
  const programs = programsOf(gl);
  const { sparks } = programs;
  const next = ctx.random('sparks');
  const lived = frame - SPARKS_FROM;
  const positions = Array.from({ length: SPARKS }, () => {
    const x = next() * ctx.width;
    const y = (next() * ctx.height + lived * SPARK_RISE * (0.5 + next())) % ctx.height;
    return [x, y, 6 + next() * 10];
  }).flat();
  const fade = Math.min(1, lived / 8, (SPARKS_TO - frame) / 8);
  gl.useProgram(sparks);
  gl.uniform3fv(gl.getUniformLocation(sparks, 'u_sparks'), new Float32Array(positions));
  gl.uniform3f(gl.getUniformLocation(sparks, 'u_colour'), ...channels(ctx.brand.brandRed));
  gl.uniform1f(gl.getUniformLocation(sparks, 'u_opacity'), fade);
  fullscreen(gl, programs);
}

/**
 * The look draws on WebGL2 canvases. The look host loads it by path, so no
 * module imports these exports.
 * @toolContract
 */
export const context = 'webgl2';

/**
 * The field behind the UI, the UI bent by a shader on its texture frames, and
 * sparks on the front canvas.
 * @toolContract
 */
export const renderFrame: RenderFrame<'webgl2'> = (frame, ctx) => {
  drawField(frame, ctx);
  drawSparks(frame, ctx);
  return [];
};

/** @toolContract */
export function placeUi(frame: number): UiPlacement {
  return placementAt(frame);
}

/** @toolContract */
export { Ui } from './ui.js';
