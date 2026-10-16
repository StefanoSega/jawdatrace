/**
 * Minimal in-memory mock of @forge/kvs. Secrets live in a separate map, like
 * the real encrypted secret storage.
 */
export const kvsData = new Map();
export const kvsSecrets = new Map();

export function resetKvs() {
  kvsData.clear();
  kvsSecrets.clear();
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

export const kvs = {
  async get(key) {
    return clone(kvsData.get(key));
  },
  async set(key, value) {
    kvsData.set(key, clone(value));
  },
  async getSecret(key) {
    return clone(kvsSecrets.get(key));
  },
  async setSecret(key, value) {
    kvsSecrets.set(key, clone(value));
  },
};

export default kvs;
