# Content-hashed base for the HushBox Android emulator container.
#
# This Dockerfile intentionally builds nothing on top of budtmo — the upstream
# image already ships the emulator, Android system image, AVD, and in-container
# adb. The value of having our own image is two-fold:
#
#   1. The hash of this file pins the budtmo version reproducibly. Both CI and
#      local dev resolve to the exact same content via the content-hash tag
#      computed by scripts/lib/mobile-image.ts.
#
#   2. scripts/bake-mobile-image.ts layers an AVD quick-boot snapshot on top
#      via `docker commit` at deploy time, cutting emulator boot from ~60-120s
#      (cold) to ~5-15s (quick-boot from snapshot). That layer cannot be
#      expressed in a Dockerfile because the snapshot requires booting a
#      privileged + /dev/kvm container, which Docker build sandbox forbids.
#
# Any change to this file (including the FROM tag) produces a new content
# hash, invalidating cached images everywhere — CI rebuilds + pushes on the
# next main-deploy; local dev rebuilds on the next `pnpm mobile:test`.
FROM budtmo/docker-android:emulator_14.0
