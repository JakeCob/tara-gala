// TG-73 P0: the Ipon goal's money, the web's twin of api/app/pot_math.py (plan §4). Pure, whole centavos, integers
// only, no runtime imports. Both suites read api/tests/fixtures/pot_vectors.json, so the close sheet's preview (W2) and
// the server can't drift. The server's close-out is the one that counts; this only shows it before the treasurer taps.
//
// The proportional step multiplies the leftover by each ambag. A pot can hold more than one ₱100,000 ambag per person,
// so that product can pass 2^53: it's done in BigInt, and every answer is back to a safe integer.

export type PotPersonRow = { member_id: string; in_goal: boolean; target: number | null }; // target null: the goal's each
export type AmbagRow = { member_id: string; kind: "in" | "back"; amount: number; status: "sent" | "received" };
export type Cents = Record<string, number>;

export type PotNumbers = {
  contributed: Cents; // c_i: received "in" less "back", wallet order
  received: number; // C
  spent: number; // S
  balance: number; // B = C - S; below zero is "short"
  targets: Cents; // the in-goal people's own amount, or each
  pendingCentavos: number; // "sent" rows: they don't count until Received
  pendingCount: number;
  inGoal: string[]; // wallet order
};

export type CloseOut =
  | { ok: true; refunds: Cents; shortfall: Cents; delta: Cents } // refunds and shortfall: T first, then wallet order
  | { ok: false; error: "no_one_in_goal" };

/** The pot's numbers. Throws on a caller bug (a row outside the wallet, a give-back above what was put in). */
export function potNumbers(people: PotPersonRow[], ambag: AmbagRow[], spends: number[], each: number, order: string[]): PotNumbers {
  const rank = new Map(order.map((m, i) => [m, i]));
  const byRank = (a: string, b: string) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
  const c = new Map<string, number>(people.map((p) => [p.member_id, 0]));
  let pendingCentavos = 0;
  let pendingCount = 0;
  for (const a of ambag) {
    if (!(a.kind === "in" || a.kind === "back") || !(a.status === "sent" || a.status === "received") || a.amount < 1) {
      throw new Error("bad ambag row");
    }
    if (a.kind === "back" && a.status !== "received") throw new Error("a give-back is always received");
    if (!c.has(a.member_id)) c.set(a.member_id, 0);
    if (a.status === "sent") {
      pendingCentavos += a.amount;
      pendingCount += 1;
    } else {
      c.set(a.member_id, (c.get(a.member_id) ?? 0) + (a.kind === "in" ? a.amount : -a.amount));
    }
  }
  for (const [m, v] of c) {
    if (!rank.has(m)) throw new Error("everyone in the pot must be in the wallet order");
    if (v < 0) throw new Error("a give-back can't be more than what that person put in");
  }
  if (spends.some((s) => s < 1)) throw new Error("a pot spend is at least 1 centavo");
  const contributed: Cents = {};
  for (const m of [...c.keys()].sort(byRank)) contributed[m] = c.get(m) ?? 0;
  const targets: Cents = {};
  for (const p of [...people].sort((a, b) => byRank(a.member_id, b.member_id))) {
    if (p.in_goal) targets[p.member_id] = p.target === null ? each : p.target;
  }
  const inGoal = people.filter((p) => p.in_goal).map((p) => p.member_id).sort(byRank);
  const received = Object.values(contributed).reduce((a, b) => a + b, 0);
  const spent = spends.reduce((a, b) => a + b, 0);
  return { contributed, received, spent, balance: received - spent, targets, pendingCentavos, pendingCount, inGoal };
}

/** floor(amount × w / W) each in BigInt, then the leftover one each in `order`, skipping weight 0 (wallet_splits.allocate). */
function allocateBig(amount: number, weights: Cents, order: string[]): Cents {
  const W = BigInt(Object.values(weights).reduce((a, b) => a + b, 0));
  const out: Cents = {};
  for (const [m, w] of Object.entries(weights)) out[m] = Number((BigInt(amount) * BigInt(w)) / W);
  let left = amount - Object.values(out).reduce((a, b) => a + b, 0);
  for (const m of order) {
    if (left === 0) break;
    if ((weights[m] ?? 0) > 0) {
      out[m] += 1;
      left -= 1;
    }
  }
  return out;
}

function inOrder(found: Cents, order: string[]): Cents {
  const out: Cents = {};
  for (const m of order) if (m in found) out[m] = found[m];
  return out;
}

/** The close-out of plan §4.2: refunds by ambag when B > 0 (T keeps the odd centavo), or the shortfall split equally over
 *  the in-goal people, T first, all of it owed to T (owner Q2). A T out of the goal covers it and takes no part. */
export function closeOut(n: PotNumbers, treasurer: string, order: string[]): CloseOut {
  if (!order.includes(treasurer)) throw new Error("the treasurer must be in the wallet order");
  const tFirst = [treasurer, ...order.filter((m) => m !== treasurer)];
  const delta: Cents = {};
  for (const m of order) delta[m] = 0;
  let refunds: Cents = {};
  let shortfall: Cents = {};
  const b = n.balance;
  if (b > 0) {
    const weights: Cents = {};
    for (const [m, v] of Object.entries(n.contributed)) if (v > 0) weights[m] = v;
    refunds = inOrder(allocateBig(b, weights, tFirst), tFirst);
    for (const [m, r] of Object.entries(refunds)) if (m !== treasurer) delta[m] += r;
    delta[treasurer] -= b - (refunds[treasurer] ?? 0);
  } else if (b < 0) {
    const d = -b;
    if (n.inGoal.length === 0) return { ok: false, error: "no_one_in_goal" };
    const ones: Cents = {};
    for (const m of n.inGoal) ones[m] = 1;
    shortfall = inOrder(allocateBig(d, ones, tFirst), tFirst);
    for (const [m, part] of Object.entries(shortfall)) if (m !== treasurer) delta[m] -= part;
    delta[treasurer] += d - (shortfall[treasurer] ?? 0);
  }
  return { ok: true, refunds, shortfall, delta };
}
