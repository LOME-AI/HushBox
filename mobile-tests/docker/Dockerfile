# Content-hashed base for the HushBox Android emulator container.
#
# This Dockerfile intentionally builds nothing on top of budtmo — the upstream
# image already ships the emulator, Android system image, AVD, and in-container
# adb. Its only job is to pin the budtmo version reproducibly: the hash of this
# file is the image tag (computed by scripts/lib/mobile-image.ts), so CI and
# local dev resolve to the exact same content.
#
# Emulators cold-boot from this image on each run (~30-60s, within the boot-wait
# timeout). We deliberately do NOT bake an AVD quick-boot snapshot via
# `docker commit`: committing a live, privileged + /dev/kvm emulator captures a
# snapshot that restores unreliably in a fresh container — the emulator wedges
# "device offline" and never reaches sys.boot_completed. A reliable cold boot
# beats a flaky fast boot.
#
# Any change to this file (including the FROM tag) produces a new content
# hash, invalidating cached images everywhere — CI rebuilds + pushes on the
# next main-deploy; local dev rebuilds on the next `pnpm mobile:test`.
FROM budtmo/docker-android:emulator_14.0
