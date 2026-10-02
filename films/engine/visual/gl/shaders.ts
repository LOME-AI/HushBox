import { GLSL_HEADER } from './glsl.js';

/** Taps either side of the centre in each bloom blur pass. */
export const BLOOM_RADIUS = 8;
/** The bloom blur's standard deviation, in taps of its own (downsampled) target. */
export const BLOOM_SIGMA = 4;

/** One triangle covering the target; `v_uv` runs 0 to 1 across it, bottom-left first. */
export const FULLSCREEN_VERTEX = `${GLSL_HEADER}
out vec2 v_uv;

void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = corner;
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** A texture scaled by a weight: accumulates sub-frames, composites layers and downsamples. */
export const COPY_FRAGMENT = `${GLSL_HEADER}
uniform sampler2D u_source;
uniform float u_weight;

in vec2 v_uv;
out vec4 outColor;

void main() {
  outColor = texture(u_source, v_uv) * u_weight;
}
`;

/** Keeps only light above the bloom threshold, with a soft knee. */
export const BRIGHT_FRAGMENT = `${GLSL_HEADER}
uniform sampler2D u_source;

in vec2 v_uv;
out vec4 outColor;

const float THRESHOLD = 0.8;
const float KNEE = 0.4;

void main() {
  vec3 color = texture(u_source, v_uv).rgb;
  float peak = max(color.r, max(color.g, color.b));
  float soft = clamp(peak - THRESHOLD + KNEE, 0.0, 2.0 * KNEE);
  soft = soft * soft / (4.0 * KNEE);
  float kept = max(soft, peak - THRESHOLD) / max(peak, 0.00001);
  outColor = vec4(color * kept, 1.0);
}
`;

/** One separable Gaussian pass along `u_step`, one texel per tap. */
export const BLUR_FRAGMENT = `${GLSL_HEADER}
uniform sampler2D u_source;
uniform vec2 u_step;
uniform float u_weights[${String(BLOOM_RADIUS + 1)}];

in vec2 v_uv;
out vec4 outColor;

void main() {
  vec3 sum = texture(u_source, v_uv).rgb * u_weights[0];
  for (int tap = 1; tap <= ${String(BLOOM_RADIUS)}; tap++) {
    vec2 offset = u_step * float(tap);
    sum += (texture(u_source, v_uv + offset).rgb + texture(u_source, v_uv - offset).rgb) * u_weights[tap];
  }
  outColor = vec4(sum, 1.0);
}
`;

/** Linear light in [0, 1] to its sRGB encoding, by the sRGB transfer function. */
const SRGB_ENCODE = `vec3 encodeSrgb(vec3 linear) {
  vec3 clamped = clamp(linear, 0.0, 1.0);
  vec3 curve = 1.055 * pow(max(clamped, 0.0), vec3(1.0 / 2.4)) - 0.055;
  return mix(clamped * 12.92, curve, step(0.0031308, clamped));
}
`;

/**
 * The pass of a canvas with no post chain: the scene sRGB-encoded and nothing
 * else, so a layer's colours reach the frame as it drew them.
 */
export const PLAIN_FRAGMENT = `${GLSL_HEADER}
uniform sampler2D u_scene;

in vec2 v_uv;
out vec4 outColor;

${SRGB_ENCODE}
void main() {
  outColor = vec4(encodeSrgb(texture(u_scene, v_uv).rgb), 1.0);
}
`;

/**
 * The finishing pass: chromatic aberration masked to the edges, bloom, flash,
 * vignette, a highlight roll-off that leaves everything below its knee untouched,
 * sRGB encoding and a static triangular dither.
 */
export const PRESENT_FRAGMENT = `${GLSL_HEADER}
uniform sampler2D u_scene;
uniform sampler2D u_bloomNear;
uniform sampler2D u_bloomFar;
uniform vec2 u_resolution;
uniform float u_bloom;
uniform float u_aberration;
uniform float u_vignette;
uniform float u_flash;

in vec2 v_uv;
out vec4 outColor;

const float ABERRATION_PX = 14.0;
const float FLASH_LEVEL = 2.0;
const float ROLL_OFF_KNEE = 0.9;
const float DITHER_LSB = 1.0;

vec3 rollOff(vec3 color) {
  vec3 over = max(color - ROLL_OFF_KNEE, 0.0);
  vec3 rolled = ROLL_OFF_KNEE + (1.0 - ROLL_OFF_KNEE) * (1.0 - exp(-over / (1.0 - ROLL_OFF_KNEE)));
  return mix(color, rolled, step(ROLL_OFF_KNEE, color));
}

${SRGB_ENCODE}
uint hash(uvec2 pixel) {
  uint h = pixel.x * 1664525u + pixel.y * 1013904223u;
  h ^= h >> 16;
  h *= 2246822519u;
  h ^= h >> 13;
  h *= 3266489917u;
  h ^= h >> 16;
  return h;
}

// Uniform in [0, 1) from the pixel alone: the dither never moves between frames.
float noise(uvec2 pixel, uint salt) {
  return float(hash(pixel + uvec2(salt, salt * 7u)) >> 8) / 16777216.0;
}

void main() {
  vec2 centred = v_uv - 0.5;
  vec2 aspect = vec2(u_resolution.x / u_resolution.y, 1.0);
  float radius = length(centred * aspect) / length(0.5 * aspect);
  vec2 fromCentrePx = centred * u_resolution;
  vec2 outward = fromCentrePx / max(length(fromCentrePx), 0.001);
  vec2 shift = outward * (u_aberration * ABERRATION_PX * smoothstep(0.2, 1.0, radius)) / u_resolution;
  vec3 color = vec3(
    texture(u_scene, v_uv + shift).r,
    texture(u_scene, v_uv).g,
    texture(u_scene, v_uv - shift).b
  );
  color += (texture(u_bloomNear, v_uv).rgb + texture(u_bloomFar, v_uv).rgb) * u_bloom;
  color += u_flash * FLASH_LEVEL;
  color *= 1.0 - u_vignette * smoothstep(0.35, 1.0, radius);
  vec3 encoded = encodeSrgb(rollOff(color));
  uvec2 pixel = uvec2(gl_FragCoord.xy);
  float dither = (noise(pixel, 1u) + noise(pixel, 2u) - 1.0) * DITHER_LSB / 255.0;
  outColor = vec4(clamp(encoded + dither, 0.0, 1.0), 1.0);
}
`;
