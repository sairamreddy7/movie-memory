"use client";

import { useCallback, useEffect, useState } from "react";
import { signOut } from "next-auth/react";

interface DashboardUser {
  name: string;
  email: string;
  image: string | null;
  favoriteMovie: string;
}

interface FactPayload {
  fact: {
    id: string;
    movie: string;
    content: string;
    createdAt: string;
  } | null;
  source: "cache" | "generated" | "stale_fallback" | null;
  cacheAgeSeconds: number;
  warning: string | null;
  error: string | null;
}

export function DashboardClient({ user }: { user: DashboardUser }) {
  const [factState, setFactState] = useState<FactPayload>({
    fact: null,
    source: null,
    cacheAgeSeconds: 0,
    warning: null,
    error: null,
  });
  const [isLoadingFact, setIsLoadingFact] = useState(true);
  const [imgError, setImgError] = useState(false);

  const initials =
    user.name
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "MM";

  const fetchFact = useCallback(async (signal?: AbortSignal) => {
    setIsLoadingFact(true);
    try {
      const response = await fetch("/api/fact", {
        method: "GET",
        cache: "no-store",
        signal,
      });
      const data = await response.json().catch(() => ({}));

      if (signal?.aborted) return;

      if (!response.ok) {
        setFactState((prev) => ({
          ...prev,
          error:
            data.error ||
            "Unable to load a movie fact right now. Please try again.",
        }));
      } else {
        setFactState({
          fact: data.fact,
          source: data.source,
          cacheAgeSeconds: data.cacheAgeSeconds ?? 0,
          warning: data.warning ?? null,
          error: null,
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      setFactState((prev) => ({
        ...prev,
        error: "Network error while contacting the server. Please try again.",
      }));
    } finally {
      if (!signal?.aborted) {
        setIsLoadingFact(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchFact(controller.signal);
    return () => controller.abort();
  }, [fetchFact]);

  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      {/* Header Bar */}
      <header className="flex flex-col justify-between gap-4 rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl sm:flex-row sm:items-center">
        <div className="flex items-center gap-4">
          {user.image && !imgError ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={user.image}
              alt={`${user.name} avatar`}
              onError={() => setImgError(true)}
              referrerPolicy="no-referrer"
              className="h-14 w-14 rounded-full border-2 border-amber-500/40 object-cover"
            />
          ) : (
            <div
              aria-label="User avatar fallback"
              className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-amber-500/40 bg-amber-500/10 text-base font-bold text-amber-300"
            >
              {initials}
            </div>
          )}

          <div>
            <h1 className="text-lg font-bold text-white">{user.name}</h1>
            <p className="text-sm text-slate-400">{user.email}</p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => signOut({ callbackUrl: "/" })}
          className="inline-flex items-center justify-center rounded-xl border border-slate-700 bg-slate-800/80 px-4 py-2.5 text-xs font-semibold text-slate-200 transition hover:border-slate-600 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-amber-400"
        >
          Log out
        </button>
      </header>

      {/* Favorite Movie Card */}
      <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-amber-400">
            Your Favorite Movie
          </span>
          <span className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-400">
            Stored in Postgres
          </span>
        </div>
        <p className="mt-2 text-2xl font-extrabold tracking-tight text-white">
          {user.favoriteMovie}
        </p>
      </section>

      {/* Fun Fact Card (Variant A: 60s Cache + Burst Protection + Fallback) */}
      <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-white">
              AI Movie Fun Fact
            </h2>
            <p className="text-xs text-slate-400">
              Cached for 60 seconds per user &amp; movie with concurrent burst protection
            </p>
          </div>

          <button
            type="button"
            onClick={() => fetchFact()}
            disabled={isLoadingFact}
            className="inline-flex items-center gap-2 rounded-xl bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 shadow-sm transition hover:bg-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoadingFact ? "Loading fact..." : "Refresh Fact"}
          </button>
        </div>

        {/* Status Badges */}
        {factState.source && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {factState.source === "cache" && (
              <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300 ring-1 ring-inset ring-emerald-500/30">
                Served from 60s Cache ({factState.cacheAgeSeconds}s old · fresh fact in{" "}
                {Math.max(0, 60 - factState.cacheAgeSeconds)}s)
              </span>
            )}
            {factState.source === "generated" && (
              <span className="inline-flex items-center rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-300 ring-1 ring-inset ring-amber-500/30">
                Freshly Generated via OpenAI (cached for next 60s)
              </span>
            )}
            {factState.source === "stale_fallback" && (
              <span className="inline-flex items-center rounded-full bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-300 ring-1 ring-inset ring-sky-500/30">
                Fallback to Saved Fact (OpenAI temporarily unavailable)
              </span>
            )}
          </div>
        )}

        {factState.warning && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
            {factState.warning}
          </div>
        )}

        {factState.error && (
          <div
            role="alert"
            className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs font-medium text-rose-300"
          >
            {factState.error}
          </div>
        )}

        {isLoadingFact && !factState.fact ? (
          <div className="mt-4 animate-pulse rounded-xl border border-slate-800 bg-slate-950/60 p-5">
            <div className="h-4 w-3/4 rounded bg-slate-800" />
            <div className="mt-2.5 h-4 w-1/2 rounded bg-slate-800" />
          </div>
        ) : factState.fact ? (
          <blockquote className="mt-4 rounded-xl border border-slate-800 bg-slate-950/80 p-5 text-sm leading-relaxed text-slate-200">
            <p>&ldquo;{factState.fact.content}&rdquo;</p>
            <footer className="mt-3 text-xs text-slate-500">
              Generated at{" "}
              {new Date(factState.fact.createdAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </footer>
          </blockquote>
        ) : null}
      </section>
    </main>
  );
}
