/**
 * The host Cloudflare Access serves a Zero Trust team from: the admin JWT
 * issuer the API verifies against, and where Access redirects an
 * unauthenticated request for the admin origin. The deploy probe checks that
 * redirect with this same builder, so the two cannot disagree about the team.
 */
export function accessTeamHost(teamDomain: string): string {
  return `${teamDomain}.cloudflareaccess.com`;
}
