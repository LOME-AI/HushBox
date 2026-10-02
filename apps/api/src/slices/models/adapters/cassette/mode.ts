/**
 * Record on miss, replay on hit — the operative policy. The first uncached call
 * in CI is a real recorded call; identical calls thereafter replay from the
 * shared cassette store (CI restores the local cassette directory from it before
 * the suite and stores new recordings after), so a warm cache means zero real calls
 * without ever failing on a cold one. Consulted only on the CI-vitest
 * real provider path; production uses plain fetch and dev/E2E the mock provider,
 * so no other mode is selected here. `replay-only` remains a valid `CassetteMode`
 * value but is exercised only by the cassette unit tests.
 */
type CassetteMode = 'record' | 'replay-only';

export function cassetteModeFor(): CassetteMode {
  return 'record';
}
