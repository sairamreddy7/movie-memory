"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { MOVIE_TITLE_MAX_LENGTH } from "@/lib/validation";

export function OnboardingForm() {
  const router = useRouter();
  const [movie, setMovie] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const trimmed = movie.trim();
    if (!trimmed) {
      setError("Please enter a movie title.");
      return;
    }

    if (trimmed.length > MOVIE_TITLE_MAX_LENGTH) {
      setError(`Movie title must be ${MOVIE_TITLE_MAX_LENGTH} characters or fewer.`);
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ favoriteMovie: trimmed }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload.error || "Could not save your favorite movie.");
        setIsSubmitting(false);
        return;
      }

      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Network error while saving your movie. Please try again.");
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <div>
        <label
          htmlFor="favoriteMovie"
          className="block text-xs font-semibold uppercase tracking-wider text-slate-300"
        >
          Favorite Movie Title
        </label>
        <input
          id="favoriteMovie"
          name="favoriteMovie"
          type="text"
          required
          maxLength={MOVIE_TITLE_MAX_LENGTH}
          placeholder="e.g., Interstellar (2014)"
          value={movie}
          onChange={(e) => setMovie(e.target.value)}
          disabled={isSubmitting}
          className="mt-2 block w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-white placeholder-slate-500 shadow-inner focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400 disabled:opacity-60"
        />
        <div className="mt-1.5 flex justify-between text-xs text-slate-500">
          <span>Required (1–{MOVIE_TITLE_MAX_LENGTH} characters)</span>
          <span>
            {movie.trim().length}/{MOVIE_TITLE_MAX_LENGTH}
          </span>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs font-medium text-rose-300"
        >
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={isSubmitting}
        className="flex w-full items-center justify-center rounded-xl bg-amber-500 px-4 py-3 text-sm font-semibold text-slate-950 shadow-sm transition hover:bg-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:ring-offset-2 focus:ring-offset-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSubmitting ? "Saving your favorite movie..." : "Continue to Dashboard"}
      </button>
    </form>
  );
}
