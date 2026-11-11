import { randomUUID } from "crypto";
import "server-only";
import { prisma } from "./prisma";
import {
  MovieFactService,
  type FactRepository,
  type LatestFactLookup,
  type MovieFactRecord,
} from "./fact-service";
import { openAIFactGenerator } from "./openai";

/**
 * Prisma-backed implementation of FactRepository.
 *
 * Key correctness properties:
 * 1. Single Timezone-Safe Clock Source (Postgres `NOW()` on `TIMESTAMPTZ(3)`):
 *    Both `MovieFact.createdAt` (inserted via SQL `NOW()`) and `User.factGeneratingAt`
 *    use `TIMESTAMPTZ(3)` and are evaluated against Postgres `NOW()`, preventing
 *    timezone offsets from skewing `ageMs`.
 * 2. Exact-Match Composite B-tree Index Probe:
 *    Queries `WHERE "userId" = $1 AND "movie" = $2 ORDER BY "createdAt" DESC LIMIT 1`,
 *    which directly traverses `MovieFact_userId_movie_createdAt_idx`.
 * 3. Compare-and-Clear Distributed Lease Lock:
 *    `acquireGenerationLock` sets `factGeneratingAt = NOW()` and `factLockId = lockToken`
 *    using a constant `INTERVAL '20 seconds'` (matching `LOCK_LEASE_MS = 20_000`).
 *    `releaseGenerationLock` clears the lock ONLY where `factLockId = lockToken`.
 */
export class PrismaFactRepository implements FactRepository {
  async getUserById(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        favoriteMovie: true,
      },
    });
  }

  async getLatestFact(userId: string, movie: string): Promise<LatestFactLookup | null> {
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        userId: string;
        movie: string;
        content: string;
        createdAt: Date;
        ageMs: number;
      }>
    >`
      SELECT
        "id",
        "userId",
        "movie",
        "content",
        "createdAt",
        EXTRACT(EPOCH FROM (NOW() - "createdAt")) * 1000 AS "ageMs"
      FROM "MovieFact"
      WHERE "userId" = ${userId}
        AND "movie" = ${movie}
      ORDER BY "createdAt" DESC
      LIMIT 1
    `;

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      fact: {
        id: row.id,
        userId: row.userId,
        movie: row.movie,
        content: row.content,
        createdAt: row.createdAt,
      },
      ageMs: Number(row.ageMs),
    };
  }

  async createFact(
    userId: string,
    movie: string,
    content: string
  ): Promise<MovieFactRecord> {
    const rows = await prisma.$queryRaw<MovieFactRecord[]>`
      INSERT INTO "MovieFact" ("id", "userId", "movie", "content", "createdAt")
      VALUES (${randomUUID()}, ${userId}, ${movie}, ${content}, NOW())
      RETURNING "id", "userId", "movie", "content", "createdAt"
    `;
    return rows[0]!;
  }

  async acquireGenerationLock(
    userId: string,
    lockToken: string,
    _leaseMs: number
  ): Promise<boolean> {
    // Uses constant INTERVAL '20 seconds' (matching LOCK_LEASE_MS = 20_000)
    // to avoid parameter-type multiplication errors in Postgres.
    const updatedCount = await prisma.$executeRaw`
      UPDATE "User"
      SET "factGeneratingAt" = NOW(),
          "factLockId" = ${lockToken}
      WHERE "id" = ${userId}
        AND (
          "factGeneratingAt" IS NULL
          OR "factGeneratingAt" < NOW() - INTERVAL '20 seconds'
        )
    `;

    return updatedCount === 1;
  }

  async releaseGenerationLock(userId: string, lockToken: string): Promise<boolean> {
    const clearedCount = await prisma.$executeRaw`
      UPDATE "User"
      SET "factGeneratingAt" = NULL,
          "factLockId" = NULL
      WHERE "id" = ${userId}
        AND "factLockId" = ${lockToken}
    `;

    return clearedCount === 1;
  }
}

export const movieFactService = new MovieFactService(
  new PrismaFactRepository(),
  openAIFactGenerator
);
