# Movie Memory — Full-Stack SWE Take-Home Exercise (Variant A)

A full-stack web application built with **TypeScript, Next.js 14 (App Router), React, TailwindCSS, Postgres, Prisma, Google OAuth (NextAuth.js), and the OpenAI API**.

This submission implements the **Base Implementation** plus **Variant A — Backend-Focused (Caching & Correctness)**: a 60-second per-`(user, movie)` database cache window, two-tier burst/idempotency protection (in-process singleflight + Postgres compare-and-clear lease lock), resilient stale-cache fallback on OpenAI failure, strict session-scoped authorization, and automated backend tests.

## 1. Setup Instructions

### Prerequisites
* **Node.js** `>= 18.18.0` (or `v20+`)
* **PostgreSQL** `>= 14`
* **Google Cloud OAuth 2.0 Credentials** (Authorized redirect URI: `http://localhost:3000/api/auth/callback/google`)
* **OpenAI API Key**

### Local Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```
2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   ```
3. **Run Postgres migrations & generate Prisma Client:**
   ```bash
   npm run db:migrate
   npm run db:generate
   ```
4. **Start the development server:**
   ```bash
   npm run dev
   ```
5. **Run the automated backend unit tests:**
   ```bash
   npm test
   ```

## 2. Required Environment Variables

| Variable | Required | Description | Example |
| :--- | :---: | :--- | :--- |
| `DATABASE_URL` | Yes | PostgreSQL connection string used by Prisma | `postgresql://postgres:postgres@localhost:5432/movie_memory?schema=public` |
| `NEXTAUTH_URL` | Yes | Canonical base URL of the app | `http://localhost:3000` |
| `NEXTAUTH_SECRET` | Yes | Random 32-byte secret (`openssl rand -base64 32`) | `8f9d2a...` |
| `GOOGLE_CLIENT_ID` | Yes | OAuth 2.0 Client ID from Google Cloud Console | `123456-abc.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Yes | OAuth 2.0 Client Secret from Google Cloud Console | `GOCSPX-...` |
| `OPENAI_API_KEY` | Yes | Server-side OpenAI API secret key | `sk-proj-...` |
| `OPENAI_MODEL` | No | OpenAI chat model identifier (defaults to `gpt-4o-mini`) | `gpt-4o-mini` |

## 3. Database Migration Steps

The schema lives in `prisma/schema.prisma` and the initial SQL migration is committed in `prisma/migrations/20261109000000_init/migration.sql`.

* **Development (create/apply migration & regenerate client):** `npx prisma migrate dev`
* **Production / CI (apply committed migrations):** `npx prisma migrate deploy`
* **Rapid schema sync (no migration file):** `npx prisma db push`

## 4. Architecture Overview

### Data Model & Index Design (`prisma/schema.prisma`)

1. **`User` Table:**
   * Stores Google profile fields (`id`, `name`, `email`, `image`), `favoriteMovie` (`VARCHAR(120)`), and two columns supporting Variant A's distributed generation lease: `factGeneratingAt` (`TIMESTAMPTZ(3)`) and `factLockId` (`VARCHAR(64)`).
   * Keeping `favoriteMovie` on `User` avoids a join on every authenticated route check (`/` -> `/onboarding` vs. `/dashboard`).
2. **`MovieFact` Table:**
   * Stores generated facts (`id`, `userId`, `movie`, `content`, `createdAt`) with `ON DELETE CASCADE` to `User` and `TIMESTAMPTZ(3)` on `createdAt`.
   * **Timezone-Safe DB Clock:** `PrismaFactRepository.createFact` inserts facts via raw SQL using Postgres `NOW()`, and `getLatestFact` computes `ageMs` in SQL using `EXTRACT(EPOCH FROM (NOW() - "createdAt")) * 1000`. Using `TIMESTAMPTZ(3)` with `NOW()` for both writes and reads ensures `ageMs` is unaffected by Postgres session timezone settings or app-server clock drift.
   * **Composite B-Tree Index `@@index([userId, movie, createdAt(sort: Desc)])`:** Because `MovieFact.movie` is always written from the normalized `User.favoriteMovie` value, `PrismaFactRepository.getLatestFact` queries with exact equality:
     ```sql
     SELECT "id", "userId", "movie", "content", "createdAt",
            EXTRACT(EPOCH FROM (NOW() - "createdAt")) * 1000 AS "ageMs"
     FROM "MovieFact"
     WHERE "userId" = $1 AND "movie" = $2
     ORDER BY "createdAt" DESC
     LIMIT 1;
     ```
     Using exact equality (`=`) allows Postgres to satisfy both the `(userId, movie)` equality predicates and the `createdAt DESC` sort directly from the composite B-tree index.
3. **NextAuth Tables (`Account`, `Session`, `VerificationToken`):**
   * Uses database-backed sessions. In `src/lib/auth.ts`, `linkAccount` strips `access_token`, `refresh_token`, and `id_token` before writing to `Account` so unused Google bearer tokens are never stored in plaintext at rest.

### Request Flow & Non-Blocking Dashboard

1. **Authentication (`/`):** Unauthenticated visitors see the landing page with `"Sign in with Google"`. Post-login, `/` checks `user.favoriteMovie` in Postgres and redirects first-time users to `/onboarding` and returning users to `/dashboard`.
2. **Onboarding (`/onboarding` & `POST /api/onboarding`):** `validateMovieTitle()` trims whitespace, collapses consecutive spaces, rejects ASCII control characters, and enforces 1–120 characters. Updates are scoped strictly to `session.user.id`.
3. **Dashboard (`/dashboard` & `GET /api/fact`):** `/dashboard` renders the user's Google profile (with graceful fallbacks for missing name or photo) and favorite movie immediately during SSR without waiting on OpenAI. `DashboardClient` fetches `GET /api/fact` asynchronously on mount with an `AbortController` and skeleton state, preventing slow OpenAI responses or outages from hanging page navigation.
4. **Testable Route Handler Factories (`src/lib/fact-handler.ts`, `src/lib/onboarding-handler.ts`):** Route handler logic is extracted into pure factories in `src/lib/` free of `server-only` or Prisma imports, while `app/api/*/route.ts` files export only Next.js HTTP method handlers (`GET`, `POST`) and route config (`dynamic`).

### Variant A Caching, Concurrency & Failure Strategy (`src/lib/fact-service.ts`)

1. **60-Second Cache Window:**
   * `PrismaFactRepository.getLatestFact` computes `ageMs` in SQL using `NOW() - "createdAt"`. If `ageMs >= 0 && ageMs < 60_000`, `MovieFactService` returns `source: "cache"` immediately.
2. **Two-Tier Burst / Idempotency Protection:**
   * **Tier 1 — In-Process Singleflight (`inFlightRequests` Map):** Concurrent requests for the same `userId:movie` within a single Node process share the same in-flight `Promise<FactResult>`.
   * **Tier 2 — Postgres Lease Lock with Compare-and-Clear (`acquireGenerationLock` / `releaseGenerationLock`):**
     * `OpenAIFactGenerator` enforces an 8-second hard timeout (`timeout: 8000`) with `maxRetries: 0`.
     * `acquireGenerationLock` acquires a 20-second lease (`INTERVAL '20 seconds'`, more than 2x the 8s OpenAI ceiling) tagged with a unique UUID `factLockId` using Postgres `NOW()`:
       ```sql
       UPDATE "User"
       SET "factGeneratingAt" = NOW(), "factLockId" = $lockToken
       WHERE "id" = $userId
         AND ("factGeneratingAt" IS NULL OR "factGeneratingAt" < NOW() - INTERVAL '20 seconds');
       ```
     * In `finally`, `releaseGenerationLock` executes a compare-and-clear (`WHERE "id" = $userId AND "factLockId" = $lockToken`) so a delayed worker can never clear a lock acquired by a subsequent worker.
     * When `acquireGenerationLock` returns `false`, the caller polls `getLatestFact` every 150ms for up to `LOCK_MAX_WAIT_MS = 10_000 ms` (exceeding OpenAI's 8s ceiling). If the wait times out, execution **never** falls through to call OpenAI without the lock—it returns the stale cached fact or throws `FactGenerationError` (`503`).
3. **Failure Handling & Logging:**
   * Any OpenAI or persistence error is logged server-side via `FactLogger.error`. If a prior fact exists for `(userId, movie)` (regardless of age), it is returned with `source: "stale_fallback"`; otherwise a sanitized `FactGenerationError` (`503`) is returned to the client.

## 5. Variant Choice & Rationale (Variant A)

I chose **Variant A — Backend-Focused (Caching & Correctness)** because wrapping an external LLM API in a web backend surfaces three practical correctness challenges:
* **Cost & Latency Control:** Enforcing a 60-second database cache window bounds OpenAI token spend per active user to at most 1 generation per minute.
* **Burst Contention Across Tabs & Instances:** Because LLM calls take several seconds, rapid refreshes or multiple open tabs easily race. Combining an in-process singleflight map with a Postgres lease lock prevents duplicate OpenAI calls both within a single process and across multiple serverless instances.
* **Graceful Degradation:** Returning the most recent stored fact from Postgres when OpenAI times out or returns a 5xx keeps the product usable during upstream outages.

## 6. Key Engineering Tradeoffs

| Decision | Chosen Approach | Alternative Considered | Rationale & Tradeoff |
| :--- | :--- | :--- | :--- |
| **Cross-Instance Lock** | **Atomic `UPDATE` lease on `User` (`factGeneratingAt` + `factLockId`, 20s TTL) + polling** | Interactive DB transaction (`SELECT ... FOR UPDATE`) held open during the OpenAI call | Holding a Postgres transaction open for up to 8 seconds during external HTTP I/O exhausts connection pools. A compare-and-clear lease releases the connection immediately; the tradeoff is short polling (`150ms` interval, up to `10s` if the holder fails without writing a fact) when a second instance contends on the same user. |
| **Failure Caching** | **Fallback to stale cached fact without negative-caching errors** | Circuit breaker / negative cache TTL on OpenAI errors | Keeps implementation state minimal inside Postgres. Sequential requests during an outage will re-attempt OpenAI, which is tolerable because `/dashboard` loads facts asynchronously on the client without blocking SSR. |
| **Cache Storage** | **Postgres `MovieFact` with exact-match B-tree index `(userId, movie, createdAt DESC)`** | Redis (`SETEX`) | Postgres is already in the stack and stores every generated fact. Exact-match indexing serves both the 60s cache check and the stale fallback without adding Redis operational overhead. |
| **Dashboard Fact Loading** | **Client fetch on mount (`GET /api/fact`) with loading skeleton** | Blocking `/dashboard` SSR on `getFactForUser` | Blocking SSR on OpenAI causes `/dashboard` navigation to hang for up to 8s on cache misses or outages. Loading the fact via `/api/fact` renders the profile immediately. |

## 7. What I Would Improve with 2 More Hours

1. **Inline Movie Editing & Fact History (Variant B Bridge):** Add inline editing for `favoriteMovie` on the dashboard with optimistic UI and a collapsible history of past facts.
2. **Prompt Deduplication Context:** Pass the user's last 3–5 facts for that movie into the OpenAI prompt so consecutive generations after the 60s window avoid repeating trivia.
3. **Postgres Integration Tests via Testcontainers:** Add an automated integration test running `PrismaFactRepository` against a real containerized Postgres instance (including non-UTC database timezones) to test the raw SQL queries alongside the in-memory unit tests.
4. **Early Waiter Wakeup & Circuit Breaker:** Check lock release status inside `waitForConcurrentFact` (or use `LISTEN/NOTIFY`) so waiting instances exit immediately if the lock holder fails fast, and add a short negative-cache cooldown during upstream OpenAI outages.

## 8. Note on AI Usage

* **Initial Scaffolding:** Used AI to scaffold the Next.js App Router pages, TailwindCSS components, Prisma schema, and initial `MovieFactService` implementation.
* **Code Review & Bug Fixes:** Iterative code review and testing of the AI-generated drafts caught several subtle concurrency, SQL, and Next.js build issues that were subsequently fixed:
  1. **Lock Timeout Fall-Through & Lease/Retry Bounds:** In the initial draft, `executeWithLockAndFallback` fell through and called OpenAI without the lock when `waitForConcurrentFact` timed out at 4.5s, and OpenAI's `timeout: 8000` with `maxRetries: 1` (~16s worst case) exceeded the 15s lease while `releaseGenerationLock` cleared `factGeneratingAt` unconditionally. Fixed by returning `resolveFallbackOrThrow` on wait timeout, setting `maxRetries: 0` with a 20s lease (`INTERVAL '20 seconds'`), increasing `LOCK_MAX_WAIT_MS` to 10s, and adding `factLockId` compare-and-clear release (verified with a two-instance contention test).
  2. **B-Tree Index & Timezone Clock Handling:** The initial query used Prisma `mode: "insensitive"` (`ILIKE`), preventing full use of the composite B-tree index `(userId, movie, createdAt DESC)`, and used `TIMESTAMP(3)` without timezone alongside a negative-age clamp (`Math.max(0, ageMs)`) that could stretch the cache window when the Postgres timezone differed from UTC. Fixed by switching to `TIMESTAMPTZ(3)`, inserting and computing `ageMs` via SQL `NOW()`, matching `movie` with exact equality, and treating negative ages as a cache miss (`ageMs >= 0`).
  3. **Next.js Route Exports & Test Wiring:** Exporting route handler factories directly from `app/api/*/route.ts` pulled `server-only` into Vitest and violated Next.js 14's route export rules. Fixed by moving `createFactGetHandler` and `createOnboardingPostHandler` into `src/lib/fact-handler.ts` and `src/lib/onboarding-handler.ts`.
