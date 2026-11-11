import { NextRequest, NextResponse } from "next/server";
import { validateMovieTitle } from "./validation";

export interface OnboardingRouteDependencies {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  updateUserMovie: (
    userId: string,
    favoriteMovie: string
  ) => Promise<{ id: string; favoriteMovie: string | null }>;
}

/**
 * Factory for POST /api/onboarding to allow route-level authorization and validation tests
 * without importing server-only or Prisma.
 */
export function createOnboardingPostHandler(deps: OnboardingRouteDependencies) {
  return async function handlePostOnboarding(req: NextRequest): Promise<NextResponse> {
    try {
      const session = await deps.getSession();
      if (!session?.user?.id) {
        return NextResponse.json(
          { error: "Unauthorized: Please sign in with Google." },
          { status: 401 }
        );
      }

      const body = await req.json().catch(() => null);
      const validation = validateMovieTitle(body?.favoriteMovie);

      if (!validation.valid || !validation.movie) {
        return NextResponse.json(
          { error: validation.error ?? "Invalid movie title." },
          { status: 400 }
        );
      }

      // Strictly scope update to session.user.id (ignoring any body.userId)
      const updatedUser = await deps.updateUserMovie(
        session.user.id,
        validation.movie
      );

      return NextResponse.json(
        {
          user: updatedUser,
          message: "Favorite movie saved.",
        },
        { status: 200 }
      );
    } catch (error) {
      console.error("[POST /api/onboarding] Unexpected error:", error);
      return NextResponse.json(
        { error: "Unable to save your favorite movie right now. Please try again." },
        { status: 500 }
      );
    }
  };
}
