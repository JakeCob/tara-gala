// TG-50 story 5, the ticket wallet: bus e-ticket photos kept on this phone only (ticketStore.ts, IndexedDB), so they
// open at the terminal without signal. Pure helpers here; nothing touches the network. Logs carry counts and sizes,
// never a label: a ticket's file name can hold its booking number.

/** Photo types every browser shows. HEIC is left out: only Safari can draw it. */
export const TICKET_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const MAX_TICKET_BYTES = 10 * 1024 * 1024;
export const MAX_TICKETS = 20;

export type StoredTicket = { id: string; label: string; type: string; size: number; addedAt: string; blob: Blob };
export type TicketCheck = { ok: true } | { ok: false; message: string };

/** Whether a picked file can join a wallet that already holds `count` tickets, with a plain reason when not. */
export function checkTicketFile(file: { type: string; size: number }, count: number): TicketCheck {
  if (count >= MAX_TICKETS) return { ok: false, message: `You can keep up to ${MAX_TICKETS} tickets. Delete an old one first.` };
  if (!(TICKET_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, message: "That file isn't a PNG, JPG or WebP photo. For a PDF ticket, take a screenshot and add that." };
  }
  if (file.size === 0) return { ok: false, message: "That file is empty." };
  if (file.size > MAX_TICKET_BYTES) return { ok: false, message: "That photo is over 10 MB. Take a screenshot of the ticket instead." };
  return { ok: true };
}

/** "ticket-VLIX00078671.png" → "ticket VLIX00078671": the file name without its extension, at most 60 characters. */
export function ticketLabel(fileName: string): string {
  const base = fileName.replace(/\.[^.]*$/, "").replace(/[_-]+/g, " ").trim();
  return base.slice(0, 60) || "Ticket";
}

/** Newest first, without sorting the caller's list in place. */
export function sortTickets<T extends { addedAt: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

const ADDED = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "Asia/Manila" });

/** "Added Oct 31", the day in Manila. */
export function addedLine(iso: string): string {
  return `Added ${ADDED.format(new Date(iso))}`;
}
