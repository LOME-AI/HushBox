/**
 * Tunable layout constants for the public roadmap constellation. Both
 * layouts read from this object; changing any value here will alter the
 * cache key via {@link getLayoutVersion} (`JSON.stringify(LAYOUT_CONFIG)`
 * is part of the hash input).
 *
 * Seed is fixed so the constellation is identical across visitors — two
 * users see the same arrangement at the same time, screenshots match.
 */
export const LAYOUT_CONFIG = {
  seed: 0xc047_2024,
  wide: {
    viewBox: [0, 0, 1600, 900] as const,
    projectRadius: 24,
    taskRadius: 14,
    subtaskRadius: 8,
    projectChargeStrength: -800,
    taskChargeStrength: -200,
    subtaskChargeStrength: -60,
    hierarchyLinkStrength: 1,
    dependencyLinkStrength: 0.1,
    hierarchyLinkDistance: 80,
    dependencyLinkDistance: 200,
    radialClusterRadius: 180,
    radialClusterStrength: 0.25,
    collidePadding: 6,
    centerXStrength: 0.08,
    centerYStrength: 0.04,
    simulationTicks: 300,
    /**
     * Horizontal slot ratios for each status, expressed as a fraction of the
     * wide viewBox width. In-progress projects pull left, planned to centre,
     * shipped to right. Marketing-relevant ordering: what we're doing now is
     * the first thing readers see.
     */
    slotRatios: {
      in_progress: 0.25,
      planned: 0.55,
      shipped: 0.82,
    } as const,
  },
  narrow: {
    viewBox: [0, 0, 400, 1400] as const,
    centerX: 200,
    indentPx: 40,
    projectSpacing: 110,
    taskSpacing: 60,
    subtaskSpacing: 40,
    topPadding: 40,
    bottomPadding: 40,
    projectRadius: 18,
    taskRadius: 10,
    subtaskRadius: 6,
  },
  /**
   * Synthetic "Other" project that absorbs orphan issues (no Linear project
   * assigned). Rendered in the planned slot in wide layout, bottom of the
   * narrow layout. Color is a muted neutral so it reads as tertiary.
   */
  orphanProject: {
    id: 'orphan',
    name: 'Other',
    color: '#71717a',
    stateType: 'planned' as const,
  },
} as const;
