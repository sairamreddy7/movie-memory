import { getAuthSession } from "@/lib/auth";
import { movieFactService } from "@/lib/prisma-fact-repository";
import { createFactGetHandler } from "@/lib/fact-handler";

export const dynamic = "force-dynamic";

export const GET = createFactGetHandler({
  getSession: getAuthSession,
  factService: movieFactService,
});
