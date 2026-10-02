import { GlError } from './gl-error.js';
import { createGlContext, createTarget, deleteTarget, linkProgram } from './gl-objects.driver.js';
import { assertPost, gaussianKernel } from './post.js';
import {
  BLOOM_RADIUS,
  BLOOM_SIGMA,
  BLUR_FRAGMENT,
  BRIGHT_FRAGMENT,
  COPY_FRAGMENT,
  FULLSCREEN_VERTEX,
  PLAIN_FRAGMENT,
  PRESENT_FRAGMENT,
} from './shaders.js';
import { subFrameOffsets } from './sub-frames.js';

import type { GlTarget } from './gl-objects.driver.js';
import type { GlContext, GlFrame, GlLayer, GlProgram } from './layer.js';
import type { PostSettings } from './post.js';

/** What the renderer asks of its host: frame holds, redraws and failures. */
export interface GlHooks {
  /** Holds the frame until the handle is released. */
  hold: (label: string) => number;
  release: (handle: number) => void;
  /** Asks for another draw: a load has landed. */
  invalidate: () => void;
  fail: (error: unknown) => void;
}

/** Draws whole frames into one canvas. */
export interface GlRenderer {
  /** Draws the frame and returns true, or returns false while a layer's resources are still loading. */
  draw: (frame: GlFrame) => boolean;
  dispose: () => void;
}

interface CacheEntry {
  value: unknown;
  dispose: (value: never) => void;
  used: boolean;
}

type Load = { state: 'pending'; handle: number } | { state: 'ready'; value: unknown };

interface Targets {
  scene: GlTarget;
  layer: GlTarget;
  scratch: GlTarget;
  near: [GlTarget, GlTarget];
  far: [GlTarget, GlTarget];
}

/** One layer of the frame and its copies at each of its sub-frame instants. */
interface LayerPlan {
  layer: GlLayer;
  instances: GlLayer[];
}

const BLOOM_WEIGHTS = new Float32Array(gaussianKernel(BLOOM_RADIUS, BLOOM_SIGMA));

function createTargets(gl: WebGL2RenderingContext, width: number, height: number): Targets {
  const half = [Math.ceil(width / 2), Math.ceil(height / 2)] as const;
  const quarter = [Math.ceil(width / 4), Math.ceil(height / 4)] as const;
  return {
    scene: createTarget(gl, width, height),
    layer: createTarget(gl, width, height),
    scratch: createTarget(gl, width, height),
    near: [createTarget(gl, ...half), createTarget(gl, ...half)],
    far: [createTarget(gl, ...quarter), createTarget(gl, ...quarter)],
  };
}

function indexPasses(passes: GlFrame['passes']): Map<number, Map<string, GlLayer>> {
  const index = new Map<number, Map<string, GlLayer>>();
  for (const [offset, layers] of passes) {
    const byId = new Map<string, GlLayer>();
    for (const layer of layers) {
      if (byId.has(layer.id)) {
        throw new RangeError(`GlCanvas layer ids are unique, and "${layer.id}" is drawn twice`);
      }
      byId.set(layer.id, layer);
    }
    index.set(offset, byId);
  }
  return index;
}

/** Each layer of the frame itself, with its copies at every one of its sub-frame instants that has one. */
function planLayers(frame: GlFrame): LayerPlan[] {
  const index = indexPasses(frame.passes);
  const primary = frame.passes.get(0) ?? [];
  return primary.map((layer) => ({
    layer,
    instances: subFrameOffsets(layer.samples).flatMap(
      (offset) => index.get(offset)?.get(layer.id) ?? []
    ),
  }));
}

/**
 * The renderer behind `GlCanvas`: it composites layers into a half-float scene,
 * blurring each across its own sub-frames, then finishes the frame with the post
 * chain, or, with none, presents the scene sRGB-encoded. Every draw rebuilds the whole frame from its inputs; caches only save work.
 */
export function createGlRenderer(canvas: HTMLCanvasElement, hooks: GlHooks): GlRenderer {
  const gl = createGlContext(canvas);
  const { width, height } = canvas;
  const targets = createTargets(gl, width, height);
  const emptyVertexArray = gl.createVertexArray();
  const programs = new Map<string, GlProgram>();
  const cache = new Map<string, CacheEntry>();
  const loads = new Map<string, Load>();
  let landed: number[] = [];

  const context: GlContext = {
    gl,
    program: (name, vertex, fragment) => {
      const existing = programs.get(name);
      if (existing !== undefined) {
        return existing;
      }
      const program = linkProgram(gl, name, vertex, fragment);
      programs.set(name, program);
      return program;
    },
    cached: <T>(key: string, build: () => T, dispose: (value: T) => void): T => {
      const entry = cache.get(key);
      if (entry !== undefined) {
        entry.used = true;
        // The entry was stored by this function under the same key, which always builds the same type.
        return entry.value as T;
      }
      const value = build();
      cache.set(key, { value, dispose, used: true });
      return value;
    },
    loaded: <T>(key: string, load: () => Promise<T>): T | undefined => {
      const entry = loads.get(key);
      if (entry?.state === 'ready') {
        // The entry was stored by this function under the same key, which always loads the same type.
        return entry.value as T;
      }
      if (entry === undefined) {
        const handle = hooks.hold(`GlCanvas: loading ${key.slice(0, 80)}`);
        loads.set(key, { state: 'pending', handle });
        void (async (): Promise<void> => {
          try {
            loads.set(key, { state: 'ready', value: await load() });
          } catch (error) {
            hooks.fail(error);
            return;
          }
          landed.push(handle);
          hooks.invalidate();
        })();
      }
      return undefined;
    },
  };

  const program = (name: string, fragment: string): GlProgram =>
    context.program(name, FULLSCREEN_VERTEX, fragment);

  function bind(target: GlTarget | null): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null);
    gl.viewport(0, 0, target?.width ?? width, target?.height ?? height);
  }

  function clear(target: GlTarget, [r, g, b, a]: readonly number[]): void {
    bind(target);
    gl.clearColor(r ?? 0, g ?? 0, b ?? 0, a ?? 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  function blend(mode: 'over' | 'add' | 'none'): void {
    if (mode === 'none') {
      gl.disable(gl.BLEND);
      return;
    }
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, mode === 'over' ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE);
  }

  function useTexture(unit: number, texture: WebGLTexture): void {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
  }

  function fullscreen(): void {
    gl.bindVertexArray(emptyVertexArray);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function copy(source: GlTarget, weight: number): void {
    const copyProgram = program('copy', COPY_FRAGMENT);
    gl.useProgram(copyProgram.program);
    gl.uniform1i(copyProgram.uniform('u_source'), 0);
    gl.uniform1f(copyProgram.uniform('u_weight'), weight);
    useTexture(0, source.texture);
    fullscreen();
  }

  /** A layer blurred across its sub-frames: each drawn alone, then averaged, then composited over the scene. */
  function drawBlurred({ layer, instances }: LayerPlan): void {
    clear(targets.layer, [0, 0, 0, 0]);
    for (const instance of instances) {
      clear(targets.scratch, [0, 0, 0, 0]);
      blend('over');
      instance.draw(context);
      bind(targets.layer);
      blend('add');
      copy(targets.scratch, 1 / layer.samples);
    }
    bind(targets.scene);
    blend('over');
    copy(targets.layer, 1);
  }

  function drawScene(plans: readonly LayerPlan[], background: GlFrame['background']): void {
    clear(targets.scene, [background[0], background[1], background[2], 1]);
    for (const plan of plans) {
      if (plan.layer.samples === 1) {
        bind(targets.scene);
        blend('over');
        plan.layer.draw(context);
      } else {
        drawBlurred(plan);
      }
    }
  }

  function blur([a, b]: [GlTarget, GlTarget]): void {
    const blurProgram = program('blur', BLUR_FRAGMENT);
    gl.useProgram(blurProgram.program);
    gl.uniform1i(blurProgram.uniform('u_source'), 0);
    gl.uniform1fv(blurProgram.uniform('u_weights'), BLOOM_WEIGHTS);
    for (const [source, destination, step] of [
      [a, b, [1 / a.width, 0]],
      [b, a, [0, 1 / a.height]],
    ] as const) {
      bind(destination);
      gl.uniform2f(blurProgram.uniform('u_step'), step[0], step[1]);
      useTexture(0, source.texture);
      fullscreen();
    }
  }

  function drawPost(post: PostSettings): void {
    blend('none');
    const bright = program('bright', BRIGHT_FRAGMENT);
    bind(targets.near[0]);
    gl.useProgram(bright.program);
    gl.uniform1i(bright.uniform('u_source'), 0);
    useTexture(0, targets.scene.texture);
    fullscreen();
    blur(targets.near);
    bind(targets.far[0]);
    copy(targets.near[0], 1);
    blur(targets.far);

    const present = program('present', PRESENT_FRAGMENT);
    bind(null);
    gl.useProgram(present.program);
    gl.uniform1i(present.uniform('u_scene'), 0);
    gl.uniform1i(present.uniform('u_bloomNear'), 1);
    gl.uniform1i(present.uniform('u_bloomFar'), 2);
    gl.uniform2f(present.uniform('u_resolution'), width, height);
    gl.uniform1f(present.uniform('u_bloom'), post.bloom);
    gl.uniform1f(present.uniform('u_aberration'), post.aberration);
    gl.uniform1f(present.uniform('u_vignette'), post.vignette);
    gl.uniform1f(present.uniform('u_flash'), post.flash);
    useTexture(0, targets.scene.texture);
    useTexture(1, targets.near[0].texture);
    useTexture(2, targets.far[0].texture);
    fullscreen();
  }

  function drawPlain(): void {
    blend('none');
    const plain = program('plain', PLAIN_FRAGMENT);
    bind(null);
    gl.useProgram(plain.program);
    gl.uniform1i(plain.uniform('u_scene'), 0);
    useTexture(0, targets.scene.texture);
    fullscreen();
  }

  function sweep(): void {
    for (const [key, entry] of cache) {
      if (entry.used) {
        entry.used = false;
      } else {
        // `dispose` was stored beside the value it was given for.
        (entry.dispose as (value: unknown) => void)(entry.value);
        cache.delete(key);
      }
    }
  }

  function draw(frame: GlFrame): boolean {
    if (gl.isContextLost()) {
      throw new GlError('context-lost', 'the WebGL2 context was lost before the frame was drawn');
    }
    if (frame.post !== null) {
      assertPost(frame.post);
    }
    const plans = planLayers(frame);
    const readiness = plans.flatMap(({ instances }) =>
      instances.map((instance) => instance.prepare(context))
    );
    if (!readiness.every(Boolean)) {
      return false;
    }
    drawScene(plans, frame.background);
    if (frame.post === null) {
      drawPlain();
    } else {
      drawPost(frame.post);
    }
    sweep();
    for (const handle of landed) {
      hooks.release(handle);
    }
    landed = [];
    return true;
  }

  function dispose(): void {
    for (const entry of cache.values()) {
      (entry.dispose as (value: unknown) => void)(entry.value);
    }
    cache.clear();
    for (const { program: linked } of programs.values()) {
      gl.deleteProgram(linked);
    }
    for (const target of [
      targets.scene,
      targets.layer,
      targets.scratch,
      ...targets.near,
      ...targets.far,
    ]) {
      deleteTarget(gl, target);
    }
    gl.deleteVertexArray(emptyVertexArray);
  }

  return { draw, dispose };
}
