declare module 'gif-encoder-2' {
  // The frame source the banner hands it: the same surface type the cipher-wall
  // renderer declares, so neither call site casts a native canvas context.
  type CanvasTextSurface =
    import('../../packages/ui/src/components/cipher-wall/cipher-wall-engine.js').CanvasTextSurface;

  type PaletteAlgorithm = 'neuquant' | 'octree';

  interface GifEncoderOutput {
    getData(): Buffer;
  }

  class GIFEncoder {
    constructor(
      width: number,
      height: number,
      algorithm?: PaletteAlgorithm,
      useOptimizer?: boolean,
      totalFrames?: number
    );
    setDelay(ms: number): void;
    setRepeat(count: number): void;
    setQuality(quality: number): void;
    setTransparent(color: number | null): void;
    setThreshold(threshold: number): void;
    start(): void;
    addFrame(ctx: CanvasTextSurface): void;
    finish(): void;
    out: GifEncoderOutput;
  }

  export default GIFEncoder;
}
