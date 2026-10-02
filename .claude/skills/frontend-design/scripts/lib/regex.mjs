// Escape a string for safe interpolation into a `new RegExp(...)` source.
/** @param {unknown} value */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { escapeRegExp };
