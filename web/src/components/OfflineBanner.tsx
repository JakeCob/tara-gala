"use client";

import { usePathname } from "next/navigation";
import { useEffect, useReducer } from "react";
import { bannerReducer, bannerText, bannerVariant, initialBanner, parseSwMessage } from "@/lib/offline";

/**
 * Offline/stale banner (TG-27, ux.md section 1). It follows the service worker's "this answer came from the
 * cache" messages, not just navigator.onLine, which says true on a dead mobile connection. No close button:
 * a stale warning stays while stale data is on screen.
 */
export default function OfflineBanner() {
  // First paint as if online, so the banner never appears before a response
  const [state, dispatch] = useReducer(bannerReducer, true, initialBanner);
  const pathname = usePathname();

  // Mount and route change: start over for the new screen
  useEffect(() => {
    dispatch({ type: "reset", online: navigator.onLine });
  }, [pathname]);

  useEffect(() => {
    const online = () => dispatch({ type: "online" });
    const offline = () => dispatch({ type: "offline" });
    const onMessage = (event: MessageEvent) => {
      const msg = parseSwMessage(event.data);
      if (msg) dispatch({ type: "data", source: msg.source, savedAt: msg.savedAt, url: msg.url });
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    const sw = "serviceWorker" in navigator ? navigator.serviceWorker : null;
    sw?.addEventListener("message", onMessage);
    sw?.startMessages();
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      sw?.removeEventListener("message", onMessage);
    };
  }, []);

  const variant = bannerVariant(state);
  const text = variant ? bannerText(variant, state.savedAt) : null;

  // Always rendered so screen readers announce the change once (polite)
  return (
    <div role="status" className="sticky top-0 z-10 w-full">
      {text && (
        <div className="bg-accent text-accent-ink border-b-3 border-frame">
          <p className="mx-auto w-full max-w-md px-4 py-2 text-sm leading-snug md:max-w-3xl md:px-6 lg:max-w-5xl lg:px-8 xl:max-w-6xl">
            <span className="font-bold">{text.lead}</span>
            {text.rest}
          </p>
        </div>
      )}
    </div>
  );
}
