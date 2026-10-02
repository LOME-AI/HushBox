import { GlError } from './gl-error.js';

import type { GlProgram } from './layer.js';

/** A half-float colour target and the framebuffer that draws into it. */
export interface GlTarget {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

/**
 * The canvas's one WebGL2 context: opaque, unmultisampled, and preserving its buffer
 * so the renderer's screenshot reads the frame drawn, whenever it is taken.
 */
export function createGlContext(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  if (gl === null) {
    throw new GlError(
      'unsupported',
      'the browser gave no WebGL2 context; render with --gl=angle, or swangle without a GPU'
    );
  }
  if (gl.getExtension('EXT_color_buffer_float') === null) {
    throw new GlError(
      'unsupported',
      'EXT_color_buffer_float is missing, so no half-float target can be drawn into'
    );
  }
  return gl;
}

function assertLive(gl: WebGL2RenderingContext): void {
  if (gl.isContextLost()) {
    throw new GlError('context-lost', 'the WebGL2 context was lost');
  }
}

function compileShader(
  gl: WebGL2RenderingContext,
  name: string,
  type: GLenum,
  source: string
): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) {
    assertLive(gl);
    throw new GlError('unsupported', `${name}: the context made no shader`);
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    assertLive(gl);
    const log = gl.getShaderInfoLog(shader) ?? 'no log';
    gl.deleteShader(shader);
    throw new GlError('shader-compile', `${name}: ${log}`);
  }
  return shader;
}

/** A program compiled and linked from its sources, failing with a named error that carries the driver's log. */
export function linkProgram(
  gl: WebGL2RenderingContext,
  name: string,
  vertex: string,
  fragment: string
): GlProgram {
  const program = gl.createProgram();
  const shaders = [
    compileShader(gl, `${name} vertex shader`, gl.VERTEX_SHADER, vertex),
    compileShader(gl, `${name} fragment shader`, gl.FRAGMENT_SHADER, fragment),
  ];
  for (const shader of shaders) {
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  for (const shader of shaders) {
    gl.deleteShader(shader);
  }
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    assertLive(gl);
    throw new GlError('program-link', `${name}: ${gl.getProgramInfoLog(program) ?? 'no log'}`);
  }
  const locations = new Map<string, WebGLUniformLocation | null>();
  return {
    program,
    uniform: (uniform) => {
      if (!locations.has(uniform)) {
        locations.set(uniform, gl.getUniformLocation(program, uniform));
      }
      return locations.get(uniform) ?? null;
    },
  };
}

/** A linearly filtered, edge-clamped half-float target of the given size. */
export function createTarget(gl: WebGL2RenderingContext, width: number, height: number): GlTarget {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    assertLive(gl);
    throw new GlError(
      'framebuffer',
      `a ${String(width)}×${String(height)} half-float target is incomplete (status ${String(status)})`
    );
  }
  return { texture, framebuffer, width, height };
}

/** Deletes a target's texture and framebuffer. */
export function deleteTarget(gl: WebGL2RenderingContext, target: GlTarget): void {
  gl.deleteFramebuffer(target.framebuffer);
  gl.deleteTexture(target.texture);
}
