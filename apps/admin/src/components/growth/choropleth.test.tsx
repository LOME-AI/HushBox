import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Choropleth } from './choropleth.js';
import { CHOROPLETH_STEP_CLASSES } from './choropleth-scale.js';
import { summedCountLabel } from './summed-label.js';

/** What a region's figure is called, from the one definition every surface reads. */
const VISITORS = summedCountLabel('Visitors', 'daily');

/** What a share is a share of, which the panel names and the map only states. */
const SHARE_LABEL = 'Share of all counted in the world';
import type { RegionReading } from './choropleth.js';
import type { Topology } from 'topojson-specification';

/**
 * A two-region topology in the shape the vendored atlases use: a quantised
 * arc set with one polygon per region, keyed by the ids the mapping tables
 * translate.
 */
const TOPOLOGY = {
  type: 'Topology',
  transform: { scale: [0.01, 0.01], translate: [0, 0] },
  arcs: [
    [
      [0, 0],
      [100, 0],
      [0, 100],
      [-100, 0],
      [0, -100],
    ],
    [
      [200, 0],
      [100, 0],
      [0, 100],
      [-100, 0],
      [0, -100],
    ],
  ],
  objects: {
    regions: {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Polygon', id: '001', arcs: [[0]], properties: { name: 'Firstland' } },
        { type: 'Polygon', id: '002', arcs: [[1]], properties: { name: 'Secondland' } },
      ],
    },
  },
} as unknown as Topology;

/**
 * A region counted at a figure that is exact, as most of these cases are, and
 * alone in its range unless a case says otherwise.
 */
function counted(visitors: number, over: Partial<RegionReading> = {}): RegionReading {
  return { visitors, overflow: false, share: 1, rank: 1, of: 1, ...over };
}

/**
 * The map's readout and its legend, found by the slot each carries: the readout
 * is hidden from the accessible tree, because every figure in it is already in
 * the region's own name, so no role reaches it.
 */
function readout(): HTMLElement | null {
  return document.querySelector('[data-slot="choropleth-readout"]');
}

function readingNow(): HTMLElement {
  const found = readout();
  if (found === null) throw new Error('no region is being read');
  return found;
}

/**
 * The box the frame would have on screen. Neither renderer lays anything out,
 * so a test about where the readout may sit has to state the geometry the
 * component reads its bounds from.
 */
function frameBoxed(container: HTMLElement, box: DOMRect): void {
  const found = container.querySelector<HTMLElement>('[data-slot="choropleth-frame"]');
  if (found === null) throw new Error('the map drew no frame');
  found.getBoundingClientRect = () => box;
}

/**
 * The height of the viewport the card is bounded against. Neither renderer has
 * one that means anything, so a test about that bound states the height the
 * component reads.
 */
function viewportOf(height: number): void {
  Object.defineProperty(globalThis, 'innerHeight', { value: height, configurable: true });
}

function legend(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[data-slot="choropleth-legend"]');
  if (found === null) throw new Error('the map drew no legend');
  return found;
}

/** The height of the box the drawing was fitted into, off its own viewBox. */
function boxHeight(container: HTMLElement): number {
  const box = container.querySelector('svg')?.getAttribute('viewBox') ?? '';
  return Number(box.split(' ')[3]);
}

function renderMap(
  readings: ReadonlyMap<string, RegionReading>,
  over: Partial<React.ComponentProps<typeof Choropleth>> = {}
): ReturnType<typeof render> {
  return render(
    <Choropleth
      topology={TOPOLOGY}
      objectName="regions"
      projection="naturalEarth1"
      readings={readings}
      countLabel={VISITORS}
      shareLabel={SHARE_LABEL}
      codeForId={(id) => (id === '001' ? 'AA' : 'BB')}
      title="Where visitors are"
      {...over}
    />
  );
}

describe('Choropleth', () => {
  it('draws one shape per region in the geometry', () => {
    const { container } = renderMap(new Map([['AA', counted(10)]]));
    expect(container.querySelectorAll('path')).toHaveLength(2);
  });

  it('gives every region keyboard focus', () => {
    renderMap(new Map([['AA', counted(10)]]));
    for (const region of screen.getAllByRole('img')) {
      expect(region).toHaveAttribute('tabindex', '0');
    }
  });

  it('says a region was not counted rather than calling it zero', () => {
    renderMap(new Map([['AA', counted(10)]]));
    expect(screen.getByRole('img', { name: /Secondland: not counted/ })).toBeInTheDocument();
  });

  it('shades a counted region differently from an uncounted one', () => {
    const { container } = renderMap(new Map([['AA', counted(10)]]));
    const [first, second] = [...container.querySelectorAll('path')];
    expect(first?.getAttribute('class')).not.toBe(second?.getAttribute('class'));
  });

  it('leaves the browser no title element to draw its own tooltip from', () => {
    const { container } = renderMap(new Map([['AA', counted(10)]]));
    expect(container.querySelectorAll('title')).toHaveLength(0);
  });

  it('names a counted region with its share and its rank as well as its figure', () => {
    renderMap(new Map([['AA', counted(10, { share: 0.25, rank: 2, of: 4 })]]));
    expect(
      screen.getByRole('img', {
        name: `Firstland. ${VISITORS}: 10. ${SHARE_LABEL}: 25.0%. Rank 2 of 4.`,
      })
    ).toBeInTheDocument();
  });

  it('reports the region that was activated', async () => {
    const onSelect = vi.fn();
    renderMap(new Map([['AA', counted(10)]]), { onSelect });
    await userEvent.click(screen.getByRole('img', { name: /Firstland/ }));
    expect(onSelect).toHaveBeenCalledWith('AA');
  });

  it('activates a region from the keyboard as well as the pointer', async () => {
    const onSelect = vi.fn();
    renderMap(new Map([['AA', counted(10)]]), { onSelect });
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('AA');
  });

  it('leaves regions inert when nothing is listening for a selection', async () => {
    renderMap(new Map([['AA', counted(10)]]));
    const region = screen.getByRole('img', { name: /Firstland/ });
    await userEvent.click(region);
    expect(region).not.toHaveAttribute('aria-disabled');
  });
});

describe('Choropleth edge cases', () => {
  it('treats a region whose code cannot be resolved as uncounted', () => {
    render(
      <Choropleth
        topology={TOPOLOGY}
        objectName="regions"
        projection="naturalEarth1"
        readings={new Map([['AA', counted(10)]])}
        countLabel={VISITORS}
        shareLabel={SHARE_LABEL}
        codeForId={() => null}
        title="Where visitors are"
      />
    );
    expect(screen.getByRole('img', { name: /Firstland: not counted/ })).toBeInTheDocument();
  });

  it('draws nothing when the topology has no such layer', () => {
    const { container } = render(
      <Choropleth
        topology={TOPOLOGY}
        objectName="absent"
        projection="naturalEarth1"
        readings={new Map()}
        countLabel={VISITORS}
        shareLabel={SHARE_LABEL}
        codeForId={() => 'AA'}
        title="Where visitors are"
      />
    );
    expect(container.querySelectorAll('path')).toHaveLength(0);
  });

  it('ignores a key that is neither enter nor space', async () => {
    const onSelect = vi.fn();
    renderMap(new Map([['AA', counted(10)]]), { onSelect });
    await userEvent.tab();
    await userEvent.keyboard('{ArrowRight}');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('reports nothing for a region whose code cannot be resolved', async () => {
    const onSelect = vi.fn();
    render(
      <Choropleth
        topology={TOPOLOGY}
        objectName="regions"
        projection="naturalEarth1"
        readings={new Map()}
        countLabel={VISITORS}
        shareLabel={SHARE_LABEL}
        codeForId={() => null}
        title="Where visitors are"
        onSelect={onSelect}
      />
    );
    await userEvent.click(screen.getByRole('img', { name: /Firstland/ }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('activates a region with the space bar as well as enter', async () => {
    const onSelect = vi.fn();
    renderMap(new Map([['AA', counted(10)]]), { onSelect });
    await userEvent.tab();
    await userEvent.keyboard(' ');
    expect(onSelect).toHaveBeenCalledWith('AA');
  });
});

describe('Choropleth naming', () => {
  const UNNAMED = {
    ...TOPOLOGY,
    objects: {
      regions: {
        type: 'GeometryCollection',
        geometries: [{ type: 'Polygon', id: '001', arcs: [[0]], properties: {} }],
      },
    },
  } as unknown as Topology;

  it('falls back to the geometry id when the region carries no name', () => {
    render(
      <Choropleth
        topology={UNNAMED}
        objectName="regions"
        projection="naturalEarth1"
        readings={new Map()}
        countLabel={VISITORS}
        shareLabel={SHARE_LABEL}
        codeForId={() => 'AA'}
        title="Where visitors are"
      />
    );
    expect(screen.getByRole('img', { name: /^001: not counted/ })).toBeInTheDocument();
  });
});

describe('Choropleth with an unusable geometry name', () => {
  const BLANK_NAME = {
    ...TOPOLOGY,
    objects: {
      regions: {
        type: 'GeometryCollection',
        geometries: [{ type: 'Polygon', id: '001', arcs: [[0]], properties: { name: '' } }],
      },
    },
  } as unknown as Topology;

  it('falls back to the geometry id when the name is empty', () => {
    render(
      <Choropleth
        topology={BLANK_NAME}
        objectName="regions"
        projection="naturalEarth1"
        readings={new Map()}
        countLabel={VISITORS}
        shareLabel={SHARE_LABEL}
        codeForId={() => 'AA'}
        title="Where visitors are"
      />
    );
    expect(screen.getByRole('img', { name: /^001: not counted/ })).toBeInTheDocument();
  });

  it('names a geometry with no id at all by the name it carries', () => {
    const NO_ID = {
      ...TOPOLOGY,
      objects: {
        regions: {
          type: 'GeometryCollection',
          geometries: [{ type: 'Polygon', arcs: [[0]], properties: { name: 'Kosovo' } }],
        },
      },
    } as unknown as Topology;
    render(
      <Choropleth
        topology={NO_ID}
        objectName="regions"
        projection="naturalEarth1"
        readings={new Map()}
        countLabel={VISITORS}
        shareLabel={SHARE_LABEL}
        codeForId={() => null}
        title="Where visitors are"
      />
    );
    expect(screen.getByRole('img', { name: /Kosovo: not counted/ })).toBeInTheDocument();
  });
});

describe('Choropleth over a layer holding more than one geometry with no id', () => {
  /**
   * Two shapes the file gives no `id`, which is the shape of the vendored world
   * atlas: three of its 177 countries carry none.
   */
  const NO_IDS = {
    ...TOPOLOGY,
    objects: {
      regions: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Polygon', arcs: [[0]], properties: { name: 'Kosovo' } },
          { type: 'Polygon', arcs: [[1]], properties: { name: 'Somaliland' } },
        ],
      },
    },
  } as unknown as Topology;

  function renderWithoutIds(): ReturnType<typeof render> {
    return render(
      <Choropleth
        topology={NO_IDS}
        objectName="regions"
        projection="naturalEarth1"
        readings={new Map()}
        countLabel={VISITORS}
        shareLabel={SHARE_LABEL}
        codeForId={() => null}
        title="Where visitors are"
      />
    );
  }

  it('gives each of them a key of its own', () => {
    const warnings: string[] = [];
    const errors = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string') warnings.push(args[0]);
    });
    try {
      renderWithoutIds();
    } finally {
      errors.mockRestore();
    }
    expect(
      warnings.filter((warning) => warning.includes('two children with the same key'))
    ).toEqual([]);
  });

  it('draws a shape for each of them', () => {
    const { container } = renderWithoutIds();
    expect(container.querySelectorAll('path')).toHaveLength(2);
  });
});

describe('Choropleth orientation', () => {
  /**
   * Two bands, one over the other, in coordinates that are already screen
   * coordinates — the shape of the vendored United States atlas, whose Albers
   * projection is baked into the file with y growing downwards.
   */
  const BANDS = {
    type: 'Topology',
    arcs: [
      [
        [0, 0],
        [10, 0],
        [10, 4],
        [0, 4],
        [0, 0],
      ],
      [
        [0, 6],
        [10, 6],
        [10, 10],
        [0, 10],
        [0, 6],
      ],
    ],
    objects: {
      regions: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Polygon', id: 'N', arcs: [[0]], properties: { name: 'Upper band' } },
          { type: 'Polygon', id: 'S', arcs: [[1]], properties: { name: 'Lower band' } },
        ],
      },
    },
  } as unknown as Topology;

  /**
   * The same two bands as longitude and latitude, far enough apart in latitude
   * that no projection's curvature can reorder them. Wound clockwise, which is
   * the winding d3 reads as the inside of a spherical polygon; the other
   * direction names everything outside the band instead.
   */
  const HEMISPHERES = {
    ...BANDS,
    arcs: [
      [
        [-10, 60],
        [-10, 70],
        [10, 70],
        [10, 60],
        [-10, 60],
      ],
      [
        [-10, -70],
        [-10, -60],
        [10, -60],
        [10, -70],
        [-10, -70],
      ],
    ],
    objects: {
      regions: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Polygon', id: 'N', arcs: [[0]], properties: { name: 'Far north' } },
          { type: 'Polygon', id: 'S', arcs: [[1]], properties: { name: 'Far south' } },
        ],
      },
    },
  } as unknown as Topology;

  /** Every y the drawn outline passes through, read off the path's own commands. */
  function drawnYs(shape: Element | undefined): readonly number[] {
    const commands = shape?.getAttribute('d') ?? '';
    return [...commands.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((pair) => Number(pair[2]));
  }

  function bandsUnder(
    projection: 'identity' | 'naturalEarth1',
    topology: Topology
  ): ReturnType<typeof render> {
    return render(
      <Choropleth
        topology={topology}
        objectName="regions"
        projection={projection}
        readings={new Map()}
        countLabel={VISITORS}
        shareLabel={SHARE_LABEL}
        codeForId={() => null}
        title="Across the United States"
      />
    );
  }

  it('lands a pre-projected northern region in the upper half of the drawing', () => {
    const { container } = bandsUnder('identity', BANDS);
    const [upper, lower] = [...container.querySelectorAll('path')];
    // The box is fitted to the geometry, so the midline is read off the drawing
    // rather than remembered: the two bands sit either side of it.
    const midline = boxHeight(container) / 2;
    expect(Math.max(...drawnYs(upper))).toBeLessThanOrEqual(midline);
    expect(Math.min(...drawnYs(lower))).toBeGreaterThanOrEqual(midline);
  });

  it('lands the far north above the far south on the projected world', () => {
    const { container } = bandsUnder('naturalEarth1', HEMISPHERES);
    const [north, south] = [...container.querySelectorAll('path')];
    expect(Math.max(...drawnYs(north))).toBeLessThan(Math.min(...drawnYs(south)));
  });
});

describe('Choropleth tooltip', () => {
  const READINGS = new Map([['AA', counted(10, { share: 0.25, rank: 2, of: 4 })]]);

  async function hoverFirstland(): Promise<void> {
    await userEvent.hover(screen.getByRole('img', { name: /Firstland/ }));
  }

  it('shows nothing until a region is read', () => {
    renderMap(READINGS);
    expect(readout()).not.toBeInTheDocument();
  });

  it('carries the region, its figure, its share and its rank while the pointer reads it', async () => {
    renderMap(READINGS);
    await hoverFirstland();
    const shown = readingNow();
    expect(shown).toHaveTextContent('Firstland');
    expect(shown).toHaveTextContent('10');
    expect(shown).toHaveTextContent('25.0%');
    expect(shown).toHaveTextContent('2 of 4');
  });

  it('says a region was not counted rather than showing it a share', async () => {
    renderMap(READINGS);
    await userEvent.hover(screen.getByRole('img', { name: /Secondland/ }));
    const shown = readingNow();
    expect(shown).toHaveTextContent('not counted');
    expect(shown).not.toHaveTextContent('%');
  });

  it('is dismissed by the escape key with the pointer left where it was', async () => {
    renderMap(READINGS);
    await hoverFirstland();
    await userEvent.keyboard('{Escape}');
    expect(readout()).not.toBeInTheDocument();
  });

  it('stays dismissed while the pointer keeps reading the same region', async () => {
    renderMap(READINGS);
    await hoverFirstland();
    await userEvent.keyboard('{Escape}');
    await hoverFirstland();
    expect(readout()).not.toBeInTheDocument();
  });

  it('reads the next region the pointer moves to after a dismissal', async () => {
    renderMap(READINGS);
    await hoverFirstland();
    await userEvent.keyboard('{Escape}');
    await userEvent.hover(screen.getByRole('img', { name: /Secondland/ }));
    expect(readingNow()).toHaveTextContent('Secondland');
  });

  it('reads a region the pointer returns to once another has been read since', async () => {
    renderMap(READINGS);
    await hoverFirstland();
    await userEvent.keyboard('{Escape}');
    await userEvent.hover(screen.getByRole('img', { name: /Secondland/ }));
    await hoverFirstland();
    // The card names whatever the pointer is on. A dismissal held past the
    // reading that replaced it leaves the previous region's figures standing
    // under a pointer that has moved on, which is a figure against the wrong
    // place.
    expect(readingNow()).toHaveTextContent('Firstland');
  });

  it('reads a region the keyboard returns to once another has been read since', async () => {
    renderMap(READINGS);
    await userEvent.tab();
    await userEvent.keyboard('{Escape}');
    await userEvent.tab();
    await userEvent.tab({ shift: true });
    expect(readingNow()).toHaveTextContent('Firstland');
  });

  it('reads a dismissed region focused again after focus had left it', async () => {
    renderMap(READINGS);
    const region = screen.getByRole('img', { name: /Firstland/ });
    await userEvent.tab();
    await userEvent.keyboard('{Escape}');
    // Focus leaving is the keyboard's own way out of a dismissal: no pointer
    // leaves the map on that path, and nothing else clears it.
    fireEvent.focusOut(region);
    fireEvent.focus(region);
    expect(readingNow()).toHaveTextContent('Firstland');
  });

  it('takes no pointer of its own, so moving onto it cannot close it', async () => {
    renderMap(READINGS);
    await hoverFirstland();
    expect(readingNow()).toHaveClass('pointer-events-none');
  });

  it('goes when the pointer leaves the map', async () => {
    renderMap(READINGS);
    await hoverFirstland();
    await userEvent.unhover(screen.getByRole('img', { name: /Firstland/ }));
    expect(readout()).not.toBeInTheDocument();
  });

  it('anchors to the region itself when the keyboard reaches it', async () => {
    renderMap(READINGS);
    await userEvent.tab();
    expect(readingNow()).toHaveTextContent('Firstland');
  });

  it('follows the keyboard on to the next region', async () => {
    renderMap(READINGS);
    await userEvent.tab();
    await userEvent.tab();
    expect(readingNow()).toHaveTextContent('Secondland');
  });

  it('goes when keyboard focus leaves the region', async () => {
    renderMap(READINGS);
    await userEvent.tab();
    fireEvent.focusOut(screen.getByRole('img', { name: /Firstland/ }));
    expect(readout()).not.toBeInTheDocument();
  });

  it('says nothing to a screen reader that the region has not said already', async () => {
    renderMap(READINGS);
    await hoverFirstland();
    expect(readingNow()).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws itself below the pointer where there is no room above it', () => {
    renderMap(READINGS);
    viewportOf(800);
    const region = screen.getByRole('img', { name: /Firstland/ });
    // Which side the card is drawn on is the term the bound prefers: upwards
    // by its own height and a gap, or downwards by the gap alone.
    fireEvent.pointerMove(region, { clientX: 40, clientY: 400 });
    expect(readingNow().style.getPropertyValue('--readout-y')).toBe(
      'max(-392px, min(-100% - 0.75rem, 392px - 100%))'
    );
    fireEvent.pointerMove(region, { clientX: 40, clientY: 4 });
    expect(readingNow().style.getPropertyValue('--readout-y')).toBe(
      'max(4px, min(0.75rem, 788px - 100%))'
    );
  });

  it('holds its ground while the pointer is moved across it', async () => {
    const { container } = renderMap(READINGS);
    await hoverFirstland();
    const shown = readingNow();
    // Neither renderer lays anything out, so the card is given the box it
    // would have on screen: the pointer is then moved to a point inside it.
    shown.getBoundingClientRect = () => new DOMRect(100, 50, 200, 100);
    const map = container.querySelector('svg');
    if (map === null) throw new Error('the map drew no svg');
    fireEvent.pointerMove(map, { clientX: 200, clientY: 100 });
    expect(readout()).toBeInTheDocument();
    expect(readingNow()).toHaveTextContent('Firstland');
  });

  it('stops reading a region when the pointer moves off every shape', async () => {
    const { container } = renderMap(READINGS);
    await hoverFirstland();
    const map = container.querySelector('svg');
    if (map === null) throw new Error('the map drew no svg');
    fireEvent.pointerMove(map, { clientX: 1, clientY: 1 });
    expect(readout()).not.toBeInTheDocument();
  });

  it('outlines the region it is reading', async () => {
    const { container } = renderMap(READINGS);
    expect(container.querySelectorAll('path.stroke-foreground')).toHaveLength(0);
    await hoverFirstland();
    expect(container.querySelectorAll('path.stroke-foreground')).toHaveLength(1);
  });

  it('names the set the share it states was taken against', async () => {
    renderMap(READINGS);
    await hoverFirstland();
    expect(readingNow()).toHaveTextContent(SHARE_LABEL);
  });

  it('holds its left edge inside the frame where the pointer is at the frame edge', () => {
    const { container } = renderMap(READINGS);
    frameBoxed(container, new DOMRect(0, 0, 880, 400));
    fireEvent.pointerMove(screen.getByRole('img', { name: /Firstland/ }), {
      clientX: 8,
      clientY: 300,
    });
    // The clamp is the browser's arithmetic because the card's own width is:
    // centred on the pointer, and neither edge past the frame's.
    expect(readingNow().style.getPropertyValue('--readout-x')).toBe(
      'max(0px, min(8px - 50%, 880px - 100%))'
    );
  });

  it('holds its right edge inside the frame where the pointer is at the far edge', () => {
    const { container } = renderMap(READINGS);
    frameBoxed(container, new DOMRect(0, 0, 880, 400));
    fireEvent.pointerMove(screen.getByRole('img', { name: /Firstland/ }), {
      clientX: 876,
      clientY: 300,
    });
    expect(readingNow().style.getPropertyValue('--readout-x')).toBe(
      'max(0px, min(876px - 50%, 880px - 100%))'
    );
  });

  it('is never wider than the frame it is drawn in', () => {
    const { container } = renderMap(READINGS);
    frameBoxed(container, new DOMRect(0, 0, 240, 400));
    fireEvent.pointerMove(screen.getByRole('img', { name: /Firstland/ }), {
      clientX: 8,
      clientY: 300,
    });
    expect(readingNow().style.getPropertyValue('--readout-width')).toBe('min(16rem, 240px)');
  });

  it('is measured against the frame the pointer is in, not the last one', () => {
    const { container } = renderMap(READINGS);
    frameBoxed(container, new DOMRect(0, 0, 880, 400));
    const region = screen.getByRole('img', { name: /Firstland/ });
    fireEvent.pointerMove(region, { clientX: 8, clientY: 300 });
    frameBoxed(container, new DOMRect(0, 0, 320, 400));
    fireEvent.pointerMove(region, { clientX: 9, clientY: 300 });
    expect(readingNow().style.getPropertyValue('--readout-width')).toBe('min(16rem, 320px)');
  });

  it('keeps reading its region while the pointer is moved across the card', async () => {
    const { container } = renderMap(READINGS);
    frameBoxed(container, new DOMRect(0, 0, 880, 400));
    await hoverFirstland();
    // The card takes no pointer of its own, so a pointer moved across it lands
    // on whatever is under it — here the other region. WCAG 1.4.13's hoverable
    // condition is that the card reads on rather than swapping under the
    // pointer that is reading it.
    readingNow().getBoundingClientRect = () => new DOMRect(100, 50, 200, 100);
    fireEvent.pointerMove(screen.getByRole('img', { name: /Secondland/ }), {
      clientX: 200,
      clientY: 100,
    });
    expect(readingNow()).toHaveTextContent('Firstland');
  });

  it('reads the region the keyboard reaches under the card already drawn', async () => {
    const { container } = renderMap(READINGS);
    frameBoxed(container, new DOMRect(0, 0, 880, 400));
    await hoverFirstland();
    // Keyboard focus is not a pointer: a region reached by tabbing is read out
    // even when the card standing over it would swallow a pointer there, which
    // is what leaves a keyboard reader with no readout at all.
    readingNow().getBoundingClientRect = () => new DOMRect(100, 50, 200, 100);
    const next = screen.getByRole('img', { name: /Secondland/ });
    next.getBoundingClientRect = () => new DOMRect(150, 60, 40, 20);
    fireEvent.focus(next);
    expect(readingNow()).toHaveTextContent('Secondland');
  });

  it('hangs under the region the keyboard reached, not over it', () => {
    const { container } = renderMap(READINGS);
    viewportOf(800);
    frameBoxed(container, new DOMRect(0, 0, 880, 400));
    const region = screen.getByRole('img', { name: /Firstland/ });
    // A region whose top is within the room the card needs above it: the card
    // is drawn downwards, and from the region's own bottom edge, so the shape
    // it names and the outline marking it focused are both still visible.
    region.getBoundingClientRect = () => new DOMRect(200, 10, 120, 110);
    fireEvent.focus(region);
    const shown = readingNow();
    expect(shown.style.getPropertyValue('--readout-y')).toBe(
      'max(-112px, min(0.75rem, 672px - 100%))'
    );
    expect(shown.style.top).toBe('120px');
  });

  it('sits above the region the keyboard reached where there is room', () => {
    const { container } = renderMap(READINGS);
    viewportOf(800);
    frameBoxed(container, new DOMRect(0, 0, 880, 400));
    const region = screen.getByRole('img', { name: /Firstland/ });
    region.getBoundingClientRect = () => new DOMRect(200, 220, 120, 110);
    fireEvent.focus(region);
    const shown = readingNow();
    expect(shown.style.getPropertyValue('--readout-y')).toBe(
      'max(-212px, min(-100% - 0.75rem, 572px - 100%))'
    );
    expect(shown.style.top).toBe('220px');
  });

  it('holds its foot inside the viewport where the frame sits at the fold', () => {
    const { container } = renderMap(READINGS);
    viewportOf(800);
    // The frame is a sliver at the foot of the viewport, which is what a short
    // map under a tall font-scaling tier is: the card is taller than the frame
    // and the room under the pointer, so the bound that keeps it on screen is
    // the viewport's, not the frame's.
    frameBoxed(container, new DOMRect(0, 700, 880, 105));
    fireEvent.pointerMove(screen.getByRole('img', { name: /Firstland/ }), {
      clientX: 400,
      clientY: 740,
    });
    expect(readingNow().style.getPropertyValue('--readout-y')).toBe(
      'max(-732px, min(0.75rem, 52px - 100%))'
    );
  });

  it('holds its head inside the viewport where the frame starts above it', () => {
    const { container } = renderMap(READINGS);
    viewportOf(800);
    frameBoxed(container, new DOMRect(0, -200, 880, 400));
    fireEvent.pointerMove(screen.getByRole('img', { name: /Firstland/ }), {
      clientX: 400,
      clientY: 100,
    });
    expect(readingNow().style.getPropertyValue('--readout-y')).toBe(
      'max(-92px, min(-100% - 0.75rem, 692px - 100%))'
    );
  });
});

describe('Choropleth no-data encoding', () => {
  function fillsOf(container: HTMLElement): { counted: Element; uncounted: Element } {
    const [first, second] = [...container.querySelectorAll('path')];
    if (first === undefined || second === undefined) throw new Error('two regions expected');
    return { counted: first, uncounted: second };
  }

  it('shades a counted region with a step of the ramp and no fill of its own', () => {
    const { container } = renderMap(new Map([['AA', counted(10)]]));
    const { counted: region } = fillsOf(container);
    expect(region.getAttribute('class')).toContain('fill-seq-');
    expect(region.getAttribute('fill')).toBeNull();
  });

  it('hatches a region with no row rather than shading it', () => {
    const { container } = renderMap(new Map([['AA', counted(10)]]));
    const { uncounted } = fillsOf(container);
    expect(uncounted.getAttribute('fill')).toMatch(/^url\(#/);
    expect(uncounted.getAttribute('class')).not.toContain('fill-seq-');
  });

  it('cannot collide with the palest step, because no step of the ramp is a hatch', () => {
    // A place the geometry has no shape for carries the largest figure, so the
    // drawn region is a fifth of it and lands on the palest step of the ramp.
    const { container } = renderMap(
      new Map([
        ['AA', counted(1, { share: 0.09, rank: 2, of: 2 })],
        ['ZZ', counted(10, { share: 0.91, rank: 1, of: 2 })],
      ])
    );
    const { counted: palest, uncounted } = fillsOf(container);
    // The palest step against the no-data surface is 1.07:1, so the two are
    // held apart by the pattern reference rather than by any difference of
    // shade: a fill naming a pattern is in neither ramp.
    expect(palest.getAttribute('class')).toContain(CHOROPLETH_STEP_CLASSES[0]);
    expect(CHOROPLETH_STEP_CLASSES).not.toContain(uncounted.getAttribute('fill'));
    expect(uncounted.getAttribute('fill')).not.toBe(palest.getAttribute('fill'));
  });
});

describe('Choropleth legend', () => {
  it('maps the ramp to the range it was built from', () => {
    renderMap(
      new Map([
        ['AA', counted(10, { rank: 1, of: 2, share: 0.9 })],
        ['BB', counted(1, { rank: 2, of: 2, share: 0.1 })],
      ])
    );
    const shown = legend();
    expect(shown).toHaveTextContent('1 to 10');
    expect(shown).toHaveTextContent(VISITORS);
  });

  it('says which encoding means no row was returned', () => {
    renderMap(new Map([['AA', counted(10)]]));
    expect(legend()).toHaveTextContent(/No row: not counted, rather than counted as none/);
  });

  it('states no range where nothing was counted at all', () => {
    renderMap(new Map());
    expect(legend()).toHaveTextContent(/Nothing was counted/);
  });

  // The ramp keeps a fixed width, so at the largest text tiers on a phone the
  // label, the ramp and the range cannot share one line: held on one line they
  // set the map column's minimum width and push the panel past its card.
  it('lets the ramp and its range wrap below the figure they shade', () => {
    renderMap(new Map([['AA', counted(10)]]));
    const scale = legend().querySelector('li');
    expect(scale).toHaveTextContent(VISITORS);
    expect(scale).toHaveClass('flex-wrap');
  });

  it('keeps the range beside the ramp it names when the row wraps', () => {
    renderMap(
      new Map([
        ['AA', counted(10, { rank: 1, of: 2, share: 0.9 })],
        ['BB', counted(1, { rank: 2, of: 2, share: 0.1 })],
      ])
    );
    const ramp = legend().querySelector('svg');
    expect(ramp?.parentElement).toHaveTextContent(/^1 to 10$/);
  });

  it('lets the range wrap under the ramp where the two cannot share a line', () => {
    renderMap(
      new Map([
        ['AA', counted(10, { rank: 1, of: 2, share: 0.9 })],
        ['BB', counted(1, { rank: 2, of: 2, share: 0.1 })],
      ])
    );
    const rampWithRange = [...legend().querySelectorAll('li *')].find(
      (element) => element.textContent === '1 to 10' && element.querySelector('svg') !== null
    );
    expect(rampWithRange).toHaveClass('flex-wrap');
  });
});

describe('Choropleth projection fit', () => {
  /** Two shapes far apart in latitude, one of them Antarctica's own geometry id. */
  const WITH_ANTARCTICA = {
    ...TOPOLOGY,
    objects: {
      regions: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Polygon', id: '001', arcs: [[0]], properties: { name: 'Firstland' } },
          { type: 'Polygon', id: '010', arcs: [[1]], properties: { name: 'Antarctica' } },
        ],
      },
    },
  } as unknown as Topology;

  function renderWorld(): ReturnType<typeof render> {
    return render(
      <Choropleth
        topology={WITH_ANTARCTICA}
        objectName="regions"
        projection="naturalEarth1"
        readings={new Map()}
        countLabel={VISITORS}
        shareLabel={SHARE_LABEL}
        codeForId={(id) => (id === '010' ? 'AQ' : 'AA')}
        title="Visitors across the world"
      />
    );
  }

  it('leaves Antarctica out of the drawing', () => {
    renderWorld();
    expect(screen.queryByRole('img', { name: /Antarctica/ })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Firstland/ })).toBeInTheDocument();
  });

  it('gives the box the height the drawn geometry needs and no more', () => {
    const { container } = renderWorld();
    const drawn = [...container.querySelectorAll('path')].flatMap((path) =>
      [...(path.getAttribute('d') ?? '').matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((pair) =>
        Number(pair[2])
      )
    );
    expect(Math.max(...drawn)).toBeGreaterThan(boxHeight(container) - 2);
    expect(boxHeight(container)).toBeLessThan(880);
  });
});

describe('Choropleth over a geometry the projection cannot place', () => {
  /** A polygon with no ring at all, which every projection draws as nothing. */
  const UNDRAWABLE = {
    ...TOPOLOGY,
    objects: {
      regions: {
        type: 'GeometryCollection',
        geometries: [{ type: 'Polygon', id: '001', arcs: [], properties: { name: 'Nowhere' } }],
      },
    },
  } as unknown as Topology;

  it('draws no shape for it and keeps the box its room', () => {
    const { container } = render(
      <Choropleth
        topology={UNDRAWABLE}
        objectName="regions"
        projection="naturalEarth1"
        readings={new Map()}
        countLabel={VISITORS}
        shareLabel={SHARE_LABEL}
        codeForId={() => 'AA'}
        title="Where visitors are"
      />
    );
    expect(container.querySelectorAll('path')).toHaveLength(0);
    expect(boxHeight(container)).toBeGreaterThan(0);
  });
});
