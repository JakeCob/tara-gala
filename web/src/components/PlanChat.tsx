"use client";

// TG-61 PR 2: Ask the chatbot (ux.md §10). A native dialog with a log kept only on this phone, a composer, and the
// chatbot's proposals, which change nothing until someone taps Apply. Apply is the page's own save (planWrite), so it
// waits for the newest plan like every other save (ux.md §3.3); the page asks the server, this dialog never does.
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { PX, PixelBox, PixelButton, cx } from "@/components/pixel";
import {
  APPLIED, APPLY_CLASH, CLEAR_CONFIRM, FIRST_MESSAGE, NOT_APPLIED, NO_FIT, PRIVACY_LINE, THINKING,
  type ChatProposal, type Entry, type NeedLink, MAX_TEXT,
  addEntry, chatFailureLines, chatStorage, clearLog, loadLog, needLinkLine, saveLog, settle,
} from "@/lib/chat";
import { planFailureMessage } from "@/lib/trip";
import { ChangeList, SaidText } from "./PlanBits";
import type { ChatTools, PlanEditor } from "./PlanEditor";

export default function PlanChat({ editor, chat, ask, onClose, onNeedLink }: {
  editor: PlanEditor;
  chat: ChatTools;
  /** Opened from a proposal: this message is sent at once, about this stop (ux.md §4.4) */
  ask: { text: string; focus: string | null } | null;
  onClose: () => void;
  /** Paste a Google Maps link: the chat closes and the find step opens at the chatbot's position, if it named one */
  onNeedLink: (need: NeedLink) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const fieldId = useId();
  const [log, setLog] = useState<Entry[]>(() => loadLog(chatStorage(), chat.slug));
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false); // a second tap in the same tick sees it
  const [applying, setApplying] = useState(false);
  const [proposal, setProposal] = useState<ChatProposal | null>(null); // the open proposal's plan: in memory only, never stored
  const focus = ask?.focus ?? null; // the stop this chat was opened about, if any
  const online = editor.online;
  const off = !editor.can || applying || !proposal;
  const waiting = applying || (!!proposal && !editor.can && online);

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);
  useEffect(() => {
    if (!saveLog(chatStorage(), chat.slug, log)) console.info("[tg-trip] chat store kept=page"); // the log lasts as long as the page
  }, [log, chat.slug]);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [log.length, sending]);

  async function send(text: string, again = false) {
    const words = text.trim().slice(0, MAX_TEXT);
    if (!words || sendingRef.current || !online) return;
    // Ask again resends the last question as the newest turn, without writing it twice
    const before = log; // this render's log: send is made anew each render
    const last = before.findLastIndex((e) => e.kind === "user");
    const history = again && last >= 0 ? before.slice(0, last) : before;
    sendingRef.current = true;
    setSending(true);
    if (!again) {
      setLog((l) => addEntry(l, { kind: "user", text: words }));
      setDraft("");
    }
    const turns = Math.min(history.length + 1, 10);
    console.info("[tg-trip] chat send turns=%d focus=%s again=%s", turns, focus ? "yes" : "no", again ? "yes" : "no");
    const r = await chat.send(history, words, focus);
    sendingRef.current = false;
    setSending(false);
    if (!r.ok) {
      console.info("[tg-trip] chat answer ok=%s", r.why);
      const lines = chatFailureLines(r) ?? [planFailureMessage({ why: r.why === "busy" || r.why === "cap" || r.why === "off" ? "server" : r.why })];
      return setLog((l) => addEntry(l, { kind: "alert", text: lines.join("\n"), again: r.why === "clash" }));
    }
    const out = r.body;
    const rows = out.proposal?.changes.length ?? 0;
    const pinAsk = out.need_link ? "yes" : "no";
    console.info("[tg-trip] chat answer ok=yes outcome=%s rows=%d pin_ask=%s", out.outcome, rows, pinAsk);
    setProposal(out.proposal);
    setLog((l) => addEntry(l, {
      kind: "bot",
      text: out.reply,
      ...(out.proposal ? { changes: out.proposal.changes, proposal: "open" as const } : {}),
      ...(out.need_link ? { needLink: out.need_link } : {}),
      ...(out.outcome === "no_fit" ? { noFit: true } : {}),
    }));
  }

  // Opened from a proposal: send its message once
  const asked = useRef(false);
  useEffect(() => {
    if (!ask || asked.current) return;
    asked.current = true;
    void send(ask.text);
  });

  async function onApply() {
    if (off || !proposal) return;
    setApplying(true);
    const out = await chat.apply(proposal);
    setApplying(false);
    console.info("[tg-trip] chat apply ok=%s", out.ok ? "yes" : out.ignored ? "ignored" : out.clash ? "clash" : "no");
    if (out.ok) {
      setProposal(null);
      return setLog((l) => settle(l, "applied"));
    }
    if (out.ignored) return; // a tap while the newest plan isn't on screen yet: nothing was sent
    if (out.clash) {
      setProposal(null);
      return setLog((l) => addEntry(l.map((e) => (e.kind === "bot" && e.proposal === "open" ? { ...e, proposal: "lapsed" as const } : e)), { kind: "alert", text: APPLY_CLASH.join("\n"), again: true }));
    }
    setLog((l) => addEntry(l, { kind: "alert", text: out.message })); // the proposal keeps its buttons, to try again
  }

  function onNotThis() {
    console.info("[tg-trip] chat decline");
    setProposal(null);
    setLog((l) => settle(l, "declined"));
  }

  function onClear() {
    if (!window.confirm(CLEAR_CONFIRM)) return;
    console.info("[tg-trip] chat clear");
    clearLog(chatStorage(), chat.slug);
    setProposal(null);
    setLog([]);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(draft);
  }

  const lastAsked = [...log].reverse().find((e) => e.kind === "user")?.text ?? null;
  return (
    <dialog ref={dialog} aria-label="Ask the chatbot" onClose={(e) => e.target === e.currentTarget && onClose()}
      onClick={(e) => e.target === e.currentTarget && e.currentTarget.close()}
      className="m-auto h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100%-2rem))] bg-transparent p-0 text-foreground backdrop:bg-screen-ink/60">
      <div className="pixel-box flex h-full flex-col gap-3 bg-card p-4 text-foreground">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-bold">Ask the chatbot</p>
          <PixelButton variant="secondary" onClick={() => dialog.current?.close()}>Close</PixelButton>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {log.length > 0 && (
            <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm" onClick={onClear}>Clear this chat</PixelButton>
          )}
          <div role="log" aria-live="polite" className="flex flex-col gap-3">
            {log.length === 0 && (
              <div className="flex flex-col gap-1 self-start">
                <p className={PX.meta}>Chatbot</p>
                <p className="text-sm break-words">{FIRST_MESSAGE}</p>
              </div>
            )}
            {log.map((e, i) =>
              e.kind === "user" ? (
                <p key={i} className="pixel-frame self-end max-w-[85%] bg-card px-3 py-2 text-sm break-words whitespace-pre-line">{e.text}</p>
              ) : e.kind === "alert" ? (
                <div key={i} className="flex flex-col gap-2">
                  <PixelBox tone="alertText" className="flex flex-col gap-1 p-3 text-sm">
                    {e.text.split("\n").map((t, j) => <p key={j}>{t}</p>)}
                  </PixelBox>
                  {e.again && i === log.length - 1 && lastAsked && (
                    <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm" aria-disabled={!online || sending || undefined}
                      onClick={() => void send(lastAsked, true)}>
                      Ask again
                    </PixelButton>
                  )}
                </div>
              ) : (
                <div key={i} className="flex flex-col gap-2 self-start">
                  <p className={PX.meta}>Chatbot</p>
                  <p className="text-sm break-words whitespace-pre-line">{e.text}</p>
                  {e.noFit && (
                    <PixelBox tone="alertText" className="p-3 text-sm">
                      <p>{NO_FIT}</p>
                    </PixelBox>
                  )}
                  {e.needLink && (
                    <>
                      <p className="text-sm break-words">{needLinkLine(e.needLink.name)}</p>
                      <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm"
                        onClick={() => {
                          const at = e.needLink!.at;
                          console.info("[tg-trip] chat pin-ask open at=%s", at ? Object.keys(at)[0] : "none");
                          onNeedLink(e.needLink!);
                        }}>
                        Paste a Google Maps link
                      </PixelButton>
                    </>
                  )}
                  {e.changes && e.proposal && (
                    <PixelBox className="flex flex-col gap-2 p-3">
                      <p className="text-sm font-semibold">Proposed change</p>
                      <ChangeList lines={e.changes} />
                      {e.proposal === "open" && proposal ? (
                        <div className="flex flex-wrap gap-2">
                          <PixelButton variant="primary" className="px-4 py-2" aria-disabled={off || undefined} onClick={onApply}>
                            {applying ? "Applying..." : "Apply"}
                          </PixelButton>
                          <PixelButton variant="secondary" className="inline-flex items-center px-4 text-sm" aria-disabled={applying || undefined}
                            onClick={() => !applying && onNotThis()}>
                            Not this
                          </PixelButton>
                        </div>
                      ) : e.proposal === "applied" ? (
                        <p className={PX.meta}>{APPLIED}</p>
                      ) : (
                        <p className={PX.meta}>{NOT_APPLIED}</p>
                      )}
                    </PixelBox>
                  )}
                </div>
              ),
            )}
            {sending && <p className={PX.meta}>{THINKING}</p>}
            {!online && (
              <PixelBox tone="alertText" className="p-3 text-sm">
                <p>{chatFailureLines({ why: "offline" })}</p>
              </PixelBox>
            )}
          </div>
          {/* ux.md §3.3: the edit bar is under this dialog's backdrop, so a chat Apply's waiting lines show here */}
          <p role="status" aria-live="polite" className={cx(PX.meta, "empty:sr-only")}>{waiting ? <SaidText said={editor.status} /> : ""}</p>
          <div ref={end} />
        </div>

        <form className="flex flex-col gap-2" onSubmit={onSubmit}>
          <label htmlFor={fieldId} className="text-sm font-semibold">Message</label>
          <textarea id={fieldId} className={cx(PX.input, "min-h-16 resize-none")} rows={2} maxLength={MAX_TEXT} value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(draft);
              }
            }} />
          <PixelButton type="submit" variant="primary" className="px-4 py-2" aria-disabled={!online || sending || undefined}>
            {sending ? "Sending..." : "Send"}
          </PixelButton>
          <p className={PX.meta}>{PRIVACY_LINE}</p>
        </form>
      </div>
    </dialog>
  );
}
