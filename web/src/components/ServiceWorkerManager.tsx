"use client";

import { useEffect, useRef, useState } from "react";
import { API_URL } from "@/lib/api";
import { flags } from "@/lib/flags";
import { MSG_SKIP_WAITING } from "@/lib/offline";

const FOCUS = "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-card";

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
        <div className="fixed inset-x-4 bottom-4 z-20 mx-auto flex max-w-md flex-col gap-3 rounded-2xl border border-border bg-card p-4 text-sm shadow-lg">
          <p>A new version of Tara Gala is ready.</p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setLater(true)}
              className={`min-h-11 inline-flex items-center rounded-xl border border-border bg-card px-4 text-sm font-semibold ${FOCUS}`}
            >
              Later
            </button>
            <button
              type="button"
              onClick={reload}
              disabled={reloading}
              className={`min-h-11 rounded-xl bg-brand px-4 font-semibold text-brand-ink disabled:opacity-60 ${FOCUS}`}
            >
              {reloading ? "Reloading..." : "Reload"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
