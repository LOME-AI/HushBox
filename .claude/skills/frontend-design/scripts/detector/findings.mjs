import { getAntipattern } from './registry/antipatterns.mjs';

function getAP(id) {
  return getAntipattern(id);
}

function finding(id, filePath, snippet, line = 0) {
  const ap = getAP(id);
  // An id with no registry entry must not crash the whole scan. Degrade to a
  // minimal finding that still carries the id, snippet, and location.
  if (!ap) {
    return { antipattern: id, name: id, description: '', severity: 'warning', file: filePath, line, snippet };
  }
  return { antipattern: id, name: ap.name, description: ap.description, severity: ap.severity || 'warning', file: filePath, line, snippet };
}

export { getAP, finding };
