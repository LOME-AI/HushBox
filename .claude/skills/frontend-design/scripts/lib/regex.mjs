// Escape a string for safe interpolation into a `new RegExp(...)` source.
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { escapeRegExp };
