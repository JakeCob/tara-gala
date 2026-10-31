// TG-50 story 5: the ticket wallet's IndexedDB store, browser only. One object store of StoredTicket rows, the photo
// kept as a Blob. It lives in the browser's own storage for this site, apart from the service worker's caches, so an
// app update never clears it.
import { sortTickets, type StoredTicket } from "./ticketWallet.ts";

function openWallet(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // Private browsing in some browsers has no IndexedDB, or throws on open
    if (typeof indexedDB === "undefined") return reject(new Error("no-indexeddb"));
    const req = indexedDB.open("tara-gala-wallet", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("tickets", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** One request in its own transaction; resolves once the transaction commits. */
async function run<T>(mode: IDBTransactionMode, call: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openWallet();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("tickets", mode);
    const req = call(tx.objectStore("tickets"));
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

export async function listTickets(): Promise<StoredTicket[]> {
  return sortTickets(await run<StoredTicket[]>("readonly", (s) => s.getAll()));
}

export async function saveTicket(ticket: StoredTicket): Promise<void> {
  await run("readwrite", (s) => s.put(ticket));
}

export async function deleteTicket(id: string): Promise<void> {
  await run("readwrite", (s) => s.delete(id));
}

export async function clearTickets(): Promise<void> {
  await run("readwrite", (s) => s.clear());
}
