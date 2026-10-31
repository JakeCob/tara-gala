"use client";

import { useEffect, useRef, useState } from "react";
import { API_URL } from "@/lib/api";
import { flags } from "@/lib/flags";
import { MSG_SKIP_WAITING } from "@/lib/offline";

/** Kill switch (NEXT_PUBLIC_SERVICE_WORKER=false): unregister and drop our caches, saved trips included. */
async function removeServiceWorker() {
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((r) => r.unregister()));
  const names = "caches" in window ? (await caches.keys()).filter((name) => name.startsWith("tg-")) : [];
  await Promise.all(names.map((name) => caches.delete(name)));
  // Runs on every load while the flag is off; only worth a line when it removed something
  if (registrations.length || names.length) {
    console.info("[tg-pwa] kill switch", { registrations: registrations.length, caches: names.length });
  }
}

/** The API origin the service worker may cache, passed in its URL because public/sw.js can't read env vars. */
function apiOrigin(): string | null {
  try {
    return new URL(API_URL).origin;
  } catch {
    return null;
  }
}

/**
 * Registers public/sw.js and shows the "new version" prompt (TG-27, ux.md section 2). A new worker installs and
 * waits; Reload sends it SKIP_WAITING, and the controllerchange that follows reloads this tab once.
 */
export default function ServiceWorkerManager() {
  // "waiting": a new worker is installed; "reload-only": another tab already activated it
  const [prompt, setPrompt] = useState<"none" | "waiting" | "reload-only">("none");
  const [later, setLater] = useState(false);
  const [reloading, setReloading] = useState(false);
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const requested = useRef(false);
  const reloadStarted = useRef(false);

  const reloadOnce = () => {
    if (reloadStarted.current) return;
    reloadStarted.current = true;
    location.reload();
  };

  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      console.info("[tg-pwa] service workers not supported; no offline mode");
      return;
    }
    if (!flags.serviceWorker) {
      removeServiceWorker().catch((err) => console.warn("[tg-pwa] kill switch failed", err instanceof Error ? err.name : err));
      return;
    }
    if (process.env.NODE_ENV !== "production") return;

    const sw = navigator.serviceWorker;
    // No controller yet means this is the first install: its clients.claim() must not prompt
    let hadController = !!sw.controller;
    const api = apiOrigin();

    const onControllerChange = () => {
      console.info("[tg-pwa] controllerchange", { requested: requested.current });
      if (requested.current) reloadOnce();
      else if (hadController) setPrompt("reload-only");
      else hadController = true;
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") registration.current?.update().catch(() => {});
    };

    const register = async () => {
      try {
        const reg = await sw.register("/sw.js?api=" + encodeURIComponent(api ?? ""), { scope: "/", updateViaCache: "none" });
        registration.current = reg;
        console.info("[tg-pwa] registered", { scope: reg.scope, api });
        if (reg.waiting && hadController) {
          console.info("[tg-pwa] update waiting");
          setPrompt("waiting");
        }
        reg.addEventListener("updatefound", () => {
          const incoming = reg.installing;
          incoming?.addEventListener("statechange", () => {
            if (incoming.state === "installed" && sw.controller) {
              console.info("[tg-pwa] update waiting");
              setPrompt("waiting");
            }
          });
        });
      } catch (err) {
        console.warn("[tg-pwa] registration failed", err instanceof Error ? err.name : err);
        return;
      }
      try {
        const persisted = await navigator.storage?.persist?.();
        console.info("[tg-pwa] persist", { persisted });
      } catch (err) {
        console.warn("[tg-pwa] persist failed", err instanceof Error ? err.name : err);
      }
    };

    sw.addEventListener("controllerchange", onControllerChange);
    document.addEventListener("visibilitychange", onVisible);
    if (document.readyState === "complete") void register();
    else window.addEventListener("load", register, { once: true });
    return () => {
      sw.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("load", register);
    };
  }, []);

  const reload = () => {
    setReloading(true);
    requested.current = true;
    const waiting = registration.current?.waiting;
    console.info("[tg-pwa] reload requested", { waiting: !!waiting });
    if (!waiting) return reloadOnce();
    waiting.postMessage({ type: MSG_SKIP_WAITING });
    // If controllerchange never comes, reload anyway
    window.setTimeout(() => {
      if (!reloadStarted.current) console.warn("[tg-pwa] no controllerchange after 3 s; reloading anyway");
      reloadOnce();
    }, 3000);
  };

  const show = prompt !== "none" && !later;
  return (
    <div role="status">
      {show && (
        // pixel-box draws its own hard shadow (TG-49), so the wrapper only positions it
        <div className="fixed inset-x-4 bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-40 mx-auto max-w-md md:bottom-4 lg:left-auto lg:right-8 lg:w-[28rem]">
          <div className="pixel-box bg-card p-4 flex flex-col gap-3 text-sm">
            <p>A new version of Tara Gala is ready.</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setLater(true)}
                className="pixel-btn focus-pixel min-h-11 inline-flex items-center bg-card px-4 text-sm font-semibold text-foreground"
              >
                Later
              </button>
              <button
                type="button"
                onClick={reload}
                disabled={reloading}
                className="pixel-btn focus-pixel min-h-11 bg-brand px-4 font-bold text-brand-ink"
              >
                {reloading ? "Reloading..." : "Reload"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
