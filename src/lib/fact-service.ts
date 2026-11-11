/**
 * Variant A — Backend-Focused Fact Service
 *
 * Implements:
 * 1. Strict session user authentication check
 * 2. 60-Second Cache Window per (userId, movie) using database clock timestamps (`ageMs >= 0 && ageMs < 60_000`)
 * 3. Two-Tier Burst / Idempotency Protection:
 *    - Tier 1 (In-Process Singleflight): Coalesces concurrent requests within the same Node process
 *    - Tier 2 (Postgres Atomic Lease Lock with Compare-and-Clear):
 *      - Acquires a 20-second lease (`LOCK_LEASE_MS = 20_000`, well above OpenAI's 8s `maxRetries: 0` ceiling)
 *        tagged with a unique `lockToken` (`factLockId`).
 *      - Releases the lock in `finally` ONLY if `factLockId === lockToken` (compare-and-clear),
 *        so an expired worker can never clear another worker's active lock.
 *      - If `acquireGenerationLock` returns `false`, waits up to `LOCK_MAX_WAIT_MS` (10s) for the lock
 *        holder to persist a fresh fact. If the wait times out, it NEVER falls through to call OpenAI
 *        without the lock—instead it returns the stale cached fact or throws `FactGenerationError` (503).
 * 4. Resilient OpenAI Failure Handling & Server Error Logging:
 *    - Logs generation/persistence errors via injectable logger
 *    - Falls back to the most recent cached fact for (userId, movie) if OpenAI times out or errors
 *    - Returns a clean, user-friendly error message when no prior cached fact exists
 */

import { randomUUID } from "crypto";

export const CACHE_WINDOW_MS = 60 * 1000;      // 60 seconds cache TTL
export const LOCK_LEASE_MS = 20 * 1000;        // 20 seconds lease (>2x OpenAI's 8s maxRetries:0 timeout)
export const LOCK_POLL_INTERVAL_MS = 150;      // 150ms poll interval when waiting on another instance
export const LOCK_MAX_WAIT_MS = 10 * 1000;     // 10 seconds max wait (> OpenAI's 8s timeout)

export class UnauthenticatedError extends Error {
  public readonly statusCode = 401;
  constructor(message = "Unauthorized: Please sign in with Google to view movie facts.") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

export class OnboardingRequiredError extends Error {
  public readonly statusCode = 400;
  constructor(message = "Onboarding required: Please set your favorite movie first.") {
    super(message);
    this.name = "OnboardingRequiredError";
  }
}

export class FactGenerationError extends Error {
  public readonly statusCode = 503;
  constructor(
    message = "We couldn't generate a new movie fact right now. Please try again in a moment."
  ) {
    super(message);
    this.name = "FactGenerationError";
  }
}

export interface MovieFactRecord {
  id: string;
  userId: string;
  movie: string;
  content: string;
  createdAt: Date;
}

export interface LatestFactLookup {
  fact: MovieFactRecord;
  ageMs: number; // Computed using Postgres NOW() - createdAt on TIMESTAMPTZ(3)
}

export interface FactResult {
  fact: MovieFactRecord;
  source: "cache" | "generated" | "stale_fallback";
  cacheAgeSeconds: number;
  warning?: string;
}

export interface FactRepository {
  getUserById(userId: string): Promise<{
    id: string;
    favoriteMovie: string | null;
  } | null>;
  getLatestFact(userId: string, movie: string): Promise<LatestFactLookup | null>;
  createFact(userId: string, movie: string, content: string): Promise<MovieFactRecord>;
  acquireGenerationLock(userId: string, lockToken: string, leaseMs: number): Promise<boolean>;
  releaseGenerationLock(userId: string, lockToken: string): Promise<boolean>;
}

export interface FactGenerator {
  generateFunFact(movie: string): Promise<string>;
}

export interface FactLogger {
  error(message: string, error?: unknown): void;
  warn(message: string, error?: unknown): void;
}

export interface GetOrGenerateFactParams {
  sessionUserId: string | null | undefined;
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
  pollIntervalMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const defaultLogger: FactLogger = {
  error: (msg, err) => console.error(msg, err),
  warn: (msg, err) => console.warn(msg, err),
};

/**
 * Service encapsulating Variant A's 60-second caching, two-tier burst/idempotency protection,
 * user isolation, and OpenAI failure fallback.
 */
export class MovieFactService {
  // Tier 1: In-memory singleflight map keyed by `${userId}:${movie}`
  private readonly inFlightRequests = new Map<string, Promise<FactResult>>();

  constructor(
    private readonly repo: FactRepository,
    private readonly generator: FactGenerator,
    private readonly logger: FactLogger = defaultLogger
  ) {}

  /**
   * Fetches a cached or newly generated movie fact for the authenticated session user.
   */
  async getFactForUser(params: GetOrGenerateFactParams): Promise<FactResult> {
    const {
      sessionUserId,
      sleep = defaultSleep,
      maxWaitMs = LOCK_MAX_WAIT_MS,
      pollIntervalMs = LOCK_POLL_INTERVAL_MS,
    } = params;

    // 1. Authentication check
    if (!sessionUserId || typeof sessionUserId !== "string" || !sessionUserId.trim()) {
      throw new UnauthenticatedError();
    }

    // 2. Load user record and verify onboarding completion
    const user = await this.repo.getUserById(sessionUserId);
    if (!user) {
      throw new UnauthenticatedError("User account not found.");
    }

    const movie = user.favoriteMovie?.trim();
    if (!movie) {
      throw new OnboardingRequiredError();
    }

    // 3. Fast-path check: Is the most recent fact for (userId, movie) < 60 seconds old?
    const latestLookup = await this.repo.getLatestFact(sessionUserId, movie);
    if (latestLookup && this.isWithinCacheWindow(latestLookup.ageMs)) {
      return {
        fact: latestLookup.fact,
        source: "cache",
        cacheAgeSeconds: this.calculateAgeSeconds(latestLookup.ageMs),
      };
    }

    // 4. Tier 1 Burst Protection: In-process singleflight coalescing
    const singleflightKey = `${sessionUserId}:${movie}`;
    const existingPromise = this.inFlightRequests.get(singleflightKey);
    if (existingPromise) {
      return existingPromise;
    }

    const generationPromise = this.executeWithLockAndFallback({
      userId: sessionUserId,
      movie,
      priorCachedLookup: latestLookup,
      sleep,
      maxWaitMs,
      pollIntervalMs,
    });

    this.inFlightRequests.set(singleflightKey, generationPromise);
    try {
      return await generationPromise;
    } finally {
      this.inFlightRequests.delete(singleflightKey);
    }
  }

  private async executeWithLockAndFallback(options: {
    userId: string;
    movie: string;
    priorCachedLookup: LatestFactLookup | null;
    sleep: (ms: number) => Promise<void>;
    maxWaitMs: number;
    pollIntervalMs: number;
  }): Promise<FactResult> {
    const { userId, movie, priorCachedLookup, sleep, maxWaitMs, pollIntervalMs } = options;
    const lockToken = randomUUID();

    // 5. Tier 2 Burst Protection: Distributed DB-level generation lease lock
    const lockAcquired = await this.repo.acquireGenerationLock(
      userId,
      lockToken,
      LOCK_LEASE_MS
    );

    if (!lockAcquired) {
      // Another worker/instance holds the active generation lease for this user.
      // Poll until the peer writes a fresh fact or maxWaitMs elapses.
      const waitedLookup = await this.waitForConcurrentFact(
        userId,
        movie,
        sleep,
        maxWaitMs,
        pollIntervalMs
      );

      if (waitedLookup) {
        return {
          fact: waitedLookup.fact,
          source: "cache",
          cacheAgeSeconds: this.calculateAgeSeconds(waitedLookup.ageMs),
        };
      }

      // CRITICAL: Never fall through to call OpenAI when lockAcquired is false!
      // If the peer holder timed out or failed without writing a new fact,
      // return the most recent stale cached fact or throw 503.
      this.logger.warn(
        `[MovieFactService] Timed out waiting ${maxWaitMs}ms for concurrent generation lock on user=${userId}`
      );
      return this.resolveFallbackOrThrow(userId, movie, priorCachedLookup);
    }

    try {
      // Double-check the 60-second cache inside the lock in case a peer finished
      // right before we acquired the lock.
      const rechecked = await this.repo.getLatestFact(userId, movie);
      if (rechecked && this.isWithinCacheWindow(rechecked.ageMs)) {
        return {
          fact: rechecked.fact,
          source: "cache",
          cacheAgeSeconds: this.calculateAgeSeconds(rechecked.ageMs),
        };
      }

      // 6. Generate a new fun fact via OpenAI (strictly while holding the lock)
      const generatedText = await this.generator.generateFunFact(movie);
      const createdFact = await this.repo.createFact(
        userId,
        movie,
        generatedText.trim()
      );

      return {
        fact: createdFact,
        source: "generated",
        cacheAgeSeconds: 0,
      };
    } catch (error) {
      // 7. Log the underlying failure so missing keys or DB errors are visible in server logs
      this.logger.error(
        `[MovieFactService] Failed to generate or store fact for user=${userId}, movie="${movie}":`,
        error
      );

      // 8. Variant A Failure Handling:
      // Return the most recent cached fact if one exists; otherwise throw a user-friendly 503 error.
      return this.resolveFallbackOrThrow(userId, movie, priorCachedLookup);
    } finally {
      // Compare-and-clear: only releases the lock if `factLockId === lockToken`
      await this.repo.releaseGenerationLock(userId, lockToken).catch((releaseErr) => {
        this.logger.warn(
          `[MovieFactService] Non-fatal error releasing lock token=${lockToken} for user=${userId}:`,
          releaseErr
        );
      });
    }
  }

  private async resolveFallbackOrThrow(
    userId: string,
    movie: string,
    priorCachedLookup: LatestFactLookup | null
  ): Promise<FactResult> {
    const latestLookup =
      (await this.repo.getLatestFact(userId, movie).catch(() => null)) ??
      priorCachedLookup;

    if (latestLookup) {
      return {
        fact: latestLookup.fact,
        source: "stale_fallback",
        cacheAgeSeconds: this.calculateAgeSeconds(latestLookup.ageMs),
        warning:
          "Showing your most recent saved fact because the AI service is temporarily unavailable.",
      };
    }

    throw new FactGenerationError(
      "We couldn't generate a fun fact right now because the AI service is temporarily unavailable. Please try again shortly."
    );
  }

  private async waitForConcurrentFact(
    userId: string,
    movie: string,
    sleep: (ms: number) => Promise<void>,
    maxWaitMs: number,
    pollIntervalMs: number
  ): Promise<LatestFactLookup | null> {
    let elapsedMs = 0;
    while (elapsedMs < maxWaitMs) {
      await sleep(pollIntervalMs);
      elapsedMs += pollIntervalMs;

      const latest = await this.repo.getLatestFact(userId, movie);
      if (latest && this.isWithinCacheWindow(latest.ageMs)) {
        return latest;
      }
    }
    return null;
  }

  private isWithinCacheWindow(ageMs: number): boolean {
    return ageMs >= 0 && ageMs < CACHE_WINDOW_MS;
  }

  private calculateAgeSeconds(ageMs: number): number {
    return Math.max(0, Math.floor(ageMs / 1000));
  }
}
