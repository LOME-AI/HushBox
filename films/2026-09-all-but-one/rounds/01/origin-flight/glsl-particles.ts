import { COMMON, HEADER } from './glsl-common.js';

/**
 * Every particle of every world, each a closed-form function of its index and
 * the time: where it came from, where it is going, and how far along it is.
 * World parameters (u_a..u_f) are documented beside each world's director in
 * `direct.ts`.
 */
export const PARTICLE_VS = `${HEADER}${COMMON}
out vec3 v_col;
out float v_kind;
out float v_aux;

// ---------------------------------------------------------------- world 0: the void and the Devil
vec2 dustAt(uint i, float t) {
  float r0 = mix(0.10, 1.3, pow(hf(i, 11u), 0.6));
  float th0 = TAU * hf(i, 12u);
  float tt = clamp(t, 0.0, 1.0);
  float r = r0 * exp(-3.4 * pow(tt, 1.6));
  float th = th0 + 1.1 * sqrt(r0 / max(r, 0.012)) + 0.5 * tt;
  return vec2(cos(th), sin(th)) * r;
}

void worldVoid(uint i, float t, out vec2 p, out vec3 col, out float sz, out float kind) {
  Face F = faceNow();
  vec2 fp; vec3 fc; float fs;
  facePart(i, F, t, fp, fc, fs);
  vec2 target = faceToWorld(fp, i, t, F.boil);
  kind = 0.0;
  if (t < 1.0) {
    vec2 d = dustAt(i, t);
    float r = length(d);
    p = d;
    col = mix(vec3(0.6, 0.38, 0.28) * 0.28, vec3(1.0, 0.72, 0.38) * 1.6, exp(-r * 5.0)) * sat(t * 6.0 + 0.4);
    sz = 0.0032;
    return;
  }
  float s = t - 1.0;
  float dAng = TAU * hf(i, 13u);
  vec2 dir = vec2(cos(dAng), sin(dAng));
  float D = 0.12 + 0.95 * pow(hf(i, 14u), 0.7);
  vec2 E = dustAt(i, 1.0) + dir * D * (1.0 - exp(-s / 0.16));
  float m = ease((t - 1.18 - 0.5 * hf(i, 15u)) / 0.62);
  vec2 c0 = u_face1.xy;
  p = c0 + swirlMix(E - c0, target - c0, m, 1.4 * (hf(i, 16u) - 0.35));
  float hot = exp(-s / 0.22);
  vec3 cool = mix(vec3(1.0, 0.5, 0.16) * 0.9, fc, m);
  col = mix(cool, vec3(1.0, 0.9, 0.72) * 2.4, hot * (1.0 - m));
  sz = mix(0.0042, fs, m);
}

// ---------------------------------------------------------------- world 1: the galaxy of kept words
vec2 galaxyXY(float r, float th) {
  vec2 q = vec2(cos(th), sin(th)) * r;
  q.y *= 0.58;
  return rot(0.5) * q;
}

void worldGalaxy(uint i, float t, out vec2 p, out vec3 col, out float sz, out float kind) {
  float tl = t - u_a.x;
  float h0 = hf(i, 20u);
  float arm = hf(i, 21u) < 0.5 ? 0.0 : PI;
  float r = 0.035 + 0.95 * pow(h0, 1.3);
  float th = arm + 2.3 * log(r / 0.035) + gauss(i, 22u) * 0.4 * (0.35 + (1.0 - r)) - (0.55 / (r + 0.25)) * (tl + 2.0) * GAL_SPIN;
  vec2 q = galaxyXY(r, th) * GAL_SCALE;
  // the galaxy pours out of the grin: each word flies from the centre to its place
  float m = ease((u_a.y - 0.25 * hf(i, 26u)) / 0.75);
  p = u_b.xy + swirlMix(q * 0.02, q, m, 2.2 * (hf(i, 27u) - 0.2));
  kind = hf(i, 23u) < 0.4 && r > 0.12 ? 1.0 : 0.0;
  vec3 c = mix(vec3(1.0, 0.86, 0.58), vec3(1.0, 0.56, 0.2), smoothstep(0.05, 0.45, r));
  c = mix(c, vec3(0.8, 0.38, 0.9), smoothstep(0.4, 1.0, r) * step(0.55, hf(i, 24u)));
  float bright = kind > 0.5 ? 0.42 : 0.16 + 0.9 * exp(-r * 6.0);
  // the bells' sixteenths: one particle in sixty-one lights on each note
  float note = floor(tl * 8.0);
  if (note >= 0.0 && hu(i) % 61u == uint(note) % 61u) {
    bright += 1.6 * exp(-(tl - note / 8.0) / 0.12);
  }
  col = c * bright * 0.5 * (0.3 + 0.7 * m);
  sz = kind > 0.5 ? mix(0.008, 0.016, hf(i, 25u)) : 0.0028;
}

// ---------------------------------------------------------------- world 2: the eye, the leak and the demons
/** One particle of a demon in demon units (torso at the origin, about 0.55 tall): place, brightness, sprite. */
void demonPart(uint i, float t, float phase, int variant, out vec2 p, out float b, out float kind) {
  // three figures: a squat one with great horns and broad wings, a tall thin one with a long tail and swept wings, a small one all head and claws
  float headS = variant == 0 ? 1.15 : (variant == 1 ? 0.85 : 1.5);
  float hornS = variant == 0 ? 1.6 : (variant == 1 ? 0.8 : 1.0);
  float wingS = variant == 0 ? 1.25 : (variant == 1 ? 0.9 : 0.6);
  float bodyS = variant == 0 ? 0.8 : (variant == 1 ? 1.45 : 0.7);
  float tailS = variant == 1 ? 1.8 : 1.0;
  float flapHz = variant == 0 ? 1.5 : (variant == 1 ? 2.0 : 3.0);
  float r = hf(i, 40u);
  float a = hf(i, 41u);
  float c = hf(i, 42u);
  float sgn = hf(i, 43u) < 0.5 ? -1.0 : 1.0;
  kind = 0.0;
  b = 1.0;
  if (r < 0.10) {
    float an = TAU * a;
    float rr = sqrt(c);
    p = vec2(0.0, 0.13) + vec2(cos(an), sin(an) * 1.1) * 0.05 * rr * headS;
    b = 0.35 + 0.9 * pow(rr, 6.0);
  } else if (r < 0.16) {
    vec2 A = vec2(sgn * 0.03, 0.165);
    vec2 B = vec2(sgn * 0.07, 0.2);
    vec2 C = vec2(sgn * 0.06, 0.26);
    p = vec2(0.0, 0.13) + (bez(A, B, C, a) - vec2(0.0, 0.13)) * vec2(hornS, hornS) + vec2((c - 0.5) * 0.02 * (1.0 - a), 0.0);
    if (variant == 1) p.x += sgn * a * a * 0.05;
    b = 0.9;
  } else if (r < 0.20) {
    p = vec2(sgn * 0.021 * headS, 0.13 + 0.007 * headS) + rot(sgn * 0.45) * vec2((a - 0.5) * 0.028, (c - 0.5) * 0.008) * headS;
    b = 3.2;
  } else if (r < 0.24) {
    float an = TAU * a;
    float open = 0.6 + 0.4 * sin(t * 18.0 + phase);
    p = vec2(0.0, 0.13 - 0.032 * headS) + vec2(cos(an) * 0.024, sin(an) * 0.016 * open) * (0.85 + 0.15 * c) * headS;
    b = 1.3;
  } else if (r < 0.34) {
    float y = mix(0.07, 0.07 - 0.145 * bodyS, a);
    float w = mix(0.056, 0.022, a) * (variant == 2 ? 1.3 : 1.0);
    p = vec2((c * 2.0 - 1.0) * w, y);
    b = 0.45 + 0.8 * step(0.8, fract(a * 7.0));
  } else if (r < 0.70) {
    float flap = 0.35 + 0.6 * sin(TAU * flapHz * t + phase);
    vec2 S = vec2(sgn * 0.045, 0.065);
    float ang0 = flap + 0.75;
    float ang1 = flap + 0.25;
    float ang2 = flap - 0.3;
    vec2 d0 = vec2(sgn * cos(ang0), sin(ang0)) * 0.30 * wingS;
    vec2 d1 = vec2(sgn * cos(ang1), sin(ang1)) * 0.34 * wingS * (variant == 1 ? 1.3 : 1.0);
    vec2 d2 = vec2(sgn * cos(ang2), sin(ang2)) * 0.26 * wingS;
    float sel = hf(i, 44u);
    if (sel < 0.3) {
      vec2 d = sel < 0.1 ? d0 : (sel < 0.2 ? d1 : d2);
      p = S + d * a;
      b = 1.1;
    } else {
      float v = c;
      float u = a;
      vec2 e0;
      vec2 e1;
      if (sel < 0.55) { e0 = d0; e1 = d1; } else if (sel < 0.8) { e0 = d1; e1 = d2; } else { e0 = d2; e1 = vec2(-sgn * 0.02, -0.12) - vec2(0.0, 0.0); }
      vec2 q = mix(e0, e1, v) * u;
      p = S + q * (1.0 - 0.28 * sin(PI * v) * u * u);
      b = 0.35;
      kind = 1.0;
    }
  } else if (r < 0.80) {
    vec2 A = vec2(sgn * 0.05, 0.06);
    vec2 B = vec2(sgn * 0.12, 0.02);
    vec2 C = variant == 2 ? vec2(sgn * 0.15, 0.1) : vec2(sgn * 0.1, -0.04);
    if (c < 0.7) {
      p = bez(A, B, C, a);
    } else {
      float claw = floor(c * 10.0 - 7.0);
      p = C + rot(sgn * (claw - 1.0) * 0.5) * vec2(sgn * 0.0, -0.03 * a) + vec2(sgn * 0.01 * a * a, 0.0);
    }
    b = 1.0;
  } else if (r < 0.88) {
    p = a < 0.5
      ? mix(vec2(sgn * 0.018, -0.07), vec2(sgn * 0.045, -0.14), a * 2.0)
      : mix(vec2(sgn * 0.045, -0.14), vec2(sgn * 0.03, -0.21), a * 2.0 - 1.0);
    b = 0.9;
  } else {
    float u = a;
    p = vec2(0.14 * sin(3.0 * u + t * 6.0 + phase) * u, 0.07 - 0.145 * bodyS - 0.28 * u * tailS);
    if (u > 0.92) p += vec2((c - 0.5) * 0.05 * (1.0 - (u - 0.92) * 10.0), 0.0);
    b = 0.8;
  }
}

void worldEye(uint i, float t, out vec2 p, out vec3 col, out float sz, out float kind) {
  float open = u_a.y;
  float swell = u_a.z;
  float inhale = u_a.w;
  vec2 I = EYE_C + u_b.xy;
  float RP = u_b.z;
  float RI = 0.2 * swell;
  kind = 0.0;
  sz = 0.0034;
  float h = hf(i, 30u);
  vec2 base;
  vec3 c;
  bool hud = h > 0.93;
  if (!hud) {
    float ang = TAU * hf(i, 31u);
    float fr = pow(hf(i, 32u), 0.75);
    float r = mix(RP * 1.04, RI * 0.98, fr);
    float streak = 0.35 + 0.95 * vnoise(vec2(ang * 38.0, fr * 2.5));
    base = I + vec2(cos(ang), sin(ang)) * r;
    c = mix(vec3(0.75, 1.0, 1.0) * 2.2, vec3(0.08, 0.62, 0.78), smoothstep(0.0, 0.45, fr));
    c = mix(c, vec3(0.03, 0.25, 0.4), smoothstep(0.7, 1.0, fr)) * streak;
    // lids hide what they cover
    vec2 e = base - EYE_C;
    if (e.y > lidUp(e.x, open) || e.y < lidLo(e.x, open) || abs(e.x) > 0.52) c = vec3(0.0);
  } else {
    float seg = floor(hf(i, 31u) * 24.0);
    float ang = (seg + fract(hf(i, 31u) * 24.0) * 0.55) / 24.0 * TAU + u_b.w;
    base = I + vec2(cos(ang), sin(ang)) * RI * 1.28;
    c = vec3(0.45, 0.95, 1.0) * 0.7 * open;
    sz = 0.003;
  }
  // the leak: fibres pour out along eight cracks
  float leak = u_c.x;
  uint k = hu(i + 7u) % 8u;
  // each crack opens on its own delay, the first two on the hit itself
  float kdel = k < 2u ? 0.0 : 0.15 + 0.7 * hash2(vec2(float(k), 4.0));
  float kw = 0.6 + 0.9 * hash2(vec2(float(k), 5.0));
  float L = sat((leak - kdel - 0.3 * hf(i, 33u)) / 0.55) * (1.0 - 0.75 * u_g.x);
  float ka = float(k) * 0.785 + 0.3 + 0.2 * sin(float(k) * 3.1);
  vec2 kd = vec2(cos(ka), sin(ka));
  vec2 kn = vec2(-kd.y, kd.x);
  vec2 rel = base - I;
  vec2 leaked = I + kd * (length(rel) + L * (0.2 + 0.7 * hf(i, 34u))) + kn * (dot(rel, kn) * (1.0 - L) + sin(L * 7.0 + hf(i, 35u) * 9.0) * 0.03 * L * kw);
  base = mix(base, leaked, L);
  vec3 secret = mix(vec3(0.8, 0.35, 1.0), vec3(0.5, 1.0, 0.4), step(0.5, hf(i, 36u))) * 0.6;
  if (L > 0.0) c = mix(c + vec3(0.02), secret, L);
  base = I + (base - I) * (1.0 - 0.12 * u_g.x) * (1.0 - 0.85 * inhale);
  c *= 1.0 + 0.6 * u_g.x + 2.0 * inhale;
  float s = u_c.y;
  if (s < 0.0) {
    p = base;
    col = c;
    return;
  }
  // the burst
  float dAng = TAU * hf(i, 37u);
  float D = 0.15 + 1.1 * pow(hf(i, 38u), 0.6);
  vec2 E = I + vec2(cos(dAng), sin(dAng)) * D * (1.0 - exp(-s / 0.14)) + vec2(0.0, 0.02 * s);
  float hot = exp(-s / 0.2);
  vec3 debris = mix(secret * 0.5, vec3(1.0, 0.92, 1.0) * 2.8, hot) * exp(-s * 0.9);
  uint dk = hu(i + 31u) % 3u;
  vec4 dm = dk == 0u ? u_d : (dk == 1u ? u_e : u_f);
  float m = hf(i, 39u) < 0.88 ? easeOutBack((t - (dm.w - 0.16) - 0.05 * hf(i, 45u)) / 0.22) : 0.0;
  vec2 dp; float db; float dkind;
  demonPart(i, t, float(dk) * 2.1, int(dk), dp, db, dkind);
  vec2 target = dm.xy + dp * dm.z + vec2(0.0, 0.015 * sin(t * 12.0 + float(dk)));
  p = dm.xy + swirlMix(E - dm.xy, target - dm.xy, sat(m), 1.8 * (hf(i, 46u) - 0.4));
  p = mix(E, p, step(0.0001, m));
  vec3 dc = demonColor(int(dk)) * db * 0.55;
  dc = mix(dc, vec3(1.0) * 2.0, exp(-abs(t - dm.w) / 0.08) * step(0.0001, m));
  col = mix(debris, dc, sat(m * 1.5));
  kind = m > 0.5 ? dkind : 0.0;
  sz = mix(0.0036, (dkind > 0.5 ? 0.006 : 0.0036) * dm.z, sat(m));
}

// ---------------------------------------------------------------- world 3: the planet
vec3 orbitOf(int k, float psi) {
  float a = 0.5 + 0.06 * float(k);
  float inc = k == 0 ? 0.42 : (k == 1 ? -0.55 : 0.25);
  float node = k == 0 ? 0.35 : (k == 1 ? 2.2 : -1.1);
  vec3 o = vec3(cos(psi) * a, sin(psi) * a * cos(inc), sin(psi) * a * sin(inc));
  vec2 xy = rot(node) * o.xy;
  return vec3(PLANET_C + xy, o.z);
}

void worldPlanet(uint i, float t, out vec2 p, out vec3 col, out float sz, out float kind) {
  int k = int(hu(i + 3u) % 3u);
  float lam = hf(i, 50u);
  float tl = t - u_a.x;
  float strike = u_a.y + float(k) * 0.5;
  float psi = float(k) * 2.1 + tl * 2.2 - lam * 1.5;
  vec3 o = orbitOf(k, psi);
  vec2 sp = vec2(gauss(i, 51u), gauss(i, 52u)) * (0.006 + 0.03 * lam);
  float tt = t - lam * 0.3;
  float dive = ease((tt - (strike - 0.4)) / 0.4);
  vec2 P = strikePoint(k);
  vec2 onOrbit = o.xy + sp;
  vec2 fall = normalize(P - o.xy);
  vec2 side = vec2(-fall.y, fall.x);
  // stretched along the fall as it dives
  vec2 stretched = fall * dot(sp, fall) * (1.0 + 3.0 * dive) + side * dot(sp, side) * (1.0 - 0.5 * dive);
  p = mix(onOrbit, P + stretched * 0.35, dive);
  vec3 c = demonColor(k) * (0.35 + 0.9 * (1.0 - lam));
  // hidden behind the planet
  if (o.z < 0.0 && length(onOrbit - PLANET_C) < PLANET_R && dive < 0.5) c *= 0.0;
  if (tt > strike) {
    float g = tt - strike;
    // squashed flat against the surface, then spreading along it
    vec2 n = normalize(P - PLANET_C);
    vec2 tg = vec2(-n.y, n.x);
    float along = (hf(i, 53u) * 2.0 - 1.0) * min(0.03 + 0.28 * g, 0.26);
    float up = abs(gauss(i, 54u)) * 0.006 * exp(-g * 3.0);
    p = P + tg * along + n * up - n * along * along * 0.8;
    if (length(p - PLANET_C) > PLANET_R * 0.99) p = PLANET_C + normalize(p - PLANET_C) * PLANET_R * 0.99;
    c = demonColor(k) * (0.3 + 1.6 * exp(-g / 0.12)) * exp(-g * 1.4);
  }
  col = c * 0.6;
  kind = hf(i, 55u) < 0.5 ? 1.0 : 0.0;
  sz = kind > 0.5 ? 0.0045 : 0.003;
}

// ---------------------------------------------------------------- world 4: every company, and one
const int SPIRALS = 160;
const int PER_SPIRAL = 400;

vec2 spiralCentre(int s) {
  if (s == 0) return u_b.xy;
  if (s == 1) return u_b.zw;
  int col = s % 10;
  int row = s / 10;
  vec2 jit = vec2(hash2(vec2(float(s), 3.0)), hash2(vec2(float(s), 7.0))) - 0.5;
  return vec2(-0.64 + (float(col) + 0.5) * 0.128, -1.12 + (float(row) + 0.5) * 0.142) + jit * vec2(0.09, 0.1);
}

void worldField(uint i, float t, out vec2 p, out vec3 col, out float sz, out float kind) {
  kind = 0.0;
  int NF = int(u_a.y);
  int idx = int(i);
  if (idx < NF) {
    Face F = faceNow();
    vec2 fp; vec3 fc; float fs;
    facePart(i, F, t, fp, fc, fs);
    p = faceToWorld(fp, i, t, F.boil);
    col = fc * u_face2.z;
    sz = fs;
    return;
  }
  int j = idx - NF;
  if (j < SPIRALS * PER_SPIRAL) {
    int s = j / PER_SPIRAL;
    vec2 c = spiralCentre(s);
    float hs = hash2(vec2(float(s), 11.0));
    float rs = s < 2 ? 0.055 : 0.018 + 0.042 * hs * hs;
    float dir = hash2(vec2(float(s), 23.0)) < 0.18 ? -1.0 : 1.0;
    float spin = dir * (0.25 + 1.6 * hash2(vec2(float(s), 13.0))) * t + TAU * hash2(vec2(float(s), 29.0));
    float arms = s == 1 ? 7.0 : 3.0 + floor(hash2(vec2(float(s), 31.0)) * 5.0);
    float wind = 0.8 + 1.6 * hash2(vec2(float(s), 37.0));
    float tilt = 0.45 + 0.55 * hash2(vec2(float(s), 41.0));
    float tiltA = TAU * hash2(vec2(float(s), 43.0));
    float tremble = u_a.z * 0.004 * sin(t * 50.0 + float(s) * 1.7);
    float h = hf(i, 60u);
    vec2 q;
    if (h < 0.15) {
      float an = TAU * hf(i, 61u);
      q = vec2(cos(an), sin(an)) * sqrt(hf(i, 62u)) * 0.22 * rs;
    } else {
      float arm = floor(hf(i, 61u) * arms);
      float u = hf(i, 62u);
      float an = arm * TAU / arms + wind * u - spin;
      q = vec2(cos(an), sin(an)) * rs * (0.3 + 0.7 * u) + vec2(gauss(i, 63u), gauss(i, 64u)) * 0.06 * rs;
    }
    if (s > 1) {
      q = rot(tiltA) * (vec2(1.0, tilt) * (rot(-tiltA) * q));
    }
    vec2 drift = vec2(sin(t * (0.3 + 0.5 * hs) + float(s)), cos(t * (0.4 + 0.3 * hs) + float(s) * 2.3)) * 0.008;
    p = c + q + drift + vec2(tremble, 0.0);
    float flick = 0.7 + 0.3 * sin(t * (1.5 + 6.0 * hash2(vec2(float(s), 17.0))) + float(s) * 2.9);
    vec3 gold = vec3(1.0, 0.62, 0.22) * (0.5 + 0.8 * hash2(vec2(float(s), 19.0))) * flick;
    if (s == 1) {
      col = u_red * u_c.x * 0.5;
    } else {
      col = gold * u_c.y;
    }
    sz = 0.0032;
    return;
  }
  // the claw: an arm out of the dark with a three-taloned hand, burning back from the tips
  int ci = j - SPIRALS * PER_SPIRAL;
  float ext = u_c.z;
  float burn = u_c.w;
  float since = u_d.z;
  vec2 O = vec2(-0.75, 0.05);
  vec2 C = vec2(-0.25, 0.75);
  vec2 T = u_b.zw + vec2(-0.12, -0.07);
  vec2 hand = bez(O, C, T, ext);
  vec2 htg = normalize(bezT(O, C, T, max(ext, 0.02)));
  vec2 hnm = vec2(-htg.y, htg.x);
  float u;
  vec3 c;
  float part = hf(i, 74u);
  if (part < 0.55) {
    // the arm, thick at the shoulder, knuckled at the wrist
    u = hf(i, 70u) * 0.9;
    float us = u * ext;
    vec2 tg = normalize(bezT(O, C, T, max(us, 0.001)));
    vec2 nm = vec2(-tg.y, tg.x);
    float w = 0.05 * (1.0 - 0.45 * u) * (1.0 + 0.15 * sin(u * 40.0)) * (1.0 - 0.55 * u_c.w * exp(-max(since, 0.0) / 0.4));
    float v = gauss(i, 71u);
    p = bez(O, C, T, us) + nm * v * w * 0.5;
    c = GOLD * (0.5 + 0.9 * smoothstep(0.6, 1.0, abs(v))) * 1.4;
  } else if (part < 0.7) {
    // the palm
    u = 0.9 + 0.05 * hf(i, 70u);
    float an = TAU * hf(i, 71u);
    p = hand - htg * 0.02 + (htg * cos(an) * 0.04 + hnm * sin(an) * 0.055) * sqrt(hf(i, 72u));
    c = GOLD * 1.3;
  } else {
    // three hooked talons, each its own length
    float talon = floor(hf(i, 72u) * 3.0) - 1.0;
    float a = hf(i, 70u);
    u = 0.95 + 0.05 * a;
    float len = 0.13 + 0.03 * talon * talon + 0.02 * talon;
    vec2 base = hand + hnm * talon * 0.04;
    // each talon snaps shut on its own delay once it burns
    float curl = since > 0.0 ? sat((since - 0.06 * (talon + 1.0)) / 0.18) : 0.0;
    len *= 1.0 - 0.45 * curl;
    vec2 dirT = normalize(htg + hnm * talon * 0.35);
    vec2 bendT = vec2(-dirT.y, dirT.x) * (talon == 0.0 ? 1.0 : -talon) * (1.0 + 1.5 * curl);
    p = base + dirT * a * len - bendT * a * a * len * 0.45;
    p += vec2(-dirT.y, dirT.x) * gauss(i, 73u) * 0.008 * (1.0 - a);
    c = mix(GOLD * 1.6, vec3(1.0, 0.92, 0.75) * 2.2, a);
  }
  if (burn > 0.0) {
    // the fire runs back from the tips; ahead of it gold, at it white flame, behind it ash that falls
    float front = 1.0 - burn;
    if (u > front) {
      float g = (u - front) * 2.0;
      float flame = exp(-g * 6.0);
      vec3 ash = vec3(0.16, 0.14, 0.13) * (0.6 + 0.8 * hf(i, 75u));
      c = mix(ash, vec3(1.0, 0.9, 0.62) * 3.2, flame) + vec3(1.0, 0.45, 0.1) * 1.5 * exp(-g * 2.0) * (0.5 + 0.5 * sin(since * 40.0 + hf(i, 76u) * 20.0));
      vec2 fallDir = vec2(0.02 * sin(hf(i, 77u) * 30.0 + since * 3.0), -1.0);
      float age = max(since - (1.0 - u) * 0.7, 0.0);
      p += fallDir * age * age * 0.18 * (0.5 + hf(i, 78u)) + vec2(0.0, 0.05) * flame * hf(i, 79u);
      if (hf(i, 80u) < 0.08) {
        float an = TAU * hf(i, 81u);
        p += vec2(cos(an), sin(an)) * age * 0.35;
        c = vec3(1.0, 0.7, 0.3) * 2.5 * exp(-age * 3.0);
      }
    }
  }
  col = c * step(0.001, ext);
  sz = 0.003;
}

// ---------------------------------------------------------------- world 5: the mark, the shell, the values
vec2 markPoint(uint i, float grow, out float edge) {
  uint k = hu(i + 91u) % 8u;
  if (k == 7u) {
    float an = TAU * hf(i, 80u);
    float rr = sqrt(hf(i, 81u));
    edge = rr;
    return vec2(cos(an), sin(an)) * rr * MARK_DOT;
  }
  float u = hf(i, 80u) * grow;
  float cap = hf(i, 83u);
  if (cap < 0.14) {
    // the stroke's round ends
    bool outer = cap < 0.07;
    float fu = outer ? grow : 0.0;
    float fe = fu * float(MARK_P - 1);
    int je = min(int(fe), MARK_P - 2);
    vec3 ea = MARK[int(k) * MARK_P + je];
    vec3 eb = MARK[int(k) * MARK_P + je + 1];
    vec3 e = mix(ea, eb, fe - float(je));
    float an = TAU * hf(i, 84u);
    float rr = sqrt(hf(i, 85u));
    edge = rr;
    return e.xy + vec2(cos(an), sin(an)) * rr * e.z * 0.97;
  }
  float fj = u * float(MARK_P - 1);
  int j = min(int(fj), MARK_P - 2);
  float f = fj - float(j);
  vec3 a = MARK[int(k) * MARK_P + j];
  vec3 b = MARK[int(k) * MARK_P + j + 1];
  vec2 c = mix(a.xy, b.xy, f);
  float w = mix(a.z, b.z, f);
  vec2 tg = normalize(b.xy - a.xy);
  vec2 nm = vec2(-tg.y, tg.x);
  float v = hf(i, 81u) * 2.0 - 1.0;
  edge = abs(v);
  return c + nm * v * w * 0.97;
}

void worldSanctum(uint i, float t, out vec2 p, out vec3 col, out float sz, out float kind) {
  kind = 0.0;
  int idx = int(i);
  vec2 M = u_a.xy;
  float Rm = u_a.z;
  float mrot = u_a.w;
  float collapse = u_c.x;
  float retract = u_c.y;
  if (idx < 48000) {
    float edge;
    vec2 q = markPoint(i, 1.0 - retract, edge);
    uint stroke = hu(i + 91u) % 8u;
    q *= 1.0 + 0.035 * sin(t * (1.9 + 0.37 * float(stroke)) + float(stroke) * 1.7) * step(float(stroke), 6.5);
    q *= 1.0 - 0.9 * retract * retract;
    p = M + giveOf(rot(mrot) * q * Rm * u_c.z);
    col = mix(u_red * 1.3, vec3(1.0, 0.75, 0.75) * 1.4, 0.25 * (1.0 - edge)) * (0.8 + 0.4 * edge);
    col *= u_c.w;
    sz = 0.0034;
    return;
  }
  if (idx < 84000) {
    Face F = faceNow();
    vec2 fp; vec3 fc; float fs;
    facePart(i, F, t, fp, fc, fs);
    vec2 w = faceToWorld(fp, i, t, F.boil);
    float m = ease((collapse - 0.5 * hf(i, 83u)) / 0.5);
    p = M + swirlMix(w - M, vec2(0.0), m, 5.0 + 3.0 * hf(i, 84u));
    col = mix(fc, vec3(0.3, 0.28, 0.26) * 0.4, sat(m * 1.4)) * (1.0 - m) * u_face2.z;
    sz = fs;
    return;
  }
  // the four strikes, one per value
  int j = idx - 84000;
  int k = j / 4000;
  vec4 st = k == 0 ? u_d : (k == 1 ? u_e : (k == 2 ? u_f : u_b));
  // st: xy the shell point it strikes, z the strike's time, w its kind (0 cipher, 1 bounce)
  float lam = hf(i, 85u);
  vec2 D = u_face1.xy + vec2(0.0, -0.2) * u_face1.z;
  vec2 S = st.xy;
  float arrive = st.z - 0.05 + lam * 0.3;
  float f = (t - (arrive - 0.45)) / 0.45;
  if (f < 0.0) { col = vec3(0.0); p = D; sz = 0.003; return; }
  vec2 C = mix(D, S, 0.5) + vec2(-(S - D).y, (S - D).x) * 0.25 * (hf(i, 86u) - 0.5);
  vec2 spread = vec2(gauss(i, 87u), gauss(i, 88u)) * 0.012;
  if (f < 1.0) {
    p = bez(D, C, S, ease(f)) + spread * (1.0 - f);
    col = GOLD * 1.2;
    kind = hf(i, 89u) < 0.6 ? 1.0 : 0.0;
    sz = kind > 0.5 ? 0.009 : 0.0035;
    return;
  }
  float g = t - arrive;
  if (st.w < 0.5) {
    // through the shell as cipher, spiralling slowly into the mark
    if (hf(i, 92u) > 0.1) { col = vec3(0.0); p = S; sz = 0.003; return; }
    float m = ease(g / 1.6);
    p = M + swirlMix(S - M + spread * 9.0, vec2(0.0), m, 2.2);
    col = mix(vec3(1.0, 0.92, 0.9) * 1.1, u_red * 1.4, sat(m * 1.6)) * (1.0 - m * m);
    kind = 2.0;
    sz = 0.022;
  } else {
    vec2 n = normalize(S - M);
    vec2 v = reflect(normalize(S - D), n);
    float an = (hf(i, 90u) - 0.5) * 1.6;
    v = rot(an) * v;
    p = S + v * g * (0.5 + 0.6 * hf(i, 91u)) + vec2(0.0, -0.15 * g * g) + spread;
    col = mix(vec3(1.0, 0.95, 0.8) * 2.5, vec3(0.3, 0.28, 0.25) * 0.3, sat(g * 2.5)) * exp(-g * 1.8);
    sz = 0.0035;
  }
}

// ---------------------------------------------------------------- world 6: the mark on charcoal
void worldClose(uint i, float t, out vec2 p, out vec3 col, out float sz, out float kind) {
  kind = 0.0;
  float life = fract(hf(i, 95u) + t * (0.06 + 0.08 * hf(i, 96u)));
  p = vec2((hf(i, 97u) - 0.5) * 1.2 + 0.03 * sin(t + hf(i, 98u) * 30.0), -1.05 + life * 2.1);
  col = u_charcoal * 5.0 * sin(PI * life) * u_f.x;
  sz = 0.003 + 0.004 * hf(i, 99u);
}

void main() {
  uint i = uint(gl_VertexID);
  float t = u_t;
  vec2 p = vec2(0.0);
  vec3 col = vec3(0.0);
  float sz = 0.004;
  float kind = 0.0;
  if (u_world == 0) worldVoid(i, t, p, col, sz, kind);
  else if (u_world == 1) worldGalaxy(i, t, p, col, sz, kind);
  else if (u_world == 2) worldEye(i, t, p, col, sz, kind);
  else if (u_world == 3) worldPlanet(i, t, p, col, sz, kind);
  else if (u_world == 4) worldField(i, t, p, col, sz, kind);
  else if (u_world == 5) worldSanctum(i, t, p, col, sz, kind);
  else worldClose(i, t, p, col, sz, kind);
  float px = sz * u_cam.z * u_res.y * 0.5;
  float s = clamp(px, 1.3, 120.0);
  float energy = px < 1.3 ? (px * px) / (1.3 * 1.3) : 1.0;
  gl_PointSize = s;
  gl_Position = vec4(toClip(p), 0.0, 1.0);
  v_col = col * u_gain * energy;
  v_kind = kind;
  v_aux = hf(i, 199u);
  if (dot(v_col, v_col) < 1e-10) gl_Position = vec4(3.0, 3.0, 0.0, 1.0);
}
`;

/** A particle's sprite: a soft point, a word bubble with its lines, or a block of cipher. */
export const PARTICLE_FS = `${HEADER}
uniform float u_t;
in vec3 v_col;
in float v_kind;
in float v_aux;
out vec4 outColor;

uint hu(uint x) {
  x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u;
  return x;
}

void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float a;
  if (v_kind < 0.5) {
    a = exp(-dot(d, d) * 3.2);
  } else if (v_kind < 1.5) {
    // a speech bubble: rounded body, a tail at its lower left, two lines of words with gaps
    vec2 q = vec2(d.x, -d.y) * vec2(1.0, 1.7) + vec2(0.0, -0.18);
    vec2 bq = abs(q) - vec2(0.82, 0.5);
    float box = length(max(bq, 0.0)) + min(max(bq.x, bq.y), 0.0) - 0.12;
    vec2 tq = q - vec2(-0.45, -0.62);
    float tail = max(max(-tq.x, tq.y), tq.x * 1.2 + tq.y * 1.0 - 0.1);
    float shape = min(box, tail);
    float fill = smoothstep(0.04, -0.04, shape);
    float rim = smoothstep(0.1, 0.0, abs(shape + 0.03));
    float wordGap1 = step(0.14, fract(q.x * 2.3 + v_aux * 5.0));
    float wordGap2 = step(0.18, fract(q.x * 1.9 + v_aux * 9.0));
    float line1 = step(abs(q.y - 0.18), 0.09) * step(abs(q.x + 0.08), mix(0.35, 0.62, v_aux)) * wordGap1;
    float line2 = step(abs(q.y + 0.2), 0.09) * step(abs(q.x + 0.2), mix(0.18, 0.5, fract(v_aux * 7.0))) * wordGap2;
    a = fill * 0.14 + rim * 0.75 + (line1 + line2) * fill * 1.0;
  } else {
    // a block of cipher: a 3 by 5 glyph grid that re-rolls a few times a second
    vec2 q = d * vec2(1.25, 1.0);
    if (abs(q.y) > 0.9 || abs(q.x) > 0.9) {
      a = 0.0;
    } else {
      vec2 g = (q + 0.9) / 1.8 * vec2(3.0, 5.0);
      ivec2 cell = ivec2(floor(g));
      vec2 f = fract(g);
      float inset = step(0.12, f.x) * step(f.x, 0.88) * step(0.12, f.y) * step(f.y, 0.88);
      uint h = hu(uint(cell.x * 7 + cell.y * 131) + uint(v_aux * 9973.0) + uint(floor(u_t * 6.0)) * 7919u);
      a = (h % 5u < 2u) ? 0.0 : inset * 1.0;
    }
  }
  outColor = vec4(v_col * a, 0.0);
}
`;
