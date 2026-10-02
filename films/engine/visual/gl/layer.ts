import type { Rgba } from './color.js';
import type { PostSettings } from './post.js';

/** A linked shader program and its uniform locations, looked up once each. */
export interface GlProgram {
  program: WebGLProgram;
  uniform: (name: string) => WebGLUniformLocation | null;
}

/** What `GlCanvas` lends a layer while it prepares and draws. */
export interface GlContext {
  gl: WebGL2RenderingContext;
  /** The program for this name, compiled and linked on first use. */
  program: (name: string, vertex: string, fragment: string) => GlProgram;
  /**
   * The value for this key, built on first use and kept while frames keep using it.
   * The same key must always build the same value: the cache is invisible in the frame.
   */
  cached: <T>(key: string, build: () => T, dispose: (value: T) => void) => T;
  /**
   * The value for this key once `load` has resolved, and `undefined` until then;
   * the canvas holds the frame while any load is pending and redraws when it lands.
   */
  loaded: <T>(key: string, load: () => Promise<T>) => T | undefined;
}

/**
 * One thing a `GlCanvas` draws. Motion blur renders the canvas's children again at
 * sub-frame instants, and a layer's copies there are matched to it by `id`.
 */
export interface GlLayer {
  /** Unique among the layers of one canvas. */
  id: string;
  /** Motion-blur samples across the shutter; 1 draws the frame's own instant only. */
  samples: number;
  /** Starts loading whatever the layer needs; true once all of it has loaded. */
  prepare: (context: GlContext) => boolean;
  /**
   * Draws the layer premultiplied over the bound half-float target in linear light,
   * with blending set to premultiplied over. It sets its own program, buffers and
   * textures, and leaves the framebuffer and viewport as it found them.
   */
  draw: (context: GlContext) => void;
}

/** What a marker element under a `GlCanvas` registers: layers to draw, or the post chain. */
export type GlRegistration =
  | { kind: 'layers'; layers: readonly GlLayer[] }
  | { kind: 'post'; post: PostSettings };

/** Everything one frame draws. */
export interface GlFrame {
  /** The scene's clear colour in linear light. */
  background: Rgba;
  /** Each pass's layers in draw order, keyed by its sub-frame offset; 0 is the frame itself. */
  passes: ReadonlyMap<number, readonly GlLayer[]>;
  /** The post chain that finishes the frame; null presents the scene sRGB-encoded and nothing else. */
  post: PostSettings | null;
}
