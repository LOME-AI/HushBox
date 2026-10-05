/**
 * Billing's routing cap, published as its own entry point: a billable rate
 * pair un-baked into a call's `max_price`. The models slice prices its
 * language calls with it, and billing imports the models barrel, so the barrel
 * would close a cycle that this door cannot.
 */
export { billableRatesToMaxPrice } from '../domain/money.js';
