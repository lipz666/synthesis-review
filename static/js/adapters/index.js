// Adapter registry. Unknown schema versions are reported, never guessed at.

import tseV1 from './tse_v1.js';

const ADAPTERS = {
  [tseV1.schemaVersion]: tseV1,
};

export function adapterFor(schemaVersion) {
  return ADAPTERS[schemaVersion] || null;
}

export function knownSchemas() {
  return Object.keys(ADAPTERS);
}
