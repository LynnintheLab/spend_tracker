// IndexedDB wrapper. Every entry lands here first and is only ever *mirrored*
// to the server, so the app writes the same way online and offline.
const DB_NAME = 'spend-note';
const DB_VERSION = 1;
const STORE = 'entries';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('createdAt', 'createdAt');
        os.createIndex('synced', 'synced'); // 0 = still queued, 1 = on the server
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  put: (entry) => tx('readwrite', (s) => s.put(entry)),

  putMany: (entries) => tx('readwrite', (s) => { entries.forEach((e) => s.put(e)); }),

  remove: (id) => tx('readwrite', (s) => s.delete(id)),

  get: (id) => tx('readonly', (s) => s.get(id)),

  all: () =>
    tx('readonly', (s) => s.getAll()).then((rows) =>
      rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    ),

  /** Everything still waiting to reach the server, oldest first. */
  pending: () =>
    tx('readonly', (s) => s.index('synced').getAll(0)).then((rows) =>
      rows.sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1))
    ),
};
