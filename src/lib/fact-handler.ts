import { NextResponse } from "next/server";
import {
  FactGenerationError,
  MovieFactService,
  OnboardingRequiredError,
  UnauthenticatedError,
} from "./fact-service";

export interface FactRouteDependencies {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  factService: Pick<MovieFactService, "getFactForUser">;
}

/**
 * Factory for the GET /api/fact handler to support deterministic route-level
 * authorization testing with mocked sessions without importing server-only or Prisma.
 */
export function createFactGetHandler(deps: FactRouteDependencies) {
  return async function handleGetFact(): Promise<NextResponse> {
    try {
      const session = await deps.getSession();

      const result = await deps.factService.getFactForUser({
        sessionUserId: session?.user?.id,
      });

      return NextResponse.json(
        {
          fact: {
            id: result.fact.id,
            movie: result.fact.movie,
            content: result.fact.content,
            createdAt: result.fact.createdAt.toISOString(),
          },
          source: result.source,
          cacheAgeSeconds: result.cacheAgeSeconds,
          cacheTtlRemainingSeconds:
            result.source === "stale_fallback"
              ? 0
              : Math.max(0, 60 - result.cacheAgeSeconds),
          warning: result.warning ?? null,
        },
        { status: 200 }
      );
    } catch (error) {
      if (
        error instanceof UnauthenticatedError ||
        error instanceof OnboardingRequiredError ||
        error instanceof FactGenerationError
      ) {
        return NextResponse.json(
          { error: error.message },
          { status: error.statusCode }
        );
      }

      console.error("[GET /api/fact] Unexpected error:", error);
      return NextResponse.json(
        {
          error:
            "We encountered an unexpected issue retrieving your movie fact. Please try again shortly.",
        },
        { status: 500 }
      );
    }
  };
}
