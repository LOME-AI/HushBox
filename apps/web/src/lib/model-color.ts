const GOLDEN_ANGLE = 137.508;

export function modelIdToHue(modelId: string): number {
  let hash = 0;
  for (let index = 0; index < modelId.length; index++) {
    // eslint-disable-next-line unicorn/prefer-math-trunc -- | 0 is 32-bit integer coercion, not floor
    hash = ((hash << 5) - hash + (modelId.codePointAt(index) ?? 0)) | 0;
  }
  return (Math.abs(hash) * GOLDEN_ANGLE) % 360;
}

export interface ModelColor {
  bg: string;
  fg: string;
  bgDark: string;
  fgDark: string;
}

export function getModelColor(modelId: string): ModelColor {
  const hue = modelIdToHue(modelId);
  return {
    bg: `hsl(${String(hue)} 45% 90%)`,
    fg: `hsl(${String(hue)} 60% 30%)`,
    bgDark: `hsl(${String(hue)} 30% 20%)`,
    fgDark: `hsl(${String(hue)} 45% 75%)`,
  };
}
