// Local storage on the phone (IndexedDB): athletes, sessions (results + landmarks), media blobs, settings.
const DB_NAME = 'coachflip', VERSION = 1;
let dbp = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('athletes', { keyPath: 'id' });
      const s = d.createObjectStore('sessions', { keyPath: 'id' });
      s.createIndex('athleteId', 'athleteId');
      d.createObjectStore('media', { keyPath: 'id' });
      d.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
const tx = async (store, mode, fn) => {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode), st = t.objectStore(store);
    const r = fn(st);
    t.oncomplete = () => resolve(r?.result ?? r);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
};
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const store = {
  athletes: () => tx('athletes', 'readonly', (s) => s.getAll()),
  putAthlete: (a) => tx('athletes', 'readwrite', (s) => s.put(a)),
  deleteAthlete: async (id) => {
    const ss = await store.sessions(id);
    for (const x of ss) await store.deleteSession(x.id);
    return tx('athletes', 'readwrite', (s) => s.delete(id));
  },
  sessions: (athleteId) => tx('sessions', 'readonly', (s) => s.index('athleteId').getAll(athleteId)),
  session: (id) => tx('sessions', 'readonly', (s) => s.get(id)),
  putSession: (x) => tx('sessions', 'readwrite', (s) => s.put(x)),
  deleteSession: async (id) => { await tx('media', 'readwrite', (s) => s.delete(id)); return tx('sessions', 'readwrite', (s) => s.delete(id)); },
  putMedia: (id, blob, type) => tx('media', 'readwrite', (s) => s.put({ id, blob, type })),
  media: (id) => tx('media', 'readonly', (s) => s.get(id)),
  getSetting: async (key, dflt) => (await tx('settings', 'readonly', (s) => s.get(key)))?.value ?? dflt,
  setSetting: (key, value) => tx('settings', 'readwrite', (s) => s.put({ key, value })),
  async estimate() { return navigator.storage?.estimate ? navigator.storage.estimate() : null; },
};
