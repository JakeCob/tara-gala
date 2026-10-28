// Pre-made trip card data (TG-21). RED stub: the signatures are final, the bodies throw until GREEN.
import type { PremadeSummary } from "./api.ts";

const todo = (): never => {
  throw new Error("TG-21: not implemented");
};

export type PremadeCard = { title: string; matches: boolean; dates: string; places: string; budget: string | null; href: string };

// TODO(TG-23 merge): move dateRange and formatPeso to itinerary.ts
export const dateRange = (_from: string, _to: string | null): string => todo();
export const formatPeso = (_n: number | null): string | null => todo();
export const premadeCard = (_s: PremadeSummary, _date: string, _ret: string): PremadeCard => todo();
