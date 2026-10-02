---
layout_version: 3
date: "2026-01-01"
title: "Full-repo quality audit"
scope: "What this run covered, and what it deliberately did not."
---

**What this run covered.** The territories searched, the depth reached in each, and
anything a reader would reasonably assume was covered but was not.

**How findings were verified.** How claims were adjudicated and what a finding surviving
into `findings/` means.

**Shape of the result.** Counts by severity and by area, and any chains of findings that
have to be resolved together.

## Checked and clean

Territory that was inspected and produced no finding, and prior rulings suppressed at
triage. A finding this run raised and then refuted, duplicated, or put out of scope does
not belong here: it ships as its own denied file, the shape `docs/audits/CLAUDE.md`
specifies. This section is the negative space, and it exists so a later run suppresses
rather than rediscovers.
