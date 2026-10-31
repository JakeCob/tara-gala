// TG-50: a tiny IndexedDB store for things that stay on this phone (ticket photos, the payout QR). One database
// per store, version 1, keyed by `id`. Lives apart from the service worker's caches, so an app update never clears it.

/** Rows keyed by a string `id`. Every call opens the database, runs one request in its own transaction and closes. */
export function idbStore<T extends { id: string }>(dbName: string, storeName: string) {
  function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      // Private browsing in some browsers has no IndexedDB, or throws on open
      if (typeof indexedDB === "undefined") return reject(new Error("no-indexeddb"));
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(storeName, { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** One request; resolves once its transaction commits. */
  async function run<R>(mode: IDBTransactionMode, call: (store: IDBObjectStore) => IDBRequest<R>): Promise<R> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const req = call(tx.objectStore(storeName));
      tx.oncomplete = () => {
        db.close();
        resolve(req.result);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(tx.error ?? req.error);
      };
    });
  }

  return {
    getAll: () => run<T[]>("readonly", (s) => s.getAll()),
    get: async (id: string) => (await run<T | undefined>("readonly", (s) => s.get(id))) ?? null,
    put: async (row: T) => void (await run("readwrite", (s) => s.put(row))),
    delete: async (id: string) => void (await run("readwrite", (s) => s.delete(id))),
    clear: async () => void (await run("readwrite", (s) => s.clear())),
  };
}
