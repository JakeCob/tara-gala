// TG-50: this phone's payout QR (GCash, Maya or a bank's InstaPay QR), browser only. Owner decision: payout QRs stay
// on each person's own phone and are never uploaded; when someone pays you, you show it from here.
import { idbStore } from "./idb.ts";

export type PayoutQr = { id: "mine"; type: string; size: number; addedAt: string; blob: Blob };

const store = idbStore<PayoutQr>("tara-gala-payout", "qr");

export const loadPayoutQr = () => store.get("mine");
export const savePayoutQr = (qr: Omit<PayoutQr, "id">) => store.put({ ...qr, id: "mine" });
export const deletePayoutQr = () => store.delete("mine");
