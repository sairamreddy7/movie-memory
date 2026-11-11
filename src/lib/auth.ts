import "server-only";
import type { NextAuthOptions } from "next-auth";
import type { Adapter, AdapterAccount } from "next-auth/adapters";
import { getServerSession } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { prisma } from "./prisma";

/**
 * Wraps PrismaAdapter so we do not persist unused OAuth bearer tokens
 * (access_token, refresh_token, id_token) in plaintext in the Account table.
 */
function createMinimalPrismaAdapter(): Adapter {
  const baseAdapter = PrismaAdapter(prisma);
  return {
    ...baseAdapter,
    async linkAccount(account: AdapterAccount) {
      const sanitizedAccount: AdapterAccount = {
        ...account,
        access_token: undefined,
        refresh_token: undefined,
        id_token: undefined,
      };
      return baseAdapter.linkAccount!(sanitizedAccount);
    },
  };
}

export const authOptions: NextAuthOptions = {
  adapter: createMinimalPrismaAdapter(),
  session: {
    strategy: "database",
  },
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    }),
  ],
  pages: {
    signIn: "/",
  },
  callbacks: {
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
        session.user.favoriteMovie =
          (user as { favoriteMovie?: string | null }).favoriteMovie ?? null;
      }
      return session;
    },
  },
};

export function getAuthSession() {
  return getServerSession(authOptions);
}
