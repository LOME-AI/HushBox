/**
 * A narrow door: one capability, published for another slice's domain to import
 * without taking the whole barrel. A `public/` module reaches only its own slice
 * and the lib dirs, so consuming one cannot drag a foreign slice in behind it.
 */
export { buildGreeting } from '../domain/greeting.js';
