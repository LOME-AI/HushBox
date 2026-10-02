import { FULLSCREEN_VERTEX, GLSL_HEADER } from '../visual/gl/index.js';

import type { GlLayer } from '../visual/gl/index.js';

/** The look's canvas as the host's scene reads it: its sRGB bytes decoded to linear light, premultiplied. */
const CANVAS_FRAGMENT = `${GLSL_HEADER}
uniform sampler2D u_canvas;

in vec2 v_uv;
out vec4 outColor;

vec3 decodeSrgb(vec3 encoded) {
  vec3 curve = pow(max((encoded + 0.055) / 1.055, 0.0), vec3(2.4));
  return mix(encoded / 12.92, curve, step(0.04045, encoded));
}

void main() {
  vec4 texel = texture(u_canvas, v_uv);
  outColor = vec4(decodeSrgb(texel.rgb) * texel.a, texel.a);
}
`;

function canvasTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

interface CanvasLayerOptions {
  id: string;
  samples: number;
  /** Draws this instant into the look's canvas and returns the canvas. */
  paint: () => HTMLCanvasElement;
}

/**
 * A layer drawing a 2D or WebGL2 canvas over the whole frame: each draw paints
 * the canvas, uploads its pixels as they stand, rows flipped to GL's
 * bottom-up order and with no colour conversion, and composites them.
 */
export function canvasLayer({ id, samples, paint }: CanvasLayerOptions): GlLayer {
  return {
    id,
    samples,
    prepare: () => true,
    draw: (context) => {
      const canvas = paint();
      const { gl } = context;
      const program = context.program('look-canvas', FULLSCREEN_VERTEX, CANVAS_FRAGMENT);
      const texture = context.cached(
        'look-canvas-texture',
        () => canvasTexture(gl),
        (built) => {
          gl.deleteTexture(built);
        }
      );
      const vertices = context.cached(
        'look-canvas-vertices',
        () => gl.createVertexArray(),
        (built) => {
          gl.deleteVertexArray(built);
        }
      );
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.useProgram(program.program);
      gl.uniform1i(program.uniform('u_canvas'), 0);
      gl.bindVertexArray(vertices);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    },
  };
}
