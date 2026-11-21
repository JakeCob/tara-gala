// TG-70: where the outbox's rows live (tg-test's seam, plan §3 O2). WalletView and the runner call only this, never
// idbStore directly. The store is injectable, so node tests run on a Map. Node has no IndexedDB, so the default store
// rejects with "no-indexeddb": B23's path, where Save offline keeps today's line and the form. `held` is page state (B20a,
// review D3): the ids whose Remove confirm is open, shared by the Waiting box and the runner, one set per store.
// Logs carry the why and a count only: never a name, a note, the slug or an id.
import { idbStore } from "./idb.ts";
import type { Queued } from "./outbox.ts";

type Rows = Pick<ReturnType<typeof idbStore<Queued>>, "getAll" | "put" | "delete">;

export type OutboxStore = {
  /** Puts a new row, then logs `queued why=… n=<this wallet's rows>`. Rejects when the row couldn't be kept. */
  queue(row: Queued): Promise<void>;
  /** Every row, oldest saved first. */
  list(): Promise<Queued[]>;
  remove(id: string): Promise<void>;
  update(row: Queued): Promise<void>;
  /** B20a: rows the runner mustn't start (a Remove confirm is open). Pass it to `due`. */
  held: Set<string>;
};

export function outboxStore(rows: Rows = idbStore<Queued>("tg-outbox", "expenses")): OutboxStore {
  let warned = false;
  /** One "idb unavailable" line per page, then the rejection goes on to the caller. */
  const guard = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      if (!warned && e instanceof Error && e.message === "no-indexeddb") {
        warned = true;
        console.warn("[tg-outbox] idb unavailable");
      }
      throw e;
    }
  };
  const list = async () => [...(await guard(rows.getAll()))].sort((a, b) => Date.parse(a.savedAt) - Date.parse(b.savedAt));
  return {
    async queue(row) {
      await guard(rows.put(row));
      const n = (await list()).filter((q) => q.slug === row.slug).length;
      console.info(`[tg-outbox] queued why=${row.why ?? "offline"} n=${n}`);
    },
    list,
    remove: (id) => guard(rows.delete(id)),
    update: (row) => guard(rows.put(row)),
    held: new Set<string>(),
  };
}

/** The page's one outbox. */
export const outbox: OutboxStore = outboxStore();
