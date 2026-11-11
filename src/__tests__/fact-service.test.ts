import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  MovieFactService,
  UnauthenticatedError,
  OnboardingRequiredError,
  FactGenerationError,
  type FactRepository,
  type FactGenerator,
  type FactLogger,
  type LatestFactLookup,
  type MovieFactRecord,
} from "../lib/fact-service";
import { validateMovieTitle } from "../lib/validation";
import { createFactGetHandler } from "../lib/fact-handler";
import { createOnboardingPostHandler } from "../lib/onboarding-handler";

/**
 * In-memory test double for FactRepository simulating Postgres tables,
 * exact-match composite index ordering (userId, movie, createdAt DESC),
 * database clock `dbNow`, and compare-and-clear lease locks (factGeneratingAt + factLockId).
 */
class InMemoryFactRepository implements FactRepository {
  public dbNow = new Date("2026-11-09T18:00:00.000Z");
  public users = new Map<
    string,
    {
      id: string;
      favoriteMovie: string | null;
      factGeneratingAt: Date | null;
      factLockId: string | null;
    }
  >();
  public facts: MovieFactRecord[] = [];
  private idCounter = 1;

  seedUser(id: string, favoriteMovie: string | null) {
    this.users.set(id, {
      id,
      favoriteMovie,
      factGeneratingAt: null,
      factLockId: null,
    });
  }

  seedFact(
    userId: string,
    movie: string,
    content: string,
    createdAt: Date = new Date(this.dbNow.getTime())
  ): MovieFactRecord {
    const record: MovieFactRecord = {
      id: `fact-${this.idCounter++}`,
      userId,
      movie,
      content,
      createdAt,
    };
    this.facts.push(record);
    return record;
  }

  async getUserById(userId: string) {
    const u = this.users.get(userId);
    return u ? { id: u.id, favoriteMovie: u.favoriteMovie } : null;
  }

  async getLatestFact(
    userId: string,
    movie: string
  ): Promise<LatestFactLookup | null> {
    // Exact match on (userId, movie) matching the Postgres B-tree composite index
    const matching = this.facts
      .filter((f) => f.userId === userId && f.movie === movie)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const newest = matching[0];
    if (!newest) return null;

    return {
      fact: newest,
      ageMs: this.dbNow.getTime() - newest.createdAt.getTime(),
    };
  }

  async createFact(
    userId: string,
    movie: string,
    content: string
  ): Promise<MovieFactRecord> {
    return this.seedFact(userId, movie, content, new Date(this.dbNow.getTime()));
  }

  async acquireGenerationLock(
    userId: string,
    lockToken: string,
    leaseMs: number
  ): Promise<boolean> {
    const user = this.users.get(userId);
    if (!user) return false;

    const staleCutoff = this.dbNow.getTime() - leaseMs;
    if (
      user.factGeneratingAt === null ||
      user.factGeneratingAt.getTime() < staleCutoff
    ) {
      user.factGeneratingAt = new Date(this.dbNow.getTime());
      user.factLockId = lockToken;
      return true;
    }

    return false;
  }

  async releaseGenerationLock(
    userId: string,
    lockToken: string
  ): Promise<boolean> {
    const user = this.users.get(userId);
    if (!user) return false;

    // Compare-and-clear: only release if the caller still owns factLockId
    if (user.factLockId === lockToken) {
      user.factGeneratingAt = null;
      user.factLockId = null;
      return true;
    }

    return false;
  }
}

class MockFactGenerator implements FactGenerator {
  public callCount = 0;
  public shouldFail = false;
  public simulatedDurationMs = 0;
  private readonly onAdvanceTime?: (ms: number) => Promise<void>;

  constructor(onAdvanceTime?: (ms: number) => Promise<void>) {
    this.onAdvanceTime = onAdvanceTime;
  }

  async generateFunFact(movie: string): Promise<string> {
    this.callCount += 1;
    const currentCall = this.callCount;
    if (this.simulatedDurationMs > 0 && this.onAdvanceTime) {
      await this.onAdvanceTime(this.simulatedDurationMs);
    }
    if (this.shouldFail) {
      throw new Error("OpenAI API 503 Service Unavailable / Timeout");
    }
    return `Generated fact #${currentCall} for ${movie}`;
  }
}

class SpyLogger implements FactLogger {
  public errors: Array<{ message: string; error?: unknown }> = [];
  public warnings: Array<{ message: string; error?: unknown }> = [];

  error(message: string, error?: unknown) {
    this.errors.push({ message, error });
  }
  warn(message: string, error?: unknown) {
    this.warnings.push({ message, error });
  }
}

describe("Variant A — MovieFactService & Route Handler Tests", () => {
  let repo: InMemoryFactRepository;
  let generator: MockFactGenerator;
  let logger: SpyLogger;
  let service: MovieFactService;

  beforeEach(() => {
    repo = new InMemoryFactRepository();
    generator = new MockFactGenerator();
    logger = new SpyLogger();
    service = new MovieFactService(repo, generator, logger);
  });

  describe("1. 60-Second Cache Window Logic", () => {
    it("returns the cached fact without calling OpenAI if the latest fact for (user + movie) is < 60 seconds old", async () => {
      repo.seedUser("user-1", "Inception");
      const thirtySecondsAgo = new Date(repo.dbNow.getTime() - 30 * 1000);
      const cached = repo.seedFact(
        "user-1",
        "Inception",
        "Christopher Nolan filmed the rotating hallway fight without CGI.",
        thirtySecondsAgo
      );

      const result = await service.getFactForUser({
        sessionUserId: "user-1",
      });

      expect(result.source).toBe("cache");
      expect(result.fact.id).toBe(cached.id);
      expect(result.fact.content).toBe(cached.content);
      expect(result.cacheAgeSeconds).toBe(30);
      expect(generator.callCount).toBe(0);
    });

    it("treats negative ageMs as a cache miss rather than clamping to fresh", async () => {
      repo.seedUser("user-1", "Inception");
      const futureTimestamp = new Date(repo.dbNow.getTime() + 50);
      repo.seedFact(
        "user-1",
        "Inception",
        "Future-skewed timestamp fact",
        futureTimestamp
      );

      const result = await service.getFactForUser({
        sessionUserId: "user-1",
      });

      expect(result.source).toBe("generated");
      expect(generator.callCount).toBe(1);
    });

    it("generates, stores, and returns a new fact when the most recent fact is >= 60 seconds old", async () => {
      repo.seedUser("user-1", "Inception");
      const sixtyOneSecondsAgo = new Date(repo.dbNow.getTime() - 61 * 1000);
      repo.seedFact(
        "user-1",
        "Inception",
        "Older fact from 61 seconds ago.",
        sixtyOneSecondsAgo
      );

      const result = await service.getFactForUser({
        sessionUserId: "user-1",
      });

      expect(result.source).toBe("generated");
      expect(result.fact.content).toBe("Generated fact #1 for Inception");
      expect(result.cacheAgeSeconds).toBe(0);
      expect(generator.callCount).toBe(1);
      expect(repo.facts.length).toBe(2);
    });

    it("scopes cache by exact (user + movie) so changing favoriteMovie generates a fresh fact", async () => {
      repo.seedUser("user-1", "The Matrix");
      const tenSecondsAgo = new Date(repo.dbNow.getTime() - 10 * 1000);
      repo.seedFact(
        "user-1",
        "Inception",
        "Recent fact for old movie Inception",
        tenSecondsAgo
      );

      const result = await service.getFactForUser({
        sessionUserId: "user-1",
      });

      expect(result.source).toBe("generated");
      expect(result.fact.movie).toBe("The Matrix");
      expect(generator.callCount).toBe(1);
    });
  });

  describe("2. Tier 1 & Tier 2 Burst / Cross-Instance Concurrency Protection", () => {
    it("Tier 1 (Single Instance): coalesces 5 concurrent burst requests in the same process into 1 OpenAI call", async () => {
      repo.seedUser("user-1", "Interstellar");
      const slowGen = new MockFactGenerator(async () => {
        await new Promise((r) => setTimeout(r, 25));
      });
      slowGen.simulatedDurationMs = 25;
      const singleInstanceService = new MovieFactService(repo, slowGen, logger);

      const results = await Promise.all([
        singleInstanceService.getFactForUser({ sessionUserId: "user-1" }),
        singleInstanceService.getFactForUser({ sessionUserId: "user-1" }),
        singleInstanceService.getFactForUser({ sessionUserId: "user-1" }),
        singleInstanceService.getFactForUser({ sessionUserId: "user-1" }),
        singleInstanceService.getFactForUser({ sessionUserId: "user-1" }),
      ]);

      expect(slowGen.callCount).toBe(1);
      expect(repo.facts.length).toBe(1);
      const uniqueIds = new Set(results.map((r) => r.fact.id));
      expect(uniqueIds.size).toBe(1);
    });

    it("Tier 2 (Two Separate Instances, 6s simulated OpenAI call): makes 1 OpenAI call and stores 1 fact", async () => {
      repo.seedUser("user-1", "Interstellar");

      // Simulate a 6,000ms OpenAI call across two independent MovieFactService instances
      // sharing the same database repository.
      const sharedGen = new MockFactGenerator(async (durationMs) => {
        const steps = 12;
        const stepMs = durationMs / steps;
        for (let i = 0; i < steps; i++) {
          await new Promise((r) => setTimeout(r, 2));
          repo.dbNow = new Date(repo.dbNow.getTime() + stepMs);
        }
      });
      sharedGen.simulatedDurationMs = 6000;

      const instanceA = new MovieFactService(repo, sharedGen, logger);
      const instanceB = new MovieFactService(repo, sharedGen, logger);

      const fastPollSleep = async () => {
        await new Promise((r) => setTimeout(r, 2));
      };

      const [resA, resB] = await Promise.all([
        instanceA.getFactForUser({
          sessionUserId: "user-1",
          sleep: fastPollSleep,
          pollIntervalMs: 150,
          maxWaitMs: 10000,
        }),
        instanceB.getFactForUser({
          sessionUserId: "user-1",
          sleep: fastPollSleep,
          pollIntervalMs: 150,
          maxWaitMs: 10000,
        }),
      ]);

      expect(sharedGen.callCount).toBe(1);
      expect(repo.facts.length).toBe(1);
      expect(resA.fact.id).toBe(resB.fact.id);
      expect(new Set([resA.source, resB.source])).toEqual(
        new Set(["generated", "cache"])
      );
    });

    it("Never falls through to call OpenAI when lock acquisition fails and polling times out (returns stale fact or 503)", async () => {
      repo.seedUser("user-1", "Interstellar");
      await repo.acquireGenerationLock("user-1", "holder-token-1", 20000);

      const noOpSleep = async () => {};

      // Case A: No prior cached fact exists -> must throw 503 FactGenerationError without calling OpenAI
      await expect(
        service.getFactForUser({
          sessionUserId: "user-1",
          sleep: noOpSleep,
          pollIntervalMs: 500,
          maxWaitMs: 1500,
        })
      ).rejects.toThrow(FactGenerationError);
      expect(generator.callCount).toBe(0);

      // Case B: Stale cached fact exists -> must return stale_fallback without calling OpenAI
      const staleFact = repo.seedFact(
        "user-1",
        "Interstellar",
        "Stale fact from 10 minutes ago",
        new Date(repo.dbNow.getTime() - 10 * 60 * 1000)
      );

      const fallbackRes = await service.getFactForUser({
        sessionUserId: "user-1",
        sleep: noOpSleep,
        pollIntervalMs: 500,
        maxWaitMs: 1500,
      });

      expect(fallbackRes.source).toBe("stale_fallback");
      expect(fallbackRes.fact.id).toBe(staleFact.id);
      expect(generator.callCount).toBe(0);
    });

    it("Compare-and-clear lock release: expired Worker 1 cannot release Worker 2's active lock", async () => {
      repo.seedUser("user-1", "Interstellar");

      const acquired1 = await repo.acquireGenerationLock(
        "user-1",
        "token-worker-1",
        20000
      );
      expect(acquired1).toBe(true);

      // Advance DB clock by 21s (> 20s lease) so Worker 1's lease expires
      repo.dbNow = new Date(repo.dbNow.getTime() + 21 * 1000);

      // Worker 2 acquires lock with token-worker-2
      const acquired2 = await repo.acquireGenerationLock(
        "user-1",
        "token-worker-2",
        20000
      );
      expect(acquired2).toBe(true);

      // Worker 1 finishes late and attempts to release with token-worker-1
      const releasedByWorker1 = await repo.releaseGenerationLock(
        "user-1",
        "token-worker-1"
      );
      expect(releasedByWorker1).toBe(false);

      // Worker 2's lock is still intact (a 3rd worker cannot steal it)
      const acquired3 = await repo.acquireGenerationLock(
        "user-1",
        "token-worker-3",
        20000
      );
      expect(acquired3).toBe(false);

      // Worker 2 releases its own lock cleanly
      const releasedByWorker2 = await repo.releaseGenerationLock(
        "user-1",
        "token-worker-2"
      );
      expect(releasedByWorker2).toBe(true);
    });
  });

  describe("3. OpenAI Failure Handling & Error Logging", () => {
    it("logs the error and returns the most recent cached fact (even if > 60s old) when OpenAI fails", async () => {
      repo.seedUser("user-1", "Parasite");
      const fiveMinutesAgo = new Date(repo.dbNow.getTime() - 5 * 60 * 1000);
      const staleFact = repo.seedFact(
        "user-1",
        "Parasite",
        "The Park family house was custom-built on an outdoor lot.",
        fiveMinutesAgo
      );
      generator.shouldFail = true;

      const result = await service.getFactForUser({
        sessionUserId: "user-1",
      });

      expect(result.source).toBe("stale_fallback");
      expect(result.fact.id).toBe(staleFact.id);
      expect(result.warning).toBeDefined();
      expect(logger.errors.length).toBe(1);
    });

    it("logs the error and throws FactGenerationError (503) when OpenAI fails and no cached fact exists", async () => {
      repo.seedUser("user-1", "Parasite");
      generator.shouldFail = true;

      await expect(
        service.getFactForUser({
          sessionUserId: "user-1",
        })
      ).rejects.toThrow(FactGenerationError);
      expect(logger.errors.length).toBe(1);
    });
  });

  describe("4. Route-Level & Service-Level Authorization Isolation", () => {
    it("GET /api/fact rejects unauthenticated requests with HTTP 401", async () => {
      const handleGet = createFactGetHandler({
        getSession: async () => null,
        factService: service,
      });

      const response = await handleGet();
      expect(response.status).toBe(401);
    });

    it("GET /api/fact strictly scopes fact retrieval to the authenticated session user", async () => {
      repo.seedUser("user-alice", "Dune");
      repo.seedUser("user-bob", "Dune");
      const tenSecondsAgo = new Date(repo.dbNow.getTime() - 10 * 1000);
      const bobsFact = repo.seedFact(
        "user-bob",
        "Dune",
        "Bob's cached fact for Dune",
        tenSecondsAgo
      );

      let activeSessionUserId = "user-alice";
      const handleGet = createFactGetHandler({
        getSession: async () => ({ user: { id: activeSessionUserId } }),
        factService: service,
      });

      // Alice calls GET /api/fact -> never receives Bob's cached fact
      const aliceResponse = await handleGet();
      const aliceData = await aliceResponse.json();
      expect(aliceResponse.status).toBe(200);
      expect(aliceData.fact.id).not.toBe(bobsFact.id);
      expect(aliceData.source).toBe("generated");

      // Bob calls GET /api/fact -> receives his own cached fact without calling OpenAI
      activeSessionUserId = "user-bob";
      const bobResponse = await handleGet();
      const bobData = await bobResponse.json();
      expect(bobResponse.status).toBe(200);
      expect(bobData.fact.id).toBe(bobsFact.id);
      expect(bobData.source).toBe("cache");
    });

    it("POST /api/onboarding ignores any spoofed userId in the body and updates only session.user.id", async () => {
      repo.seedUser("user-alice", null);
      repo.seedUser("user-bob", "The Godfather");

      const handlePost = createOnboardingPostHandler({
        getSession: async () => ({ user: { id: "user-alice" } }),
        updateUserMovie: async (userId, favoriteMovie) => {
          const u = repo.users.get(userId)!;
          u.favoriteMovie = favoriteMovie;
          return { id: u.id, favoriteMovie: u.favoriteMovie };
        },
      });

      const req = new NextRequest("http://localhost:3000/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: "user-bob",
          favoriteMovie: "   Arrival   ",
        }),
      });

      const response = await handlePost(req);
      expect(response.status).toBe(200);
      expect(repo.users.get("user-alice")?.favoriteMovie).toBe("Arrival");
      expect(repo.users.get("user-bob")?.favoriteMovie).toBe("The Godfather");
    });

    it("requires onboarding before generating facts", async () => {
      repo.seedUser("user-new", null);

      await expect(
        service.getFactForUser({
          sessionUserId: "user-new",
        })
      ).rejects.toThrow(OnboardingRequiredError);
    });
  });

  describe("5. Server-Side Movie Input Validation", () => {
    it("trims whitespace and collapses multiple spaces", () => {
      const res = validateMovieTitle("   Everything   Everywhere All at Once  ");
      expect(res.valid).toBe(true);
      expect(res.movie).toBe("Everything Everywhere All at Once");
    });

    it("rejects empty or whitespace-only movie titles", () => {
      expect(validateMovieTitle("").valid).toBe(false);
      expect(validateMovieTitle("    ").valid).toBe(false);
    });

    it("rejects titles exceeding 120 characters", () => {
      const tooLong = "A".repeat(121);
      const res = validateMovieTitle(tooLong);
      expect(res.valid).toBe(false);
    });
  });
});
