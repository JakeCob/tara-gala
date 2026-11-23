"use client";

// TG-75 the game-style Ask Kaloy chat (flags.chatGameUi, owner 2026-11-23: the chat "looks like a plain form"). Kaloy's
// lines are pixel speech bubbles with a stepped tail to his sprite, yours are Flag Yellow bubbles on the right, and the
// composer is one text-entry row. PlanChat keeps the log, the sends, Apply and focus; this file only draws them, so
// every state of today's chat is here: the greeting, thinking, a proposal with Apply and Not this, the paste-a-link ask,
// limits, no signal, no fit, a clash with Ask again, Clear this chat and the saving line.
import { type FormEvent, type ReactNode, type RefObject, useEffect } from "react";
import { MenuCursor, PX, PixelBox, PixelButton, SectionTitle, cx } from "@/components/pixel";
import { APPLIED, MAX_TEXT, NOT_APPLIED, NO_FIT, chatFailureLines, needLinkLine, type Entry, type NeedLink } from "@/lib/chat";
import { KALOY_CHAT, KALOY_WORDS, type KaloyPose, alertPose, replyPose } from "@/lib/kaloy";
import { KaloyGreeting, KaloySprite } from "./Kaloy";
import { ChangeList, SaidText } from "./PlanBits";
import type { PlanEditor } from "./PlanEditor";

/** The bubble's stepped tail in 3px cells, like its frame: out to Kaloy (left) or to you (right). Its last column covers
 * the bubble's own border, so the two read as one shape. Paint only */
function Tail({ side }: { side: "kaloy" | "you" }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 7 6" width="21" height="18" shapeRendering="crispEdges"
      className={cx("absolute -top-[3px]", side === "kaloy" ? "-left-[21px] fill-card" : "-right-[21px] -scale-x-100 fill-accent")}>
      <path className="fill-frame" d="M0 0h7v1H0zM1 1h1v1H1zM2 2h1v1H2zM3 3h1v1H3zM4 4h1v1H4zM5 5h1v1H5z" />
      <path d="M2 1h5v1H2zM3 2h4v1H3zM4 3h3v1H4zM5 4h2v1H5zM6 5h1v1H6z" />
    </svg>
  );
}

/** One of Kaloy's lines: his sprite, then a bubble with his name, so who is talking is said in words too */
function KaloySays({ pose, children }: { pose: KaloyPose; children: ReactNode }) {
  return (
    <div className="flex items-start gap-5 self-start pr-2">
      <KaloySprite pose={pose} />
      <div className="pixel-frame relative flex min-w-0 flex-col gap-2 bg-card px-3 py-2">
        <Tail side="kaloy" />
        <p className={cx(PX.meta, "font-bold")}>{KALOY_WORDS.name}</p>
        {children}
      </div>
    </div>
  );
}

/** The chat's one alert box (ux.md §10: each state in an alertText box): limits, no signal, no fit, a clash. Kaloy sits
 * by it, sad while it's the newest line */
function ChatAlert({ lines, pose }: { lines: string[]; pose: KaloyPose }) {
  return (
    <div className="flex items-start gap-5 self-start pr-2">
      <KaloySprite pose={pose} />
      <PixelBox tone="alertText" className="flex min-w-0 flex-col gap-1 p-3 text-sm">
        {lines.map((line, j) => <p key={j}>{line}</p>)}
      </PixelBox>
    </div>
  );
}

type Props = {
  dialogRef: RefObject<HTMLDialogElement | null>;
  endRef: RefObject<HTMLDivElement | null>;
  fieldId: string;
  log: Entry[];
  draft: string;
  onDraft: (text: string) => void;
  online: boolean;
  sending: boolean;
  applying: boolean;
  /** An open proposal is held: its Apply and Not this show, and Send gives way to Apply */
  holding: boolean;
  off: boolean;
  waiting: boolean;
  status: PlanEditor["status"];
  cheer: boolean;
  lastAsked: string | null;
  lastApplied: number;
  newestBot: number;
  onClose: () => void;
  onSend: (text: string, again?: boolean) => void;
  onApply: () => void;
  onNotThis: () => void;
  onClear: () => void;
  onNeedLink: (need: NeedLink) => void;
};

/** The refs stay out of `p`, so reading the rest of the props in render never reads a ref (react-hooks/refs) */
export default function KaloyChat({ dialogRef, endRef, ...p }: Props) {
  const { log, sending, applying, online } = p;
  useEffect(() => {
    console.info("[tg-kaloy] chat ui=game"); // once per chat open, so a log shows which chat someone saw
  }, []);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    p.onSend(p.draft);
  }

  /** Under a reply: the paste-a-link ask and the proposed change, inside his bubble */
  function extras(e: Extract<Entry, { kind: "bot" }>, i: number) {
    return (
      <>
        {e.needLink && (
          <>
            <p className="text-sm break-words">{needLinkLine(e.needLink.name)}</p>
            <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm"
              onClick={() => {
                const at = e.needLink!.at;
                console.info("[tg-trip] chat pin-ask open at=%s", at ? Object.keys(at)[0] : "none");
                p.onNeedLink(e.needLink!);
              }}>
              Paste a Google Maps link
            </PixelButton>
          </>
        )}
        {e.changes && e.proposal && (
          <div className="pixel-frame flex flex-col gap-2 bg-background p-2">
            <p className="text-sm font-semibold">Proposed change</p>
            <ChangeList lines={e.changes} />
            {e.proposal === "open" && p.holding ? (
              <div className="flex flex-wrap gap-2">
                <PixelButton variant="primary" className="px-4 py-2" aria-disabled={p.off || undefined} onClick={p.onApply}>
                  {applying ? "Applying..." : "Apply"}
                </PixelButton>
                <PixelButton variant="secondary" className="inline-flex items-center px-4 text-sm" aria-disabled={applying || undefined}
                  onClick={() => !applying && p.onNotThis()}>
                  Not this
                </PixelButton>
              </div>
            ) : e.proposal === "applied" ? (
              <p tabIndex={-1} className={PX.meta} data-chat-focus={i === p.lastApplied ? "applied" : undefined}>{APPLIED}</p>
            ) : (
              <p className={PX.meta}>{NOT_APPLIED}</p>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <dialog ref={dialogRef} aria-label={KALOY_WORDS.ask} onClose={(e) => e.target === e.currentTarget && p.onClose()}
      onClick={(e) => e.target === e.currentTarget && e.currentTarget.close()}
      className="m-auto h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100%-2rem))] bg-transparent p-0 text-foreground backdrop:bg-screen-ink/60">
      <div className="pixel-box flex h-full flex-col bg-background text-foreground">
        <div className="flex items-center justify-between gap-3 border-b-3 border-frame bg-card px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className={PX.plate}><KaloySprite pose="idle" /></span>
            <SectionTitle>{KALOY_WORDS.ask}</SectionTitle>
          </div>
          <PixelButton variant="secondary" onClick={() => dialogRef.current?.close()}>Close</PixelButton>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
          {log.length > 0 && (
            <PixelButton variant="secondary" className="inline-flex items-center self-center px-4 text-sm" onClick={p.onClear}>Clear this chat</PixelButton>
          )}
          <div role="log" aria-live="polite" className="flex flex-col gap-4">
            {log.length === 0 && (
              // The greeting is drawn here only, never logged or sent (TG-75)
              <KaloySays pose="talk">
                <KaloyGreeting />
                <p className="text-sm break-words">{KALOY_WORDS.howTo}</p>
              </KaloySays>
            )}
            {log.map((e, i) =>
              e.kind === "user" ? (
                <p key={i} className="pixel-frame relative mr-6 max-w-[85%] self-end bg-accent px-3 py-2 text-sm text-accent-ink break-words whitespace-pre-line">
                  <Tail side="you" />
                  <span className="sr-only">{KALOY_CHAT.you} </span>
                  {e.text}
                </p>
              ) : e.kind === "alert" ? (
                <div key={i} className="flex flex-col gap-2">
                  <ChatAlert lines={e.text.split("\n")} pose={alertPose({ newest: i === log.length - 1, sending })} />
                  {e.again && i === log.length - 1 && p.lastAsked && (
                    <PixelButton variant="secondary" className="ml-13 inline-flex items-center self-start px-4 text-sm" aria-disabled={!online || sending || undefined}
                      data-chat-focus="again" onClick={() => p.onSend(p.lastAsked!, true)}>
                      Ask again
                    </PixelButton>
                  )}
                </div>
              ) : e.noFit ? (
                // no_fit's reply is the fixed NO_FIT sentence (the API's contract): said once, as the state it is
                <div key={i} className="flex flex-col gap-4">
                  <ChatAlert lines={[e.text || NO_FIT]} pose={alertPose({ newest: i === log.length - 1, sending })} />
                  {(e.needLink || (e.changes && e.proposal)) && <KaloySays pose="idle">{extras(e, i)}</KaloySays>}
                </div>
              ) : (
                <KaloySays key={i} pose={replyPose({ index: i, newest: p.newestBot, sending, cheer: p.cheer })}>
                  <p className="text-sm break-words whitespace-pre-line">{e.text}</p>
                  {extras(e, i)}
                </KaloySays>
              ),
            )}
            {sending && (
              <KaloySays pose="think">
                <p className="text-sm">{KALOY_WORDS.thinking}</p>
              </KaloySays>
            )}
            {!online && <ChatAlert lines={chatFailureLines({ why: "offline" }) ?? []} pose="sad" />}
          </div>
          {/* ux.md §3.3: the edit bar is under this dialog's backdrop, so a chat Apply's waiting lines show here */}
          <p role="status" aria-live="polite" className={cx(PX.meta, "empty:sr-only")}>{p.waiting ? <SaidText said={p.status} /> : ""}</p>
          <div ref={endRef} />
        </div>

        <form className="flex flex-col gap-2 border-t-3 border-frame bg-card px-3 pt-3 pb-2" onSubmit={onSubmit}>
          <label htmlFor={p.fieldId} className="sr-only">Message</label>
          <div className="flex items-end gap-2">
            <textarea id={p.fieldId} className={cx(PX.input, "max-h-32 min-w-0 flex-1 resize-none [field-sizing:content]")} rows={1} maxLength={MAX_TEXT}
              placeholder={KALOY_CHAT.placeholder} value={p.draft}
              onChange={(e) => p.onDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  p.onSend(p.draft);
                }
              }} />
            {/* One Red button (UX review S3): while the newest proposal has Apply, Send gives way */}
            <PixelButton type="submit" variant={p.holding ? "secondary" : "primary"} className="inline-flex shrink-0 items-center gap-2 px-3 py-2"
              aria-disabled={!online || sending || undefined}>
              {/* the cursor gives way to the longer word, so the field keeps its width on a 320px phone */}
              {!sending && <MenuCursor className="h-3 w-3 shrink-0" />}
              {sending ? "Sending..." : "Send"}
            </PixelButton>
          </div>
          <p className={PX.meta}>{KALOY_CHAT.privacy}</p>
        </form>
      </div>
    </dialog>
  );
}
