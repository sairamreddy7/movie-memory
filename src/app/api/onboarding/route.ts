import { getAuthSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createOnboardingPostHandler } from "@/lib/onboarding-handler";

export const POST = createOnboardingPostHandler({
  getSession: getAuthSession,
  updateUserMovie: (userId, favoriteMovie) =>
    prisma.user.update({
      where: { id: userId },
      data: { favoriteMovie },
      select: { id: true, favoriteMovie: true },
    }),
});
