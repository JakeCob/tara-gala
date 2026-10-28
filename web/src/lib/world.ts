// The overworld map's layout (TG-22, ux.md 1 to 3): an itinerary as rows of a vertical world, plus the detail
// sheets and Maps targets. Plain module with type-only imports, so Node's type stripping runs it in tests.
// The runtime helpers it needs (time, fare, sprite names...) come in as Formatters, so nothing is duplicated.
import type { Trip } from "./api.ts";
import type { Itinerary, PlanIssue, StopOut } from "./itinerary.ts";
import type { LastMileLeg } from "./lastMile.ts";
import type { TerminalPlace } from "./mapLinks.ts";
import type { SpriteName } from "./sprites.ts";

export type Side = "left" | "right";
export type BusKey = "outbound" | "return";
export type NodeRef =
  | { type: "stop"; dayIndex: number; stopIndex: number }
  | { type: "terminal"; bus: BusKey; end: "origin" | "destination" };
export type LegRef = { type: "lastMile"; dayIndex: number; stopIndex: number } | { type: "bus"; bus: BusKey };
// title is the bold line; checked is the "Checked Oct 24" trust line, shown on the map on every ride
export type SignLines = { title: string; lines: string[]; checked: string | null; changed: boolean; missing: boolean };
export type TerminalRef = { slug: string; name: string; city: string };
export type WorldRow =
  | { kind: "party"; summary: string }
  | { kind: "banner"; id: string; text: string }
  | { kind: "node"; id: string; side: Side; node: NodeRef; sign: SignLines; sprite: SpriteName | null }
  | { kind: "leg"; id: string; side: Side; leg: LegRef; sign: SignLines; sprite: SpriteName | null; track: "path" | "road" }
  | { kind: "toTerminal"; id: string; side: Side; text: string; terminal: TerminalRef | null }
  | { kind: "turn"; id: string; from: Side; to: Side }
  | { kind: "free"; id: string; side: Side; text: string };

export type Formatters = {
  time(hhmm: string): string;
  dayOffset(n: number | null): string;
  verified(iso: string | null): string;
  travelDate(iso: string): string;
  modeLabel(mode: string): string;
  fare(min: number | null, max: number | null): string;
  minutes(n: number | null): string;
  peso(n: number | null): string | null;
  partySummary(p: readonly { type: string }[]): string;
  issuesFor(path: string, issues: readonly PlanIssue[]): PlanIssue[];
  placeSprite(kind: string): SpriteName;
  modeSprite(mode: string): SpriteName | null;
};

export const CHANGED = "Changed since this plan was saved";
export const FREE_DAY = "Free time. No stops planned for this day.";
const MISSING_BUS = "This bus is no longer in our schedules";
const MISSING_TERMINAL = "Terminal (no longer listed)";
const MISSING = "No longer in our list";

const flip = (s: Side): Side => (s === "left" ? "right" : "left");
// " · " between the parts that are on file; never a dangling separator, never "₱0" or "0 min"
const joinParts = (parts: string[]) => parts.filter(Boolean).join(" · ");

type NodeRow = Extract<WorldRow, { kind: "node" }>;
type LegRow = Extract<WorldRow, { kind: "leg" }>;

/**
 * The rows in plan order (ux.md 1): the party, the outbound bus, each day's stops (each after its ride), then the
 * return bus. Nodes alternate sides; a turn row sits between a ride and the next node and flips the side.
 */
export function worldLayout(it: Itinerary, f: Formatters): WorldRow[] {
  const rows: WorldRow[] = [{ kind: "party", summary: f.partySummary(it.party) }];
  let side: Side | null = null; // null until the first node, which is left
  let afterRide = false;

  const node = (r: Omit<NodeRow, "kind" | "side">) => {
    const next: Side = side === null ? "left" : afterRide ? flip(side) : side;
    if (afterRide && side !== null) rows.push({ kind: "turn", id: `turn-${r.id}`, from: side, to: next });
    side = next;
    afterRide = false;
    rows.push({ kind: "node", side, ...r });
  };
  const ride = (r: Omit<LegRow, "kind" | "side">) => {
    rows.push({ kind: "leg", side: side ?? "left", ...r });
    afterRide = true;
  };
  const banner = (id: string, text: string) => {
    rows.push({ kind: "banner", id, text });
    afterRide = false;
  };
  const changed = (path: string, keep: (i: PlanIssue) => boolean = () => true) => f.issuesFor(path, it.issues).some(keep);

  const bus = (key: BusKey, prefix: string) => {
    const trip = it[key].trip;
    const terminal = (end: "origin" | "destination"): SignLines => {
      if (!trip) return { title: MISSING_TERMINAL, lines: [], checked: null, changed: false, missing: true };
      const lines =
        end === "origin"
          ? [`Departs ${f.time(trip.departure_time)}`]
          : trip.arrives_around
            ? [`Arrives ${f.time(trip.arrives_around)}${f.dayOffset(trip.arrives_day_offset)}`]
            : [];
      return { title: end === "origin" ? trip.origin_name : trip.destination_name, lines, checked: null, changed: false, missing: false };
    };
    node({ id: `${prefix}-origin`, node: { type: "terminal", bus: key, end: "origin" }, sign: terminal("origin"), sprite: "place-terminal" });
    const isChanged = changed(key);
    const lines: string[] = [];
    if (trip) {
      const arrives = trip.arrives_around ? ` → ${f.time(trip.arrives_around)}${f.dayOffset(trip.arrives_day_offset)}` : "";
      lines.push(`${f.time(trip.departure_time)}${arrives}`);
    }
    if (isChanged) lines.push(CHANGED);
    ride({
      id: `${prefix}-bus`,
      leg: { type: "bus", bus: key },
      track: "road",
      sprite: "vehicle-bus",
      sign: trip
        ? { title: trip.operator_name, lines, checked: f.verified(trip.last_verified_at), changed: isChanged, missing: false }
        : { title: MISSING_BUS, lines, checked: null, changed: isChanged, missing: true },
    });
    node({ id: `${prefix}-destination`, node: { type: "terminal", bus: key, end: "destination" }, sign: terminal("destination"), sprite: "place-terminal" });
  };

  banner("out-banner", `Bus to Baguio · ${f.travelDate(it.outbound.date)}`);
  bus("outbound", "out");

  it.days.forEach((day, d) => {
    // Day 1's date is the bus arrival date (TG-23 applies arrives_day_offset), so it's right for overnight buses
    banner(`d${d}-banner`, day.date ? `Day ${day.day} · ${f.travelDate(day.date)}` : `Day ${day.day}`);
    if (day.stops.length === 0) {
      rows.push({ kind: "free", id: `d${d}-free`, side: side ?? "left", text: FREE_DAY });
      return;
    }
    day.stops.forEach((s, i) => {
      const path = `days[${d}].stops[${i}]`;
      const leg = s.leg;
      const legChanged = changed(`${path}.leg`);
      ride({
        id: `d${d}-s${i}-leg`,
        leg: { type: "lastMile", dayIndex: d, stopIndex: i },
        track: "path",
        sprite: leg ? f.modeSprite(leg.mode) : null,
        sign: {
          title: leg ? joinParts([f.modeLabel(leg.mode), f.minutes(leg.minutes), f.fare(leg.fare_min_php, leg.fare_max_php)]) : MISSING,
          lines: legChanged ? [CHANGED] : [],
          checked: leg ? f.verified(leg.last_verified_at) : null,
          changed: legChanged,
          missing: !leg,
        },
      });
      const stopChanged = changed(path, (issue) => !issue.path.startsWith(`${path}.leg`));
      const times = `${f.time(s.arrive)} – ${f.time(s.leave)}`;
      node({
        id: `d${d}-s${i}-node`,
        node: { type: "stop", dayIndex: d, stopIndex: i },
        // Lodging only when the data marks it (ux.md 2.2): a TG-34 lodging spot is category other, so place-other
        sprite: s.spot ? f.placeSprite(s.spot.category) : null,
        sign: {
          title: s.spot ? s.spot.name : MISSING,
          lines: stopChanged ? [times, CHANGED] : [times],
          checked: null,
          changed: stopChanged,
          missing: !s.spot,
        },
      });
    });
  });

  banner("ret-banner", `Bus to Metro Manila · ${f.travelDate(it.return.date)}`);
  // The plan has no ride back to the terminal, so this row only says where to go: no mode, time or fare
  const back = it.return.trip;
  rows.push({
    kind: "toTerminal",
    id: "ret-to-terminal",
    side: side ?? "left",
    text: back ? `Head to ${back.origin_name} for your ${f.time(back.departure_time)} bus` : "Head to your terminal for the bus back",
    terminal: back ? { slug: back.origin_slug, name: back.origin_name, city: back.origin_city } : null,
  });
  afterRide = true;
  bus("return", "ret");
  return rows;
}

/** Rows grouped into sections, each starting at its banner (the party row stands alone). */
export function worldSections(rows: readonly WorldRow[]): { banner: Extract<WorldRow, { kind: "banner" }>; rows: WorldRow[] }[] {
  const out: { banner: Extract<WorldRow, { kind: "banner" }>; rows: WorldRow[] }[] = [];
  for (const r of rows) {
    if (r.kind === "banner") out.push({ banner: r, rows: [] });
    else if (r.kind !== "party") out.at(-1)?.rows.push(r);
  }
  return out;
}

/** The narrowest world the layout draws: a 320px phone's (ux review). Narrower worlds are laid out as this one. */
export const MIN_WORLD = 256;

/**
 * Where the two 32px tracks sit in a world W px wide (ux.md 2.1). The turn row between them is a whole number of
 * straight tiles, so the path always joins: 316px gives 6 tiles and x = 30 / 254.
 */
export function trackGeometry(W: number): { tile: 32; leftX: number; rightX: number; straights: number } {
  const straights = Math.max(1, Math.floor((Math.max(W, MIN_WORLD) - 124) / 32));
  return { tile: 32, leftX: 30, rightX: 62 + straights * 32, straights };
}

/**
 * The world width to lay out for. A ResizeObserver can report 0 for a moment (while Chrome resizes the viewport for
 * a full-page capture, a parent that's briefly hidden, a tab coming back): keep the last good width instead.
 */
export function usableWidth(measured: number, previous: number): number {
  return measured > 0 ? measured : previous;
}

/**
 * The sign boxes for each track side (ux.md 2.1), in world x. The sign sits on the side away from its track, and
 * both sides get the same width so names wrap the same way in either column: 230px at 316 (a 380px phone).
 */
export function signBoxes(W: number): { left: { x: number; width: number }; right: { x: number; width: number } } {
  const g = trackGeometry(W);
  const width = Math.min(Math.max(W, MIN_WORLD) - 8 - (g.leftX + 48), g.rightX - 16 - 8);
  return { left: { x: g.leftX + 48, width }, right: { x: 8, width } };
}

/** Rotations of tile-path-corner (drawn joining bottom and right) for a turn's two corners (ux.md 2.1). */
export function turnRotations(from: Side, to: Side): { start: number; end: number } {
  if (from === to) throw new Error("a turn must change side");
  return from === "left" ? { start: -90, end: 90 } : { start: 180, end: 0 };
}

/** Walking for walk; driving for jeeps and taxis, since Google's Baguio jeepney transit data is thin (ux.md 3.3). */
export function mapsTravelMode(mode: string): "walking" | "driving" {
  return mode === "walk" ? "walking" : "driving";
}

type SheetRows = [label: string, value: string][];
const present = (pairs: [string, string | null | undefined][]): SheetRows =>
  pairs.filter((p): p is [string, string] => !!p[1]);

/** The ride sheet (ux.md 3.1). Null fields are left out. */
export function legSheet(leg: LastMileLeg, f: Formatters): { title: string; rows: SheetRows; checked: string; note: string } {
  return {
    title: `${f.modeLabel(leg.mode)} to ${leg.destination.name}`,
    rows: present([
      ["From", leg.origin.name],
      ["To", leg.destination.name],
      ["Signboard", leg.signboard],
      ["Board at", leg.boarding_point],
      ["Get off at", leg.alighting_point],
      ["Fare", f.fare(leg.fare_min_php, leg.fare_max_php)],
      ["Time", f.minutes(leg.minutes)],
      ["Notes", leg.notes],
    ]),
    checked: f.verified(leg.last_verified_at),
    note: leg.confirm_note,
  };
}

/** The stop sheet (ux.md 3.2), or null for a stop that didn't join. Opening hours are raw JSON: not shown yet. */
export function stopSheet(stop: StopOut, f: Formatters): { title: string; rows: SheetRows } | null {
  const s = stop.spot;
  if (!s) return null;
  const fee = s.entrance_fee_php == null ? null : s.entrance_fee_php === 0 ? "Free" : f.peso(s.entrance_fee_php);
  return {
    title: s.name,
    rows: present([
      ["Time", `Arrive ${f.time(stop.arrive)} · Leave ${f.time(stop.leave)}`],
      ["Category", s.category === "other" ? null : s.category.charAt(0).toUpperCase() + s.category.slice(1)],
      ["About", s.description],
      ["Entrance", fee],
    ]),
  };
}

export type RowData =
  | { kind: "stop"; stop: StopOut }
  | { kind: "leg"; leg: LastMileLeg }
  | { kind: "bus"; bus: BusKey; trip: Trip }
  | { kind: "terminal"; bus: BusKey; end: "origin" | "destination"; trip: Trip };

/** The data behind a tappable row, by its id; null for rows that didn't join (they have no sheet). */
export function rowData(it: Itinerary, id: string): RowData | null {
  const bus = id.match(/^(out|ret)-(origin|bus|destination)$/);
  if (bus) {
    const key: BusKey = bus[1] === "out" ? "outbound" : "return";
    const trip = it[key].trip;
    if (!trip) return null;
    return bus[2] === "bus" ? { kind: "bus", bus: key, trip } : { kind: "terminal", bus: key, end: bus[2] as "origin" | "destination", trip };
  }
  const m = id.match(/^d(\d+)-s(\d+)-(node|leg)$/);
  const stop = m ? it.days[Number(m[1])]?.stops[Number(m[2])] : undefined;
  if (!m || !stop) return null;
  if (m[3] === "node") return stop.spot ? { kind: "stop", stop } : null;
  return stop.leg ? { kind: "leg", leg: stop.leg } : null;
}

export type MapsTarget = { place: TerminalPlace; travelmode: "transit" | "walking" | "driving"; name: string };

/**
 * The "Open in Google Maps" destination for a row's sheet: coordinates when known, else the name (ux.md 3.3). No
 * origin, so Maps starts where the phone is. Terminals have no coordinates in the joined data: name and city.
 */
export function mapsTarget(it: Itinerary, id: string): MapsTarget | null {
  if (id === "ret-to-terminal") {
    const t = it.return.trip;
    return t ? { place: { slug: t.origin_slug, name: t.origin_name, city: t.origin_city }, travelmode: "transit", name: t.origin_name } : null;
  }
  const d = rowData(it, id);
  if (!d || d.kind === "bus") return null; // the bus sheet is TripCard, with its own terminal links and Book
  if (d.kind === "terminal") {
    const t = d.trip;
    const [slug, name, city] =
      d.end === "origin" ? [t.origin_slug, t.origin_name, t.origin_city] : [t.destination_slug, t.destination_name, t.destination_city];
    return { place: { slug, name, city }, travelmode: "transit", name };
  }
  if (d.kind === "leg") {
    const p = d.leg.destination;
    return { place: { slug: p.slug, name: p.name, city: "", lat: p.lat, lng: p.lng }, travelmode: mapsTravelMode(d.leg.mode), name: p.name };
  }
  const s = d.stop.spot!;
  return { place: { slug: s.slug, name: s.name, city: s.city, lat: s.lat, lng: s.lng }, travelmode: "transit", name: s.name };
}

/** Starts with the visible text (WCAG 2.5.3). */
export function mapsLabel(name: string): string {
  return `Open in Google Maps, directions to ${name}, opens in a new tab`;
}
