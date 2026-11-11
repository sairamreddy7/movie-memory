import { redirect } from "next/navigation";
import { getAuthSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { OnboardingForm } from "@/components/onboarding-form";

export const dynamic = "force-dynamic";

/**
 * Onboarding Page (/onboarding) — First-Time Users Only
 * - Redirects unauthenticated visitors to /
 * - Redirects returning users who already have a favoriteMovie to /dashboard
 */
export default async function OnboardingPage() {
  const session = await getAuthSession();

  if (!session?.user?.id) {
    redirect("/");
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      name: true,
      favoriteMovie: true,
    },
  });

  if (!user) {
    redirect("/");
  }

  if (user.favoriteMovie && user.favoriteMovie.trim().length > 0) {
    redirect("/dashboard");
  }

  const displayName = user.name?.trim() || "there";

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-2xl backdrop-blur">
        <span className="inline-flex items-center rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-300 ring-1 ring-inset ring-amber-500/20">
          Welcome, {displayName}
        </span>

        <h1 className="mt-4 text-2xl font-bold tracking-tight text-white">
          What&apos;s your favorite movie?
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          We&apos;ll save your pick to your profile and generate fascinating
          behind-the-scenes trivia whenever you visit your dashboard.
        </p>

        <div className="mt-6">
          <OnboardingForm />
        </div>
      </div>
    </main>
  );
}
