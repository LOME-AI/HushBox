import { shotAt } from './direct.js';
import { BG_FS, FULLSCREEN_VS, POST_FS } from './glsl-bg.js';
import { PARTICLE_FS, PARTICLE_VS } from './glsl-particles.js';
import { drawText } from './type.js';

import type { Layer } from './direct.js';
import type { LookContext, RenderFrame } from '../../../../engine/look/index.js';

type Gl = WebGL2RenderingContext;

interface Program {
  program: WebGLProgram;
  uniform: (name: string) => WebGLUniformLocation | null;
}

interface Gpu {
  bg: Program;
  particles: Program;
  post: Program;
  scene: WebGLTexture;
  sceneFbo: WebGLFramebuffer;
  text: WebGLTexture;
  vao: WebGLVertexArrayObject;
  paint: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

/** Each context's compiled programs and targets: built once, identical for every frame after. */
const built = new WeakMap<Gl, Gpu>();

function compile(gl: Gl, type: GLenum, source: string, name: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) {
    throw new Error(`origin-flight: the context made no shader for ${name}`);
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    throw new Error(`origin-flight: ${name} did not compile: ${gl.getShaderInfoLog(shader) ?? ''}`);
  }
  return shader;
}

function link(gl: Gl, vs: string, fs: string, name: string): Program {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vs, `${name} vertex`));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fs, `${name} fragment`));
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    throw new Error(`origin-flight: ${name} did not link: ${gl.getProgramInfoLog(program) ?? ''}`);
  }
  const cache = new Map<string, WebGLUniformLocation | null>();
  return {
    program,
    uniform: (uniform) => {
      if (!cache.has(uniform)) {
        cache.set(uniform, gl.getUniformLocation(program, uniform));
      }
      return cache.get(uniform) ?? null;
    },
  };
}

function build(gl: Gl, width: number, height: number): Gpu {
  if (gl.getExtension('EXT_color_buffer_float') === null) {
    throw new Error('origin-flight: the context cannot render to a float target (EXT_color_buffer_float)');
  }
  const levels = Math.floor(Math.log2(Math.max(width, height))) + 1;
  const scene = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, scene);
  gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA16F, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const sceneFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, scene, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error('origin-flight: the float scene target is incomplete');
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const text = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, text);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const paint = canvas.getContext('2d');
  if (paint === null) {
    throw new Error('origin-flight: the browser gave the type no 2D context');
  }
  return {
    bg: link(gl, FULLSCREEN_VS, BG_FS, 'the ground'),
    particles: link(gl, PARTICLE_VS, PARTICLE_FS, 'the particles'),
    post: link(gl, FULLSCREEN_VS, POST_FS, 'the finish'),
    scene,
    sceneFbo,
    text,
    vao: gl.createVertexArray(),
    paint,
    canvas,
    width,
    height,
  };
}

/** A `#rrggbb` colour as linear light. */
function linear(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex.trim());
  if (match === null) {
    throw new Error(`origin-flight: a brand colour is not #rrggbb: ${hex}`);
  }
  return [match[1], match[2], match[3]].map((part) => {
    const c = Number.parseInt(part ?? '0', 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}

function setWorld(gl: Gl, program: Program, layer: Layer, t: number, gpu: Gpu, shake: readonly [number, number], ctx: LookContext): void {
  const u = program.uniform;
  gl.uniform1i(u('u_world'), layer.world);
  gl.uniform1f(u('u_t'), t);
  gl.uniform4f(u('u_cam'), layer.cam.x, layer.cam.y, layer.cam.zoom, layer.cam.roll);
  gl.uniform2f(u('u_shake'), (shake[0] * 2) / gpu.width, (shake[1] * 2) / gpu.height);
  gl.uniform2f(u('u_res'), gpu.width, gpu.height);
  gl.uniform1f(u('u_gain'), layer.gain);
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'face0', 'face1', 'face2', 'face3'] as const) {
    gl.uniform4fv(u(`u_${key}`), layer[key]);
  }
  gl.uniform3fv(u('u_red'), linear(ctx.brand.brandRed));
  gl.uniform3fv(u('u_charcoal'), linear(ctx.brand.background));
}

/**
 * The look draws on a WebGL2 canvas and opts into motion blur. The look host
 * loads it by path, so no module imports these exports.
 * @toolContract
 */
export const context = 'webgl2';

/** @toolContract */
export const motionBlur = 3;

/**
 * One continuous flight: an ember becomes the Devil, his grin a galaxy of kept
 * words, a word an eye that cracks and leaks demons over the whole world, the
 * world one gold spiral of hundreds, and the one red spiral the HushBox mark.
 * @toolContract
 */
export const renderFrame: RenderFrame<'webgl2'> = (frame, ctx) => {
  const gl = ctx.context;
  const gpu = built.get(gl) ?? build(gl, ctx.width, ctx.height);
  built.set(gl, gpu);
  const t = ctx.time / ctx.fps;
  const shot = shotAt(t);
  const { finish } = shot;

  gl.bindFramebuffer(gl.FRAMEBUFFER, gpu.sceneFbo);
  gl.viewport(0, 0, gpu.width, gpu.height);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.SCISSOR_TEST);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendEquation(gl.FUNC_ADD);
  gl.blendFunc(gl.ONE, gl.ONE);
  gl.bindVertexArray(gpu.vao);
  for (const layer of shot.layers) {
    if (layer.gain <= 0.0001) {
      continue;
    }
    gl.useProgram(gpu.bg.program);
    setWorld(gl, gpu.bg, layer, t, gpu, finish.shake, ctx);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.useProgram(gpu.particles.program);
    setWorld(gl, gpu.particles, layer, t, gpu, finish.shake, ctx);
    gl.drawArrays(gl.POINTS, 0, layer.count);
  }
  gl.disable(gl.BLEND);
  gl.bindTexture(gl.TEXTURE_2D, gpu.scene);
  gl.generateMipmap(gl.TEXTURE_2D);

  gpu.paint.clearRect(0, 0, gpu.width, gpu.height);
  const { boxes, scrim } = drawText(gpu.paint, ctx.time, ctx);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, gpu.text);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gpu.canvas);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, gpu.scene);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, gpu.width, gpu.height);
  gl.useProgram(gpu.post.program);
  const u = gpu.post.uniform;
  gl.uniform1i(u('u_scene'), 0);
  gl.uniform1i(u('u_text'), 1);
  gl.uniform2f(u('u_res'), gpu.width, gpu.height);
  gl.uniform1f(u('u_exposure'), finish.exposure);
  gl.uniform4fv(u('u_flash'), finish.flash);
  gl.uniform1f(u('u_bloom'), finish.bloom);
  gl.uniform1f(u('u_aberr'), finish.aberration);
  gl.uniform1f(u('u_vignette'), finish.vignette);
  gl.uniform4f(u('u_scrim'), scrim.alpha, scrim.top, scrim.bottom, 150);
  gl.uniform1f(u('u_direct'), finish.direct);
  gl.uniform1f(u('u_frame'), frame);
  gl.uniform3fv(u('u_tint'), finish.tint);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return boxes;
};
