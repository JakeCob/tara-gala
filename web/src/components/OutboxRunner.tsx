"use client";

import { useEffect } from "react";
import { outbox } from "@/lib/outboxStore";
import { OUTBOX_EVENT, OUTBOX_KICK, outboxRunner } from "@/lib/outboxRunner";
import { walletApi } from "@/lib/wallet";

/**
 * TG-70 O3 (plan §3 O3): sends the expenses saved here with no signal, from any open page. A page opening, `online` and
 * the tab becoming visible send every waiting row (S1); a timer re-arms for the next one while any wait. It never reads
 * the flag (B24). Renders nothing; the open wallet hears each send through the `tg-outbox` window event.
 */
export default function OutboxRunner() {
  useEffect(() => {
    const runner = outboxRunner({
      store: outbox,
      send: walletApi.addExpense,
      onLine: () => navigator.onLine,
      now: Date.now,
      dispatch: (e) => window.dispatchEvent(new CustomEvent(OUTBOX_EVENT, { detail: e })),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    async function go(trigger: boolean) {
      clearTimeout(timer);
      const next = await runner.run(trigger);
      if (!stopped && next !== null) timer = setTimeout(() => void go(false), next);
    }
    const onOnline = () => void go(true);
    const onVisible = () => {
      if (document.visibilityState === "visible") void go(true);
    };
    const onKick = () => void go(false);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(OUTBOX_KICK, onKick);
    void go(true);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(OUTBOX_KICK, onKick);
    };
  }, []);
  return null;
}
