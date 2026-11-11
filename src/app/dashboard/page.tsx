import { redirect } from "next/navigation";
import { getAuthSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { DashboardClient } from "@/components/dashboard-client";

export const dynamic = "force-dynamic";

/**
 * Dashboard Page (/dashboard)
 * Requirements:
 * - If logged out and navigating to /dashboard, redirect to login (/)
 * - If first-time user has not completed onboarding, redirect to /onboarding
 * - Does NOT block SSR on OpenAI: renders user profile & favorite movie immediately,
 *   while DashboardClient fetches /api/fact asynchronously on mount.
 */
export default async function DashboardPage() {
  const session = await getAuthSession();

  if (!session?.user?.id) {
    redirect("/");
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      favoriteMovie: true,
    },
  });

  if (!user) {
    redirect("/");
  }

  if (!user.favoriteMovie || !user.favoriteMovie.trim()) {
    redirect("/onboarding");
  }

  return (
    <DashboardClient
      user={{
        name: user.name?.trim() || "Movie Enthusiast",
        email: user.email?.trim() || "No email provided by Google",
        image: user.image || null,
        favoriteMovie: user.favoriteMovie,
      }}
    />
  );
}
