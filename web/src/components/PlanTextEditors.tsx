"use client";

// TG-61 ux.md §8: the pick, to-do, budget and sources lists, changed in edit mode inside their own panels. Each save is
// one version of the plan, with its line in the edit bar. Ticks stay where they are.
import { type FormEvent, type ReactNode, useState } from "react";
import { PX, PixelButton, cx } from "@/components/pixel";
import { formatTime } from "@/lib/api";
import type { Guide, GuideDay } from "@/lib/guide";
import { editBudget, editPickOption, editSources, editTodo } from "@/lib/planEdit";
import { PlanProblem } from "./PlanBits";
import type { PlanEditor } from "./PlanEditor";

type Field = { name: string; label: string; max: number; hint?: string; optional?: boolean; prefix?: string; type?: "time"; check?: (v: string) => string | null };
type Values = Record<string, string>;

const MAX_OPTIONS = 6; // the API's pick limits
const MIN_OPTIONS = 2;
const HTTPS = (v: string) => (v && !/^https:\/\/\S+$/.test(v) ? "Use a full link, starting with https://." : null);

/** The fields of one item, with Save and Cancel (or Add), checked before anything is sent. */
function ItemForm({ fields, start, submit, onSubmit, onCancel, off, extra }: {
  fields: Field[];
  start: Values;
  submit: string;
  onSubmit: (v: Values) => Promise<string | null>;
  onCancel?: () => void;
  off: boolean;
  extra?: ReactNode;
}) {
  const [v, setV] = useState(start);
  const [problem, setProblem] = useState("");
  const [saving, setSaving] = useState(false);
  async function go(e: FormEvent) {
    e.preventDefault();
    if (off || saving) return;
    for (const f of fields) {
      const value = (v[f.name] ?? "").trim();
      if (!value && !f.optional) return setProblem(`Fill in ${f.label.toLowerCase()} first.`);
      const bad = f.check?.(value);
      if (bad) return setProblem(bad);
    }
    setProblem("");
    setSaving(true);
    const failed = await onSubmit(Object.fromEntries(fields.map((f) => [f.name, (v[f.name] ?? "").trim()])));
    setSaving(false);
    if (failed) setProblem(failed);
    else if (!onCancel) setV(Object.fromEntries(fields.map((f) => [f.name, ""])));
  }
  return (
    <form onSubmit={go} noValidate className="flex flex-col gap-2">
      {fields.map((f) => (
        <label key={f.name} className="flex flex-col gap-1 text-sm">
          <span className="font-semibold">{f.label}</span>
          {f.hint && <span className={PX.meta}>{f.hint}</span>}
          <span className="flex">
            {f.prefix && <span aria-hidden="true" className={PX.inputPrefix}>{f.prefix}</span>}
            <input type={f.type ?? "text"} className={cx(PX.input, "w-full min-w-0")} value={v[f.name] ?? ""} maxLength={f.max} autoComplete="off"
              onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />
          </span>
        </label>
      ))}
      {problem && <PlanProblem text={problem} />}
      <div className="flex flex-wrap gap-2">
        <PixelButton type="submit" variant={onCancel ? "primary" : "secondary"} aria-disabled={off || saving || undefined}>{saving ? "Saving..." : submit}</PixelButton>
        {onCancel && <PixelButton variant="secondary" onClick={onCancel}>Cancel</PixelButton>}
        {extra}
      </div>
    </form>
  );
}

/** A list whose items each get Edit and ✕, ending with an Add form. */
function ListEdits<T>({ editor, items, fields, read, show, name, addLabel, onSave, onRemove }: {
  editor: PlanEditor;
  items: T[];
  fields: Field[];
  read: (t: T) => Values;
  show: (t: T) => ReactNode;
  name: (t: T) => string;
  addLabel: string;
  onSave: (index: number | null, v: Values) => Promise<string | null>;
  onRemove: (index: number) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [problem, setProblem] = useState("");
  const off = !editor.can;
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {items.map((t, i) => (
          <li key={i} className="flex flex-col gap-2 border-b border-border pb-2 last:border-b-0">
            {editing === i ? (
              <ItemForm fields={fields} start={read(t)} submit="Save" off={off} onCancel={() => setEditing(null)}
                onSubmit={async (v) => {
                  const failed = await onSave(i, v);
                  if (!failed) setEditing(null);
                  return failed;
                }} />
            ) : (
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">{show(t)}</div>
                <PixelButton variant="secondary" aria-disabled={off || undefined} onClick={() => !off && setEditing(i)}>Edit</PixelButton>
                <PixelButton variant="icon" aria-label={`Remove ${name(t)}`} aria-disabled={off || undefined}
                  onClick={async () => !off && setProblem((await onRemove(i)) ?? "")}>
                  <span aria-hidden="true">✕</span>
                </PixelButton>
              </div>
            )}
          </li>
        ))}
      </ul>
      {problem && <PlanProblem text={problem} />}
      <p className="text-sm font-semibold">{addLabel}</p>
      <ItemForm fields={fields} start={{}} submit="Add" off={off} onSubmit={(v) => onSave(null, v)} />
    </div>
  );
}

const failed = async (p: ReturnType<PlanEditor["save"]>) => {
  const out = await p;
  return out.ok || out.ignored ? null : out.message;
};

export function TodoEdits({ editor, guide, show }: { editor: PlanEditor; guide: Guide; show: (t: Guide["todo"][number]) => ReactNode }) {
  return (
    <ListEdits editor={editor} items={guide.todo} name={(t) => t.text} show={show} addLabel="Add a to-do"
      fields={[{ name: "text", label: "To-do", max: 120 }]} read={(t) => ({ text: t.text })}
      onSave={(i, v) => failed(editor.save("plan-todo", (g) => editTodo(g, i === null ? { add: v.text } : { set: guide.todo[i].key, text: v.text }), { kind: "list", what: "todo" }, null))}
      onRemove={(i) => failed(editor.save("plan-todo", (g) => editTodo(g, { remove: guide.todo[i].key }), { kind: "list", what: "todo" }, null))} />
  );
}

export function SourcesEdits({ editor, guide }: { editor: PlanEditor; guide: Guide }) {
  const fields: Field[] = [{ name: "label", label: "Label", max: 120 }, { name: "url", label: "Link", max: 300, optional: true, hint: "Optional.", check: HTTPS }];
  return (
    <ListEdits editor={editor} items={guide.sources} name={(s) => s.label} addLabel="Add a source" fields={fields}
      read={(s) => ({ label: s.label, url: s.url ?? "" })} show={(s) => <span className="text-sm break-words">{s.label}</span>}
      onSave={(i, v) => {
        const source = { label: v.label, url: v.url || null };
        return failed(editor.save("plan-sources", (g) => editSources(g, i === null ? { add: source } : { set: i, source }), { kind: "list", what: "sources" }, null));
      }}
      onRemove={(i) => failed(editor.save("plan-sources", (g) => editSources(g, { remove: i }), { kind: "list", what: "sources" }, null))} />
  );
}

/** One free-text part of the budget (its summary or what it leaves out), with Change. */
function BudgetText({ editor, label, value, part }: { editor: PlanEditor; label: string; value: string; part: "summary" | "excluded" }) {
  const [open, setOpen] = useState(false);
  const off = !editor.can;
  if (!open) {
    return (
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm break-words">{value || <span className="text-muted">No {label.toLowerCase()} yet.</span>}</p>
        <PixelButton variant="secondary" aria-label={`Change the ${label.toLowerCase()}`} aria-disabled={off || undefined} onClick={() => !off && setOpen(true)}>Change</PixelButton>
      </div>
    );
  }
  return (
    <ItemForm fields={[{ name: "text", label, max: 300, optional: true }]} start={{ text: value }} submit="Save" off={off} onCancel={() => setOpen(false)}
      onSubmit={async (v) => {
        const why = await failed(editor.save("plan-budget", (g) => editBudget(g, part === "summary" ? { summary: v.text } : { excluded: v.text }), { kind: "list", what: "budget" }, null));
        if (!why) setOpen(false);
        return why;
      }} />
  );
}

export function BudgetEdits({ editor, guide }: { editor: PlanEditor; guide: Guide }) {
  const fields: Field[] = [
    { name: "item", label: "What it's for", max: 120 },
    { name: "estimate", label: "Estimate per person", max: 40, prefix: "₱", hint: "A number or a range, like 1,500 to 2,200." },
  ];
  return (
    <div className="flex flex-col gap-3">
      <BudgetText editor={editor} label="Summary" value={guide.budget.summary} part="summary" />
      <ListEdits editor={editor} items={guide.budget.rows} name={(r) => r.item} addLabel="Add a line" fields={fields} read={(r) => ({ item: r.item, estimate: r.estimate })}
        show={(r) => <span className="text-sm break-words">{r.item} · <span className="tabular-nums">₱{r.estimate}</span></span>}
        onSave={(i, v) => failed(editor.save("plan-budget", (g) => editBudget(g, i === null ? { add: { item: v.item, estimate: v.estimate } } : { set: i, row: { item: v.item, estimate: v.estimate } }), { kind: "list", what: "budget" }, null))}
        onRemove={(i) => failed(editor.save("plan-budget", (g) => editBudget(g, { remove: i }), { kind: "list", what: "budget" }, null))} />
      <BudgetText editor={editor} label="Not included" value={guide.budget.excluded} part="excluded" />
    </div>
  );
}

/** A day's pick, in edit mode: Change beside each choice, and Add a choice (ux.md §8). */
export function PickEdits({ editor, day, chosen }: { editor: PlanEditor; day: GuideDay; chosen: string | undefined }) {
  const [open, setOpen] = useState<string | "new" | null>(null);
  const [problem, setProblem] = useState("");
  const pick = day.pick!;
  const off = !editor.can;
  const fields: Field[] = [
    { name: "label", label: "Name", max: 120 },
    { name: "leave", label: "Leave at", max: 5, type: "time", check: (v) => (/^\d{2}:\d{2}$/.test(v) ? null : "Pick a time first.") },
    { name: "what", label: "What it is", max: 300, optional: true, hint: "Optional." },
  ];
  const dependants = (id: string) => day.rows.filter((r) => r.show_if?.pick === pick.key && r.show_if.is === id).length + day.rows.filter((r) => r.hide_if?.pick === pick.key && r.hide_if.is === id).length;
  const save = (op: Parameters<typeof editPickOption>[2]) => failed(editor.save("plan-pick", (g) => editPickOption(g, day.day, op), { kind: "list", what: "pick" }, null));

  async function onRemove(id: string) {
    if (off) return;
    if (chosen === id) return setProblem(`The group picked ${id}. Unpick it first.`);
    if (pick.options.length <= MIN_OPTIONS) return setProblem("A pick needs at least two choices.");
    const n = dependants(id);
    const ask = n ? `Remove choice ${id}? Its ${n} stop${n === 1 ? "" : "s"} will show whatever the group picks.` : `Remove choice ${id}?`;
    if (!window.confirm(ask)) {
      console.info("[tg-trip] plan pick remove declined");
      return;
    }
    const why = await save({ remove: id });
    setProblem(why ?? "");
    if (!why) setOpen(null);
  }

  return (
    <div className="flex flex-col gap-2">
      {pick.options.map((o) =>
        open === o.id ? (
          <div key={o.id} className="flex flex-col gap-2">
            {dependants(o.id) > 0 && <p className={PX.meta}>{dependants(o.id)} stop{dependants(o.id) === 1 ? "" : "s"} show only if the group picks {o.id}.</p>}
            <ItemForm fields={fields} start={{ label: o.label, leave: o.leave, what: o.what }} submit="Save" off={off} onCancel={() => setOpen(null)}
              extra={<PixelButton variant="secondary" aria-disabled={off || undefined} onClick={() => onRemove(o.id)}>Remove choice {o.id}</PixelButton>}
              onSubmit={async (v) => {
                const why = await save({ set: o.id, option: { label: v.label, leave: v.leave, what: v.what } });
                if (!why) setOpen(null);
                return why;
              }} />
          </div>
        ) : (
          <div key={o.id} className="flex items-center justify-between gap-2">
            <span className="min-w-0 text-sm break-words">{o.id}. {o.label} · leave {formatTime(o.leave)}</span>
            <PixelButton variant="secondary" aria-label={`Change choice ${o.id}`} aria-disabled={off || undefined} onClick={() => !off && setOpen(o.id)}>Change</PixelButton>
          </div>
        ),
      )}
      {problem && <PlanProblem text={problem} />}
      {pick.options.length < MAX_OPTIONS &&
        (open === "new" ? (
          <ItemForm fields={fields} start={{}} submit="Add" off={off} onCancel={() => setOpen(null)}
            onSubmit={async (v) => {
              const why = await save({ add: { label: v.label, leave: v.leave, what: v.what } });
              if (!why) setOpen(null);
              return why;
            }} />
        ) : (
          <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm" aria-disabled={off || undefined} onClick={() => !off && setOpen("new")}>Add a choice</PixelButton>
        ))}
    </div>
  );
}
