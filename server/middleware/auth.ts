/**
 * auth.ts — Session-based authentication middleware.
 *
 * Security decisions:
 * - ID tokens are verified server-side using google-auth-library.
 * - Only @thegbexchange.com domain is accepted.
 * - Session stores user email + admin flag only — no tokens, no credentials.
 * - Sessions are in-memory (memorystore), cleared on restart. No DB required.
 *
 * To add users, simply ensure they have a @thegbexchange.com Google Workspace
 * account. No provisioning step needed.
 */

import type { Request, Response, NextFunction } from "express";
import { OAuth2Client } from "google-auth-library";

// Extend express-session SessionData to carry the authenticated user.
declare module "express-session" {
  interface SessionData {
    user?: {
      email: string;    // Always lowercase @thegbexchange.com address
      name: string;     // Display name from Google profile
      isAdmin: boolean; // Derived from ADMIN_EMAILS env var at login time
    };
  }
}

// The Google OAuth client used ONLY for ID token verification (no credentials stored).
// GOOGLE_CLIENT_ID must match the OAuth client configured in Google Cloud Console.
// Lazily initialized on first use so process.env is populated from .env before this runs.
let googleClient: OAuth2Client | null = null;
function getGoogleClient(): OAuth2Client {
  if (!googleClient) googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  return googleClient;
}

const ALLOWED_DOMAIN = "thegbexchange.com";

/**
 * verifyGoogleIdToken — Validates a Google Identity Services credential (JWT).
 *
 * Returns the email and name if valid, throws otherwise.
 * The audience (aud) is verified against GOOGLE_CLIENT_ID automatically.
 */
export async function verifyGoogleIdToken(
  idToken: string
): Promise<{ email: string; name: string }> {
  const ticket = await getGoogleClient().verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  if (!payload) throw new Error("Empty token payload");

  const email = (payload.email || "").toLowerCase();
  const name = payload.name || email;

  // Reject anyone not on the allowed domain.
  if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
    throw new Error(`Access restricted to @${ALLOWED_DOMAIN} accounts`);
  }

  return { email, name };
}

/**
 * requireAuth — Express middleware that rejects unauthenticated requests with 401.
 * Apply to any route that requires a logged-in user.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.user) {
    return res.status(401).json({ error: "Unauthorized – please sign in" });
  }
  next();
}

/** Convenience helper — returns the session user or null. */
export function getSessionUser(req: Request) {
  return req.session?.user ?? null;
}
