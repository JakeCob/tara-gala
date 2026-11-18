// An effect's return value is its cleanup, and React calls it. Chrome 158's scrollIntoView() returns a Promise (CSSOM
// View's scroll promises), so `useEffect(() => el.scrollIntoView(...), [deps])` hands React a Promise, and the next run
// throws "i is not a function" and takes the page down (found by tg-build5 on the TG-61 chat e2e, 2026-11-17). Every
// effect is a block, or returns its own cleanup function. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const SRC = new URL("../", import.meta.url);
const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

test("T-FX1 no effect returns what its body computes: a block, or its own cleanup function", () => {
  assert.ok(files.length > 50, "the scan found the source");
  const bad: string[] = [];
  for (const f of files) {
    const src = readFileSync(new URL(f, SRC), "utf8");
    for (const m of src.matchAll(/use(?:Layout|Insertion)?Effect\(\s*(?:async\s*)?\(\)\s*=>\s*(?=[^\s{])(?!\(\)\s*=>)[^\n]*/g)) bad.push(`${f}: ${m[0]}`);
  }
  assert.deepEqual(bad, []);
});

test("T-FX2 the scan catches the shape it's for", () => {
  const shape = /use(?:Layout|Insertion)?Effect\(\s*(?:async\s*)?\(\)\s*=>\s*(?=[^\s{])(?!\(\)\s*=>)/;
  assert.match('useEffect(() => end.current?.scrollIntoView({ block: "end" }), [n]);', shape);
  assert.match("useLayoutEffect(() => el.focus(), []);", shape, "even one that returns nothing today");
  assert.doesNotMatch("useEffect(() => { el.scrollIntoView(); }, []);", shape);
  assert.doesNotMatch("useEffect(() => () => ctrl.current?.abort(), []);", shape, "a cleanup function is fine");
});
