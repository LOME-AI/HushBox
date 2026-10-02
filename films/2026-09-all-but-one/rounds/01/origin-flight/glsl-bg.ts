import { COMMON, HEADER } from './glsl-common.js';

/** One triangle over the whole frame. */
export const FULLSCREEN_VS = `${HEADER}
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** Each world's ground: the light every particle sits in, drawn per pixel in world units. */
export const BG_FS = `${HEADER}${COMMON}
out vec4 outColor;

float stars(vec2 p, float scale, float thresh) {
  vec2 g = p * scale;
  vec2 id = floor(g);
  float h = hash2(id);
  if (h < thresh) return 0.0;
  vec2 f = fract(g) - 0.5 - (vec2(hash2(id + 7.0), hash2(id + 13.0)) - 0.5) * 0.6;
  float tw = 0.7 + 0.3 * sin(u_t * (2.0 + 6.0 * hash2(id + 3.0)) + h * 40.0);
  return exp(-dot(f, f) * 90.0) * (h - thresh) / (1.0 - thresh) * tw;
}

vec3 bgVoid(vec2 p, float t) {
  vec3 c = vec3(0.0015, 0.001, 0.002);
  float neb = fbm(p * 1.4 + vec2(0.0, t * 0.05));
  c += vec3(0.035, 0.014, 0.03) * pow(neb, 3.0) * 1.4;
  c += vec3(0.8, 0.7, 0.6) * stars(p, 60.0, 0.975) * 0.35;
  float r = length(p);
  c += vec3(1.0, 0.7, 0.36) * u_a.x * (0.0016 / (r * r + 0.0005));
  c += vec3(1.0, 0.88, 0.66) * u_a.x * exp(-r * r / 0.0003) * 3.0;
  float s = u_a.y;
  if (s > 0.0 && s < 3.0) {
    float R1 = 1.7 * (1.0 - exp(-s / 0.4));
    c += vec3(1.0, 0.8, 0.55) * exp(-pow((r - R1) / (0.02 + 0.06 * s), 2.0)) * 0.9 * exp(-s / 0.4);
    float R2 = 1.1 * (1.0 - exp(-s / 0.7));
    c += vec3(0.6, 0.45, 1.0) * exp(-pow((r - R2) / (0.03 + 0.08 * s), 2.0)) * 0.45 * exp(-s / 0.6);
  }
  vec2 fc = u_face1.xy;
  vec2 hd = (p - fc) / vec2(0.8, 1.05) / max(u_face1.z, 0.01);
  c += vec3(0.55, 0.2, 0.05) * u_a.z * exp(-dot(hd, hd) * 2.2) * 0.25;
  c += mix(vec3(0.05, 0.022, 0.008), vec3(0.11, 0.05, 0.015), sat(0.5 - p.y * 0.5)) * u_a.z;
  float sm = fbm(vec2(p.x * 3.0, p.y * 2.0 - t * 0.45));
  c += vec3(0.09, 0.04, 0.02) * u_a.w * smoothstep(0.5, 0.9, sm) * smoothstep(-0.2, 0.6, fc.y + 0.3 - p.y);
  return c;
}

vec3 bgGalaxy(vec2 p, float t) {
  float tl = t - u_a.x;
  vec3 c = vec3(0.002, 0.0012, 0.004);
  c += vec3(0.8, 0.8, 1.0) * stars(p, 90.0, 0.97) * 0.4;
  vec2 q = rot(-0.5) * (p - u_b.xy) / GAL_SCALE;
  q.y /= 0.58;
  float r = length(q);
  float th = atan(q.y, q.x);
  float phase = th - 2.3 * log(max(r, 0.01) / 0.035) + (0.55 / (r + 0.25)) * (tl + 2.0) * GAL_SPIN;
  float arms = pow(0.5 + 0.5 * cos(2.0 * phase), 3.0);
  float dust = fbm(q * 4.0 + 1.0);
  float appear = u_a.y;
  c += vec3(0.5, 0.2, 0.6) * arms * exp(-r * 2.0) * 0.3 * appear * (0.3 + dust);
  c += vec3(1.0, 0.72, 0.38) * exp(-r * r / 0.008) * 1.1 * appear;
  c += vec3(0.25, 0.1, 0.3) * pow(fbm(p * 1.5 + 5.0), 2.5) * 0.08;
  // the word the camera dives into: a chat bubble whose last line is a cyan eye
  vec2 d = p - u_b.zw;
  vec2 bq = abs(d) - vec2(0.0115, 0.0052);
  float box = length(max(bq, 0.0)) + min(max(bq.x, bq.y), 0.0) - 0.0022;
  float rim = exp(-pow(box / 0.0006, 2.0));
  float fill = smoothstep(0.0004, -0.0004, box);
  float l1 = step(abs(d.y - 0.0022), 0.0007) * step(abs(d.x + 0.001), 0.0085);
  float l2 = step(abs(d.y + 0.0022), 0.0007) * step(abs(d.x + 0.004), 0.0055);
  vec2 g = d - vec2(0.0062, -0.0022);
  float glint = exp(-dot(g, g) / (0.0011 * 0.0011));
  c += (vec3(1.0, 0.85, 0.55) * (rim * 1.4 + fill * 0.12 + (l1 + l2) * 0.9) * u_c.x + vec3(0.55, 1.0, 1.0) * glint * u_c.y) * appear;
  return c;
}

vec3 bgEye(vec2 p, float t) {
  float s = u_c.y;
  float open = u_a.y;
  vec2 e = p - EYE_C;
  vec2 I = EYE_C + u_b.xy;
  vec2 d = p - I;
  float r = length(d);
  float RI = 0.2 * u_a.z;
  float wr = fbm(p * vec2(5.0, 20.0));
  vec3 skin = vec3(0.07, 0.075, 0.09) * (0.6 + 0.5 * wr);
  float creaseY = 0.33 * pow(max(1.0 - pow(e.x / 0.62, 2.0), 0.0), 0.8);
  skin *= 1.0 - 0.6 * exp(-pow((e.y - creaseY) / 0.012, 2.0));
  float up = lidUp(e.x, open);
  float lo = lidLo(e.x, open);
  vec3 col = skin;
  if (abs(e.x) < 0.52 && e.y < up && e.y > lo) {
    float shade = 0.5 + 0.5 * (1.0 - pow(abs(e.x) / 0.52, 2.0));
    vec3 sc = vec3(0.55, 0.6, 0.68) * shade * 0.55;
    float vein = pow(1.0 - abs(fbm(p * 13.0) * 2.0 - 1.0), 14.0);
    sc += vec3(0.5, 0.1, 0.35) * vein * 0.3;
    if (r < RI) {
      float ang = atan(d.y, d.x);
      float fib = vnoise(vec2(ang * 38.0, r * 30.0));
      sc = mix(vec3(0.02, 0.15, 0.2), vec3(0.05, 0.35, 0.45), fib) * (0.35 + 0.65 * r / RI);
      sc *= 1.0 - 0.7 * smoothstep(RI * 0.88, RI, r);
    }
    if (r < u_b.z) sc = vec3(0.0);
    vec2 hl = d - vec2(-0.06, 0.07) * u_a.z;
    sc += vec3(1.0) * exp(-dot(hl, hl) / 0.0005) * 0.9;
    sc *= 0.35 + 0.65 * smoothstep(0.0, 0.06, up - e.y);
    col = sc;
  }
  float edgeUp = exp(-pow((e.y - up) / 0.004, 2.0)) * step(abs(e.x), 0.52);
  col = mix(col, vec3(0.005), edgeUp * 0.8);
  float leak = u_c.x;
  if (leak > 0.0) {
    float ang = atan(d.y, d.x);
    float cr = 0.0;
    for (int k = 0; k < 8; k++) {
      float ka = float(k) * 0.785 + 0.3 + 0.2 * sin(float(k) * 3.1);
      float da = ang - ka - 0.3 * (fbm(vec2(r * 7.0, float(k) * 3.0)) - 0.5);
      da -= TAU * floor(da / TAU + 0.5);
      float kdel = k < 2 ? 0.0 : 0.15 + 0.7 * hash2(vec2(float(k), 4.0));
      float kw = 0.6 + 0.9 * hash2(vec2(float(k), 5.0));
      float reach = u_c.w < kdel ? 0.0 : RI + u_c.z * (0.35 + 0.6 * hash2(vec2(float(k), 1.0))) * ease((u_c.w - kdel) / 0.35 + 0.6);
      cr += exp(-abs(da) * r / (0.0035 * kw)) * smoothstep(RI * 0.6, RI * 0.9, r) * smoothstep(reach, reach - 0.06, r);
    }
    col += vec3(0.85, 0.3, 1.0) * cr * 2.4 * max(leak, 0.75);
    col += vec3(0.4, 0.1, 0.5) * exp(-r * 6.0) * leak * 0.2;
    col += vec3(1.0, 0.8, 1.0) * exp(-pow((r - RI) / 0.012, 2.0)) * exp(-max(u_c.w, 0.0) / 0.15) * 2.0;
  }
  if (s > 0.0) {
    col *= exp(-s / 0.06);
    vec3 v = vec3(0.003, 0.0015, 0.005) + vec3(0.12, 0.04, 0.16) * pow(fbm(p * 1.3 + 2.0), 3.0) * 0.6;
    v += vec3(0.3, 0.8, 0.4) * pow(fbm(p * 2.1 + 9.0), 4.0) * 0.06;
    v += vec3(0.8, 0.8, 1.0) * stars(p, 70.0, 0.975) * 0.3;
    float R1 = 1.8 * (1.0 - exp(-s / 0.35));
    v += vec3(0.95, 0.8, 1.0) * exp(-pow((r - R1) / (0.02 + 0.07 * s), 2.0)) * 1.1 * exp(-s / 0.35);
    float R2 = 1.2 * (1.0 - exp(-s / 0.6));
    v += vec3(0.5, 1.0, 0.5) * exp(-pow((r - R2) / (0.03 + 0.09 * s), 2.0)) * 0.5 * exp(-s / 0.5);
    col += v * sat(s * 20.0);
  }
  return col;
}

vec3 bgPlanet(vec2 p, float t) {
  vec3 c = mix(vec3(0.004, 0.012, 0.04), vec3(0.02, 0.05, 0.14), sat(0.55 - p.y * 0.4));
  c += vec3(0.8, 0.85, 1.0) * stars(p, 80.0, 0.972) * 0.45;
  c += vec3(0.03, 0.04, 0.09) * pow(fbm(p * 1.2 + 11.0), 3.0);
  vec2 d = (p - PLANET_C) / PLANET_R;
  float r = length(d);
  vec2 L = normalize(vec2(-0.75, 0.66));
  vec2 nd = r > 0.0 ? d / r : vec2(0.0);
  if (r >= 1.0) {
    c += vec3(0.25, 0.5, 1.0) * exp(-(r - 1.0) * 10.0) * 0.8 * (0.35 + 0.65 * sat(dot(nd, L) * 1.2 + 0.3));
    return c;
  }
  float z = sqrt(1.0 - r * r);
  vec3 n = vec3(d, z);
  float lon = atan(n.x, n.z) + (t - u_a.x) * 0.08;
  float lat = asin(clamp(n.y, -1.0, 1.0));
  vec2 sph = vec2(lon * 2.0, lat * 2.5);
  // the three struck cities are there before they are struck
  float nearCity = 0.0;
  for (int k = 0; k < 3; k++) {
    vec2 q = (p - strikePoint(k)) / PLANET_R;
    nearCity = max(nearCity, exp(-dot(q, q) / 0.02));
  }
  float land = max(smoothstep(0.47, 0.55, fbm(sph * 1.3 + 3.0)), smoothstep(0.3, 0.6, nearCity));
  float light = sat(dot(n, normalize(vec3(L * 0.95, -0.3))));
  vec3 day = mix(vec3(0.03, 0.09, 0.26), vec3(0.14, 0.17, 0.07), land) * light * 1.9;
  float cl = smoothstep(0.5, 0.8, fbm(sph * 2.2 + vec2(t * 0.03, 0.0))) * (1.0 - nearCity);
  day = mix(day, vec3(0.8) * light, cl * 0.6);
  float cluster = max(smoothstep(0.45, 0.7, fbm(sph * 4.0 + 7.0)), nearCity);
  float night = sat(1.0 - light * 4.0);
  // streets: a lit grid inside each city, and the brighter blocks at its crossings
  vec2 g2 = sph * 150.0;
  vec2 fs = abs(fract(g2) - 0.5);
  float street = max(smoothstep(0.06, 0.0, fs.x), smoothstep(0.06, 0.0, fs.y)) * step(0.35, hash2(floor(g2 * 0.5) + 3.0));
  vec2 g = sph * 75.0;
  vec2 id = floor(g);
  float hh = hash2(id);
  vec2 f = fract(g) - 0.5;
  float dots = step(0.55, hh) * exp(-dot(f, f) * 45.0) * (0.5 + hh);
  float city = land * cluster * (dots * 1.6 + street * 0.55 * cluster) * night * (1.0 - cl * 0.6);
  vec3 cityCol = vec3(1.0, 0.78, 0.42) * city * 1.3;
  vec3 hit = vec3(0.0);
  for (int k = 0; k < 3; k++) {
    float since = t - (u_a.y + 0.5 * float(k));
    if (since > 0.0) {
      vec2 sp = strikePoint(k);
      vec2 nn = normalize(sp - PLANET_C);
      vec2 tt = vec2(-nn.y, nn.x);
      vec2 q = p - sp;
      // the flare is squashed flat along the surface, and a ring of turned lights runs out through the city
      vec2 sq = vec2(dot(q, tt), dot(q, nn) * 3.5);
      float dd = length(sq);
      float ring = 0.02 + since * 0.1;
      if (since > 1.2) continue;
      float turned = smoothstep(ring + 0.01, ring - 0.01, length(q)) * exp(-since * 0.5);
      cityCol = mix(cityCol, demonColor(k) * city * 2.4, turned * city > 0.0 ? turned : 0.0);
      hit += demonColor(k) * (exp(-pow((length(q) - ring) / 0.004, 2.0)) * exp(-since * 4.0) * 0.6 + exp(-dd * dd / 0.0012) * exp(-since / 0.2) * 2.5);
      // the impact itself: a white star on the strike's own frame
      float star = exp(-dot(q, q) / 0.0006) + 0.4 * exp(-abs(dot(q, tt)) / 0.002) * exp(-abs(dot(q, nn)) / 0.03) + 0.4 * exp(-abs(dot(q, nn)) / 0.002) * exp(-abs(dot(q, tt)) / 0.05);
      hit += vec3(1.0, 0.98, 0.9) * star * 5.0 * exp(-since / 0.1);
    }
  }
  float rim = pow(1.0 - z, 3.0) * sat(dot(nd, L) * 1.5 + 0.3);
  c = day + cityCol + hit + vec3(0.35, 0.6, 1.0) * rim * 1.5;
  return c * smoothstep(1.0, 0.985, r);
}

vec3 bgField(vec2 p, float t) {
  vec3 c = vec3(0.0015, 0.001, 0.001);
  c += vec3(0.9, 0.8, 0.6) * stars(p, 70.0, 0.978) * 0.25;
  c += vec3(0.035, 0.017, 0.006) * pow(fbm(p * 1.8 + t * 0.03), 3.0) * 1.5;
  c += mix(vec3(0.02, 0.011, 0.004), vec3(0.06, 0.034, 0.01), sat(0.6 - p.y * 0.5));
  float s = u_d.x;
  float r = length(p - u_b.zw);
  if (s > 0.0) {
    c += u_red * exp(-pow((r - s * 0.3) / (0.004 + 0.012 * s), 2.0)) * exp(-s * 2.5) * 0.5;
  }
  c += u_red * exp(-r * r / 0.004) * 0.06 * u_c.x;
  // the one spiral that is not his: the HushBox mark, small, among them
  float d = markSdf((p - u_b.zw) / 0.05, 1.0, 1.0) * 0.05;
  c += u_red * smoothstep(0.0015, -0.0015, d) * 0.9 * u_c.x;
  return c * u_d.y;
}

vec3 bgSanctum(vec2 p, float t) {
  vec2 M = u_a.xy;
  float Rm = u_a.z * u_c.z;
  // a cold graphite ground with drifting ash: the Devil's gold and the mark's red are the only colour in it
  vec3 c = mix(vec3(0.004, 0.006, 0.01), vec3(0.018, 0.022, 0.032), sat(0.6 - p.y * 0.4));
  c += vec3(0.03, 0.035, 0.045) * pow(fbm(p * 1.6 + vec2(0.0, t * 0.05)), 2.5);
  c += vec3(0.7, 0.75, 0.85) * stars(p, 80.0, 0.982) * 0.2;
  vec2 q = rot(-u_a.w) * ungiveOf(p - M) / Rm;
  float d = markSdf(q, 1.0 - u_c.y, 1.0);
  c += u_red * exp(-max(d, 0.0) * 22.0) * 0.1 * u_c.w * step(0.0, d);
  c += u_red * smoothstep(0.02, -0.02, d) * 0.22 * u_c.w;
  float ang = atan(p.y - M.y, p.x - M.x);
  float rr = length(p - M);
  float Rs = Rm * 1.18;
  for (int k = 0; k < 4; k++) {
    vec4 st = k == 0 ? u_d : (k == 1 ? u_e : (k == 2 ? u_f : u_b));
    float since = t - st.z;
    if (since > 0.0 && since < 1.4) {
      float shell = exp(-pow((rr - Rs) / 0.006, 2.0));
      float along = length(p - st.xy);
      float cell = abs(sin(ang * 40.0) * sin(rr * 120.0));
      c += vec3(0.85, 0.92, 1.0) * shell * exp(-along / (0.04 + 0.7 * since)) * exp(-since * 3.0) * 2.5;
      c += vec3(0.5, 0.6, 0.75) * smoothstep(Rs + 0.02, Rs, rr) * smoothstep(Rs - 0.12, Rs, rr) * cell * exp(-along / (0.06 + 0.9 * since)) * exp(-since * 3.5) * 0.5;
    }
  }
  return c;
}

vec3 bgClose(vec2 p, float t) {
  vec3 c = u_charcoal;
  vec2 q = rot(-u_a.w) * (p - u_a.xy) / u_a.z;
  float d = markSdf(q, u_b.x, u_b.y);
  float aa = fwidth(d) * 0.75;
  c = mix(c, u_red, smoothstep(aa, -aa, d));

  return c;
}

void main() {
  vec2 clip = gl_FragCoord.xy / u_res * 2.0 - 1.0;
  vec2 p = fromClip(clip);
  float t = u_t;
  vec3 c;
  if (u_world == 0) c = bgVoid(p, t);
  else if (u_world == 1) c = bgGalaxy(p, t);
  else if (u_world == 2) c = bgEye(p, t);
  else if (u_world == 3) c = bgPlanet(p, t);
  else if (u_world == 4) c = bgField(p, t);
  else if (u_world == 5) c = bgSanctum(p, t);
  else c = bgClose(p, t);
  outColor = vec4(c * u_gain, 0.0);
}
`;

/**
 * The finish: bloom from the scene's mips, exposure, a tinted flash, a filmic
 * roll-off (or none, for the brand close), vignette, the text scrim, grain and
 * the type composited last.
 */
export const POST_FS = `${HEADER}
uniform sampler2D u_scene;
uniform sampler2D u_text;
uniform vec2 u_res;
uniform float u_exposure;
uniform vec4 u_flash;
uniform float u_bloom;
uniform float u_aberr;
uniform float u_vignette;
uniform vec4 u_scrim;
uniform float u_direct;
uniform float u_frame;
uniform vec3 u_tint;
out vec4 outColor;

float hash(vec2 p) {
  uvec2 q = uvec2(p) + uvec2(uint(u_frame) * 7919u, uint(u_frame) * 104729u);
  uint h = q.x * 1664525u ^ (q.y * 22695477u + 1013904223u);
  h ^= h >> 16u; h *= 0x7feb352du; h ^= h >> 15u;
  return float(h) / 4294967296.0;
}

/** One mip level of the scene through a 4x4 tent: a plain bilinear read of a coarse level shows its blocks. */
vec3 softLod(vec2 uv, float lod) {
  vec2 texel = exp2(lod) / u_res;
  vec3 s = vec3(0.0);
  float w = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      float k = (3.0 - abs(float(x))) * (3.0 - abs(float(y)));
      s += textureLod(u_scene, uv + vec2(float(x), float(y)) * texel * 0.75, lod).rgb * k;
      w += k;
    }
  }
  return s / w;
}

vec3 encode(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 cc = uv - 0.5;
  vec3 hdr;
  hdr.r = texture(u_scene, uv + cc * u_aberr * 0.014).r;
  hdr.g = texture(u_scene, uv).g;
  hdr.b = texture(u_scene, uv - cc * u_aberr * 0.014).b;
  vec3 bloom = softLod(uv, 2.0) * 0.25 + softLod(uv, 3.5) * 0.35 + softLod(uv, 5.0) * 0.4;
  vec3 lit = (hdr + bloom * u_bloom) * u_exposure + u_flash.rgb * u_flash.a;
  vec3 tm = (1.0 - exp(-lit * 1.25)) * u_tint;
  tm = max(tm - 0.004, 0.0) / 0.996;
  vec3 c = mix(tm, clamp(hdr + u_flash.rgb * u_flash.a, 0.0, 1.0), u_direct);
  float vig = pow(length(cc * vec2(1.0, 0.78)) * 1.35, 2.4);
  c *= 1.0 - u_vignette * vig;
  float y = (1.0 - uv.y) * u_res.y;
  float band = smoothstep(u_scrim.y - u_scrim.w, u_scrim.y, y) * smoothstep(u_scrim.z + u_scrim.w, u_scrim.z, y);
  c *= 1.0 - u_scrim.x * band;
  vec3 s = encode(c);
  s += (hash(gl_FragCoord.xy) - 0.5) * mix(0.035, 0.02, u_direct);
  vec4 tx = texture(u_text, vec2(uv.x, 1.0 - uv.y));
  s = mix(s, tx.rgb, tx.a);
  outColor = vec4(clamp(s, 0.0, 1.0), 1.0);
}
`;
