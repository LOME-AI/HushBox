/**
 * Identity's link-guest principal resolution, published for the slices whose
 * guest-reachable routes must authorize a presented link credential themselves
 * (the HTTP route-class matrix admits no link-guest principal).
 */
export { resolveLinkGuestPrincipal } from '../domain/link-guest.js';
