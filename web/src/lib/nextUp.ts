// TG-69: the trip page's Next up card (ux.md). RED stub: the types the tests are written against; nothing is built yet.

import type { BusRow, Guide, GuideRow } from "./guide.ts";
import type { Trip } from "./trip.ts";

export type Direction = "outbound" | "return";
export type BusPart = { kind: "bus"; direction: Direction; row: BusRow; booked: boolean } | { kind: "gone"; direction: Direction };
export type Then = { time: string | null; plan: string };
export type StopPart =
  | { kind: "row"; day: number; key: string; time: string | null; plan: string; leg: string | null; mapsUrl: string | null; mapsName: string | null; then: Then | null }
  | { kind: "busRow"; day: number; key: string; plan: string; bus: BusPart | null; then: Then | null }
  | { kind: "pick"; day: number; title: string }
  | { kind: "todayDone"; nextDay: number; tomorrow: Then | null }
  | { kind: "allDone" }
  | { kind: "nothingToday" }
  | { kind: "opening" };
export type HotelPart =
  | { from: "trip"; name: string; address: string; mapsUrl: string; checkOut: string | null }
  | { from: "lodging"; name: string; mapsUrl: string }
  | { from: "none" };
export type NextUp =
  | { state: "during"; day: number; days: number; date: string; stop: StopPart | null; bus: BusPart | null; hotel: HotelPart | null }
  | { state: "tomorrow"; date: string; bus: BusPart | null; todos: { left: number } | null };
export type Phase = "before" | "tomorrow" | "during" | "after";
export type NextUpJump = { day?: number; key?: string; menu?: "buses" | "todo" };
export type NextUpTrip = Pick<Trip, "start_date" | "return_date" | "hotel" | "marks">;
export type TableRow = { table: "getting_there" | "getting_home"; row: BusRow };

const RED = () => {
  throw new Error("TG-69: not built yet");
};

export const toMinutes = (_hhmm: string): number => RED();
export const pickBus = (_rows: readonly TableRow[], _now: string | null): BusPart | null => RED();
export const busOn = (_guide: Guide, _date: string, _now: string | null): BusPart | null => RED();
export const busFor = (_guide: Guide, _row: GuideRow, _date: string): BusPart | null => RED();
export const phase = (_today: string, _trip: Pick<Trip, "start_date" | "return_date">): Phase => RED();
export const nextUp = (_a: { today: string; now: string; trip: NextUpTrip; guide: Guide | "frame" | null; city: string }): NextUp | null => RED();
export const jumpFor = (_stop: StopPart): NextUpJump | null => RED();
export const dayLine = (_up: Extract<NextUp, { state: "during" }>): string => RED();
export const shortDate = (_iso: string): string => RED();
export const thenLine = (_then: Then): string => RED();
export const tomorrowLine = (_then: Then): string => RED();
export const todosLine = (_left: number): string => RED();
export const busLines = (_part: Extract<BusPart, { kind: "bus" }>): { time: string; route: string; checked: string } => RED();
export const nextUpLog = (_today: string, _trip: Pick<Trip, "start_date" | "return_date">, _up: NextUp | null): string => RED();
