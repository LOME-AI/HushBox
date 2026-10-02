import * as React from 'react';
import { motion } from 'framer-motion';
import { useReducedMotion } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';

/**
 * Grain density at each end of a video generation. The placeholder starts
 * dense (mostly noise) and "develops" toward clear as synthetic progress
 * climbs — mirroring how a diffusion model denoises toward the final frame.
 */
const GRAIN_VIDEO_MAX = 0.6;
const GRAIN_VIDEO_MIN = 0.12;
/** Steady grain for image generation, which reports no progress to track. */
const GRAIN_IMAGE_OPACITY = 0.35;

function grainTargetOpacity(progressPercent: number | undefined): number {
  if (progressPercent === undefined) return GRAIN_IMAGE_OPACITY;
  const fraction = Math.min(100, Math.max(0, progressPercent)) / 100;
  return GRAIN_VIDEO_MAX - (GRAIN_VIDEO_MAX - GRAIN_VIDEO_MIN) * fraction;
}

interface LatentDevelopBackdropProps {
  /**
   * Synthetic 0-100 progress for long-running media (video). When set, the
   * grain clears in proportion. Omitted for image generation, which has no
   * progress signal and instead breathes on a gentle loop.
   */
  progressPercent?: number | undefined;
}

/**
 * Decorative loading backdrop: media resolves out of drifting grayscale grain,
 * diffusion-style. Sits behind the placeholder label inside the (already
 * correctly-shaped) media box. Honors the global reduced-motion signal — under
 * it the sheen and breathing drop and the grain settles to a static frame, so
 * the placeholder is deterministic in E2E and calm for motion-sensitive users.
 *
 * The SVG turbulence is static (fixed seed/frequency); only compositor-friendly
 * opacity and transform are animated, never the filter itself — animating
 * `baseFrequency` would force a per-frame filter re-raster.
 */
export function LatentDevelopBackdrop({
  progressPercent,
}: Readonly<LatentDevelopBackdropProps>): React.JSX.Element {
  const reducedMotion = useReducedMotion();
  const animated = !reducedMotion;
  const isVideo = progressPercent !== undefined;
  const grainOpacity = grainTargetOpacity(progressPercent);
  // SVG filter ids must be unique per instance so concurrent in-flight tiles
  // don't all reference the first one's <filter>. useId() embeds ':', invalid
  // inside a CSS url() reference, so strip it.
  const filterId = `latent-grain-${React.useId().replaceAll(':', '')}`;
  // Breathing applies only to image generation; video grain is driven by the
  // monotonic progress value instead.
  const breathe = animated && !isVideo;

  return (
    <div
      data-testid={TEST_IDS.latentDevelop}
      data-animated={String(animated)}
      data-grain-opacity={grainOpacity.toFixed(2)}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden rounded-md"
    >
      <div className="from-primary/25 via-muted to-muted absolute inset-0 bg-gradient-to-br" />
      <motion.svg
        className="absolute inset-0 h-full w-full"
        xmlns="http://www.w3.org/2000/svg"
        initial={false}
        animate={breathe ? { opacity: [0.45, 0.2, 0.45] } : { opacity: grainOpacity }}
        transition={
          breathe
            ? { duration: 3.2, ease: 'easeInOut', repeat: Infinity }
            : { duration: 0.4, ease: 'easeOut' }
        }
      >
        <filter id={filterId}>
          <feTurbulence
            type="fractalNoise"
            baseFrequency={0.55}
            numOctaves={2}
            seed={7}
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#${filterId})`} />
      </motion.svg>
      {animated && (
        <motion.div
          data-testid={TEST_IDS.latentDevelopSheen}
          className="via-primary/40 absolute inset-0 bg-gradient-to-r from-transparent to-transparent"
          initial={{ x: '-130%' }}
          animate={{ x: '130%' }}
          transition={{ duration: 1.6, ease: 'easeInOut', repeat: Infinity, repeatDelay: 0.3 }}
        />
      )}
    </div>
  );
}
