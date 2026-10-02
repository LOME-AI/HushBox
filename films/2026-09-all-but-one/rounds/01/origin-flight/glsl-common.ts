import { GAL_SCALE, GAL_SPIN } from './direct.js';
import { markGlsl } from './mark.js';

/** GLSL ES 3.00 at high precision. */
export const HEADER = `#version 300 es
precision highp float;
precision highp int;
`;

/**
 * What every pass shares: the uniforms a world is drawn with, hashing, noise,
 * the camera, the mark's geometry and the Devil's face.
 */
export const COMMON = `
uniform int u_world;
uniform float u_t;
uniform vec4 u_cam;
uniform vec2 u_shake;
uniform vec2 u_res;
uniform float u_gain;
uniform vec4 u_a;
uniform vec4 u_b;
uniform vec4 u_c;
uniform vec4 u_d;
uniform vec4 u_e;
uniform vec4 u_f;
uniform vec4 u_g;
uniform vec4 u_face0;
uniform vec4 u_face1;
uniform vec4 u_face2;
uniform vec4 u_face3;
uniform vec3 u_red;
uniform vec3 u_charcoal;

const float PI = 3.14159265;
const float TAU = 6.2831853;

uint hu(uint x) {
  x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u;
  return x;
}
float hf(uint i, uint k) {
  return float(hu(i * 0x9E3779B9u ^ hu(k * 0x85EBCA6Bu + 0x632BE5ABu))) * (1.0 / 4294967296.0);
}
float gauss(uint i, uint k) {
  float a = max(hf(i, k), 1e-6);
  float b = hf(i, k + 101u);
  return sqrt(-2.0 * log(a)) * cos(TAU * b);
}
float hash2(vec2 p) {
  ivec2 q = ivec2(floor(p)) + ivec2(65536);
  return float(hu(uint(q.x) * 1664525u ^ hu(uint(q.y) + 1013904223u))) * (1.0 / 4294967296.0);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash2(i);
  float b = hash2(i + vec2(1.0, 0.0));
  float c = hash2(i + vec2(0.0, 1.0));
  float d = hash2(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int o = 0; o < 5; o++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return s;
}
mat2 rot(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, s, -s, c);
}
vec2 bez(vec2 a, vec2 b, vec2 c, float t) {
  return mix(mix(a, b, t), mix(b, c, t), t);
}
vec2 bezT(vec2 a, vec2 b, vec2 c, float t) {
  return 2.0 * mix(b - a, c - b, t);
}
float sat(float x) { return clamp(x, 0.0, 1.0); }
float ease(float x) { x = sat(x); return x * x * (3.0 - 2.0 * x); }
float easeOutBack(float x) {
  x = sat(x);
  float c1 = 1.9;
  float c3 = c1 + 1.0;
  return 1.0 + c3 * pow(x - 1.0, 3.0) + c1 * pow(x - 1.0, 2.0);
}
vec2 swirlMix(vec2 a, vec2 b, float m, float sw) {
  float ra = length(a);
  float rb = length(b);
  float aa = atan(a.y, a.x);
  float ab = atan(b.y, b.x);
  float da = ab - aa;
  da -= TAU * floor(da / TAU + 0.5);
  float r = mix(ra, rb, m);
  float an = aa + da * m - sw * sin(PI * m);
  return vec2(cos(an), sin(an)) * r;
}
/** World to clip: the camera centre, its zoom (world units across half the frame height) and roll. */
vec2 toClip(vec2 p) {
  vec2 q = rot(u_cam.w) * (p - u_cam.xy) * u_cam.z;
  return vec2(q.x * u_res.y / u_res.x, q.y) + u_shake;
}
vec2 fromClip(vec2 clip) {
  vec2 q = clip - u_shake;
  q.x *= u_res.x / u_res.y;
  return u_cam.xy + rot(-u_cam.w) * q / u_cam.z;
}

${markGlsl()}

/** Distance from p (mark units) to the mark; each stroke drawn from its inner end to the fraction grow.x..y of its length. */
float markSdf(vec2 p, float grow, float dotScale) {
  float d = length(p) - MARK_DOT * dotScale;
  for (int k = 0; k < MARK_N; k++) {
    float lim = clamp(grow * 1.35 - float(k) * 0.05, 0.0, 1.0) * float(MARK_P - 1);
    if (lim <= 0.0) continue;
    for (int j = 0; j < MARK_P - 1; j++) {
      if (float(j) >= lim) break;
      vec3 a = MARK[k * MARK_P + j];
      vec3 b = MARK[k * MARK_P + j + 1];
      float frac = min(1.0, lim - float(j));
      vec2 bb = mix(a.xy, b.xy, frac);
      float wb = mix(a.z, b.z, frac);
      vec2 v = bb - a.xy;
      vec2 w = p - a.xy;
      float t = clamp(dot(w, v) / max(dot(v, v), 1e-8), 0.0, 1.0);
      d = min(d, length(w - v * t) - mix(a.z, wb, t));
    }
  }
  return d;
}

/** The mark's give: an offset from its centre squashed along u_g.xy by u_g.z (negative stretches), bulging across it. */
vec2 giveOf(vec2 d) {
  vec2 n = u_g.xy;
  vec2 s = vec2(-n.y, n.x);
  return n * dot(d, n) * (1.0 - u_g.z) + s * dot(d, s) * (1.0 + 0.5 * u_g.z);
}
vec2 ungiveOf(vec2 d) {
  vec2 n = u_g.xy;
  vec2 s = vec2(-n.y, n.x);
  return n * dot(d, n) / (1.0 - u_g.z) + s * dot(d, s) / (1.0 + 0.5 * u_g.z);
}

struct Face { float grin; float fear; float open; float blink; vec2 look; float boil; vec2 wink; float brow; };

Face faceNow() {
  return Face(u_face0.x, u_face0.y, u_face0.z, u_face0.w, u_face2.xy, u_face2.w, u_face3.xy, u_face3.z);
}

vec2 headOutline(float a) {
  float s = sin(a);
  float c = cos(a);
  float x = 0.31 * c * mix(1.0, 0.16, pow(max(-s, 0.0), 2.2)) * (1.0 + 0.09 * exp(-pow((s + 0.05) / 0.3, 2.0)));
  float y = s * (s > 0.0 ? 0.41 : 0.54);
  return vec2(x, y);
}

void mouthShape(Face F, out float W, out vec4 k) {
  vec4 neutral = vec4(-0.23, 0.7, -0.255, 1.5);
  vec4 grin = vec4(-0.215, 1.3, -0.29, 3.0);
  vec4 fear = vec4(-0.228, -0.9, -0.305, 0.9);
  k = mix(mix(neutral, grin, F.grin), fear, F.fear);
  W = mix(mix(0.15, 0.21, F.grin), 0.12, F.fear);
  k.z -= 0.08 * F.open;
  k.w -= 1.2 * F.open;
}
bool inMouth(vec2 p, Face F) {
  float W;
  vec4 k;
  mouthShape(F, W, k);
  if (abs(p.x) > W) return false;
  float x2 = p.x * p.x;
  return p.y < k.x + k.y * x2 && p.y > k.z + k.w * x2;
}
void eyeFrame(float sgn, Face F, out vec2 c, out float ew, out float eh, out float ang) {
  c = vec2(sgn * 0.125, 0.075 + 0.012 * F.fear);
  ew = mix(0.085, 0.074, F.fear);
  float shut = max(F.blink, sgn < 0.0 ? F.wink.x : F.wink.y);
  eh = mix(0.032, 0.064, F.fear) * (1.0 - shut) + 0.002;
  ang = mix(0.36, -0.2, F.fear);
}
vec2 eyeToFace(vec2 uv, float sgn, Face F) {
  vec2 c; float ew; float eh; float ang;
  eyeFrame(sgn, F, c, ew, eh, ang);
  float x = uv.x * ew;
  float prof = pow(max(1.0 - uv.x * uv.x, 0.0), 0.7);
  float y = uv.y * eh * prof * (uv.y > 0.0 ? 1.15 : 0.9);
  vec2 q = rot(ang) * vec2(x, y);
  return c + vec2(sgn * q.x, q.y);
}
vec2 faceToEye(vec2 p, float sgn, Face F) {
  vec2 c; float ew; float eh; float ang;
  eyeFrame(sgn, F, c, ew, eh, ang);
  vec2 d = p - c;
  d.x *= sgn;
  vec2 q = rot(-ang) * d;
  float u = q.x / ew;
  float prof = pow(max(1.0 - u * u, 1e-3), 0.7);
  return vec2(u, q.y / (eh * prof * (q.y > 0.0 ? 1.15 : 0.9)));
}
bool pupilDark(vec2 uv, float sgn, Face F) {
  float up = clamp(sgn * F.look.x * 6.0, -0.55, 0.55);
  bool slit = abs(uv.x - up) < 0.11 * (1.0 - F.fear);
  bool pdot = length(vec2(uv.x - up, (uv.y - F.look.y * 5.0) * 0.6)) < 0.26 * F.fear;
  return slit || pdot;
}

const vec3 GOLD = vec3(1.0, 0.56, 0.18);
/** The galaxy's scale: its outermost arm reaches the frame's sides. */
const float GAL_SCALE = ${GAL_SCALE.toFixed(4)};
const float GAL_SPIN = ${GAL_SPIN.toFixed(4)};

const vec2 EYE_C = vec2(0.0, 0.14);
float lidUp(float x, float open) { return 0.27 * open * pow(max(1.0 - pow(x / 0.52, 2.0), 0.0), 0.85); }
float lidLo(float x, float open) { return -0.2 * open * pow(max(1.0 - pow(x / 0.52, 2.0), 0.0), 0.9); }

vec3 demonColor(int k) {
  if (k == 0) return vec3(0.45, 1.0, 0.35);
  if (k == 1) return vec3(0.78, 0.36, 1.0);
  return vec3(0.3, 0.85, 1.0);
}

const vec2 PLANET_C = vec2(0.0, 0.2);
const float PLANET_R = 0.36;

vec2 strikePoint(int k) {
  // the three cities sit on the night side, away from the sunlit limb at the upper left
  float an = k == 0 ? 0.35 : (k == 1 ? -0.45 : -1.25);
  return PLANET_C + vec2(cos(an), sin(an)) * PLANET_R * (k == 1 ? 0.5 : 0.62);
}


/** One particle of the Devil's face in face units: its place, colour and size. */
void facePart(uint i, Face F, float t, out vec2 p, out vec3 col, out float sz) {
  float r = hf(i, 1u);
  float a = hf(i, 2u);
  float b = hf(i, 3u);
  float c = hf(i, 4u);
  float sgn = hf(i, 5u) < 0.5 ? -1.0 : 1.0;
  sz = 0.0045;
  if (r < 0.12) {
    p = headOutline(TAU * a) * (1.0 - 0.02 * b);
    col = GOLD * (0.7 + 0.5 * c);
    sz = 0.0042;
  } else if (r < 0.40) {
    float rr = sqrt(b) * 0.97;
    p = headOutline(TAU * a) * rr;
    float shade = (0.35 + 0.55 * sat(0.55 + 0.9 * p.y + 0.4 * p.x)) * (0.55 + 0.9 * vnoise(p * 16.0 + 3.0));
    shade += 0.9 * pow(rr, 7.0);
    vec2 el = faceToEye(p, -1.0, F);
    vec2 er = faceToEye(p, 1.0, F);
    if ((abs(el.x) < 1.3 && abs(el.y) < 1.6) || (abs(er.x) < 1.3 && abs(er.y) < 1.6)) shade *= 0.12;
    if (inMouth(p, F)) shade = 0.0;
    col = GOLD * 0.26 * shade;
    sz = 0.0052;
  } else if (r < 0.52) {
    vec2 P0 = vec2(sgn * 0.17, 0.30);
    vec2 P1 = vec2(sgn * 0.43, 0.44);
    vec2 P2 = vec2(sgn * 0.29, 0.88);
    vec2 tg = normalize(bezT(P0, P1, P2, a));
    vec2 nm = vec2(-tg.y, tg.x);
    float w = 0.075 * pow(1.0 - a, 0.9) + 0.004;
    p = bez(P0, P1, P2, a) + nm * (b - 0.5) * w;
    float ring = 0.6 + 0.4 * step(0.45, fract(a * 8.0 + 0.2));
    float edge = 0.55 + 0.9 * pow(abs(b - 0.5) * 2.0, 4.0);
    col = GOLD * 0.6 * ring * edge * (0.6 + 0.7 * a);
  } else if (r < 0.62) {
    vec2 uv = vec2(a * 2.0 - 1.0, b * 2.0 - 1.0);
    p = eyeToFace(uv, sgn, F);
    if (pupilDark(uv, sgn, F)) {
      col = vec3(0.05, 0.012, 0.0);
    } else {
      col = mix(vec3(1.0, 0.78, 0.3) * 2.6, vec3(1.0, 0.95, 0.85) * 2.0, F.fear) * (0.75 + 0.45 * (1.0 - abs(uv.y)));
    }
    sz = 0.0036;
  } else if (r < 0.68) {
    vec2 I = mix(vec2(sgn * 0.035, 0.135), vec2(sgn * 0.04, 0.24), F.fear);
    vec2 C = mix(vec2(sgn * 0.14, 0.205), vec2(sgn * 0.13, 0.262), F.fear);
    vec2 O = mix(vec2(sgn * 0.25, 0.228), vec2(sgn * 0.24, 0.168), F.fear);
    // one brow does most of the raising
    float br = F.brow * (sgn < 0.0 ? 1.0 : 0.3);
    p = bez(I + vec2(0.0, 0.04 * br), C + vec2(0.0, 0.03 * br), O + vec2(0.0, 0.012 * br), a) + vec2(0.0, (b - 0.5) * 0.026 * (1.0 - 0.6 * a));
    col = GOLD * 0.95;
  } else if (r < 0.82) {
    float W;
    vec4 k;
    mouthShape(F, W, k);
    float x = (a * 2.0 - 1.0) * W;
    float x2 = x * x;
    float up = k.x + k.y * x2;
    float lo = k.z + k.w * x2;
    if (b < 0.45) {
      p = vec2(x, (b < 0.225 ? up + 0.006 : lo - 0.006) + (c - 0.5) * 0.009);
      col = GOLD * 1.0;
    } else {
      float kx = (x + W) / 0.034;
      float u = fract(kx);
      float gap = max(up - lo, 0.0);
      float L = (1.0 - abs(2.0 * u - 1.0)) * min(gap * 0.48, 0.05);
      float v = hf(i, 6u);
      p = c < 0.5 ? vec2(x, up - v * L) : vec2(x, lo + v * L);
      col = vec3(1.0, 0.92, 0.72) * 1.2 * (1.0 - 0.3 * F.fear);
      sz = 0.0034;
    }
  } else if (r < 0.86) {
    vec2 A = vec2(-0.05, -0.50);
    vec2 B = vec2(0.05, -0.50);
    vec2 T = vec2(0.03, -0.70);
    float u = a;
    float v = b;
    if (u + v > 1.0) { u = 1.0 - u; v = 1.0 - v; }
    p = A + (B - A) * u + (T - A) * v;
    col = GOLD * 0.42;
  } else if (r < 0.91) {
    vec2 A = vec2(sgn * 0.30, 0.02);
    vec2 B = vec2(sgn * 0.295, 0.14);
    vec2 T = vec2(sgn * 0.45, 0.22);
    float u = a;
    float v = b;
    if (u + v > 1.0) { u = 1.0 - u; v = 1.0 - v; }
    p = A + (B - A) * u + (T - A) * v;
    col = GOLD * 0.34 * (0.6 + 0.9 * v);
  } else if (r < 0.95) {
    if (c < 0.5) {
      p = mix(vec2(sgn * 0.018, -0.01), vec2(sgn * 0.05, -0.10), a) + vec2(0.0, (b - 0.5) * 0.006);
      col = GOLD * 0.55;
    } else {
      p = bez(vec2(sgn * 0.07, -0.12), vec2(sgn * 0.16, -0.13), vec2(sgn * 0.235, -0.19), a) + vec2(0.0, (b - 0.5) * 0.006);
      col = GOLD * 0.5 * F.grin * (1.0 - F.fear);
    }
  } else {
    float life = fract(hf(i, 7u) + t * (0.18 + 0.25 * a));
    float x = gauss(i, 8u) * 0.22 * (1.0 - 0.5 * life);
    p = vec2(x + 0.05 * sin(t * 2.0 + b * 20.0), -0.55 + life * 1.6);
    col = vec3(1.0, 0.42, 0.1) * 1.1 * sin(PI * life) * exp(-abs(x) * 4.0);
    sz = 0.004 + 0.004 * b;
  }
}

/** A face particle in world units: the face's centre, scale and tilt from u_face1, with its boil re-rolled ten times a second. */
vec2 faceToWorld(vec2 local, uint i, float t, float boil) {
  float step10 = floor(t * 10.0);
  uint s = uint(int(step10) + 4096);
  vec2 j = vec2(hf(i ^ (s * 0x27d4eb2du), 9u), hf(i ^ (s * 0x165667b1u), 10u)) - 0.5;
  // u_face3.w squashes the head when struck (negative stretches it)
  vec2 sq = vec2(1.0 + 0.5 * u_face3.w, 1.0 - u_face3.w);
  return u_face1.xy + rot(u_face1.w) * ((local + j * boil) * sq) * u_face1.z;
}
`;
