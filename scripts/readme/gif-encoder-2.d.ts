declare module 'gif-encoder-2' {
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
    addFrame(ctx: CanvasRenderingContext2D): void;
    finish(): void;
    out: GifEncoderOutput;
  }

  export default GIFEncoder;
}
