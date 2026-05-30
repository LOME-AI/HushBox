# Mock AI Client Fixtures

Real sample media used by the mock AI client (`apps/api/src/services/ai/mock.ts`)
when running in local dev and E2E. Each fixture is committed as a
base64-encoded string in a TypeScript file so it bundles cleanly across the
Workers runtime and Vitest, with no filesystem or loader configuration.

## Sources

All three fixtures are downloaded from <https://samplelib.com/>, which
publishes them under an informal "do whatever you want" license with no
attribution requirement (see <https://samplelib.com/license.html>).

| File            | Source URL                                                  | Format             |
| --------------- | ----------------------------------------------------------- | ------------------ |
| `test-image.ts` | <https://www.samplelib.com/jpeg/sample-clouds-400x300.jpg>  | 400×300 JPEG       |
| `test-audio.ts` | <https://www.samplelib.com/mp3/sample-3s.mp3>               | 3-second MP3       |
| `test-video.ts` | <https://www.samplelib.com/mp4/sample-5s-360p.mp4>          | 320×180 H.264 baseline MP4, 3 s, no audio (see regen recipe) |

## Why base64

The mock module is statically imported by the worker bundle. A binary loader
configuration would have to work in both Wrangler and Vitest, which use
different build pipelines. A base64 string in TypeScript bundles identically
in both runtimes and decodes once at module init.

## Regenerating

```sh
curl -sSL -o image.jpg https://www.samplelib.com/jpeg/sample-clouds-400x300.jpg
printf "/* prettier-ignore */\n/* eslint-disable */\nexport const TEST_IMAGE_JPEG_BASE64 =\n  '%s';\n" "$(base64 -w 0 image.jpg)" > test-image.ts
```

The video fixture's encoder flags are load-bearing for the e2e tests: baseline
H.264 + `yuv420p` for browser-engine compatibility, `+faststart` so `<video>`
elements reach `readyState >= 1` before bytes finish loading, no audio (tests
don't assert on it). Keep these flags when regenerating.

```sh
curl -sSL -o video-source.mp4 https://www.samplelib.com/mp4/sample-5s-360p.mp4
ffmpeg -y -i video-source.mp4 \
  -t 3 -vf "scale=320:-2:flags=lanczos,fps=15" \
  -c:v libx264 -profile:v baseline -level 3.0 -preset slow -crf 30 \
  -pix_fmt yuv420p -an -movflags +faststart \
  video.mp4
printf "/* prettier-ignore */\n/* eslint-disable no-secrets/no-secrets */\nexport const TEST_VIDEO_MP4_BASE64 =\n  '%s';\n" "$(base64 -w 0 video.mp4)" > test-video.ts
```

Update `index.ts` constants (`TEST_IMAGE_WIDTH`, `_DURATION_MS`, etc.) if the
source media changes.
