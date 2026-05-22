import { describe, it, expect } from 'vitest';
import { quadraticArcPath } from './arc-path';

describe('quadraticArcPath', () => {
  it('produces a valid SVG path string starting with M', () => {
    const path = quadraticArcPath({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(path).toMatch(/^M0,0 Q[\d.-]+,[\d.-]+ 100,0$/);
  });

  it('returns a straight line when source and target are identical', () => {
    const path = quadraticArcPath({ x: 50, y: 50 }, { x: 50, y: 50 });
    expect(path).toBe('M50,50 L50,50');
  });

  it('places the control point off the chord (creates a curve)', () => {
    const path = quadraticArcPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.5);
    // Lift = 100 * 0.5 = 50. Control midX = 50, midY = 0, lifted by 50 along
    // the normal (0, 1) gives (50, 50).
    expect(path).toBe('M0,0 Q50,50 100,0');
  });

  it('formats integer coordinates without a decimal', () => {
    const path = quadraticArcPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 0);
    expect(path).toBe('M0,0 Q50,0 100,0');
  });

  it('formats non-integer coordinates to two decimals', () => {
    // 5-13 chord with a 0.3 lift produces a non-integer control point so we
    // hit the toFixed(2) branch of the formatter.
    const path = quadraticArcPath({ x: 0, y: 0 }, { x: 5, y: 13 }, 0.3);
    expect(path).toContain('.');
  });
});
