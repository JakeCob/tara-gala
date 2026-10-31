// TG-50 story 5: the ticket wallet's store, browser only. StoredTicket rows with the photo kept as a Blob, in the
// "tara-gala-wallet" IndexedDB database (see idb.ts).
import { idbStore } from "./idb.ts";
import { sortTickets, type StoredTicket } from "./ticketWallet.ts";

const tickets = idbStore<StoredTicket>("tara-gala-wallet", "tickets");

export async function listTickets(): Promise<StoredTicket[]> {
  return sortTickets(await tickets.getAll());
}

export const saveTicket = tickets.put;
export const deleteTicket = tickets.delete;
export const clearTickets = tickets.clear;
