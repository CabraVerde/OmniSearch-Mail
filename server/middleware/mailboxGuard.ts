/**
 * mailboxGuard.ts — RBAC enforcement for Gmail mailbox access.
 *
 * WHO CAN ACCESS WHICH MAILBOX:
 *   Defined in config/MAILBOX_GRANTS.json (path configurable via MAILBOX_GRANTS_PATH).
 *   Admins (ADMIN_EMAILS) bypass the grants check and can access any mailbox.
 *
 * DESIGN NOTE:
 *   Account indexes (1, 2, 3…) are mapped to email addresses via env vars:
 *     GMAIL_ACCOUNT_1_EMAIL=user1@thegbexchange.com
 *     GMAIL_ACCOUNT_2_EMAIL=accounts@thegbexchange.com
 *   This avoids a Gmail API round-trip on every request.
 *   If an account index has no email env var, access is denied by default.
 *
 * GRANTS FILE FORMAT (config/MAILBOX_GRANTS.json):
 *   {
 *     "user1@thegbexchange.com": ["user1@thegbexchange.com"],
 *     "user2@thegbexchange.com": ["user2@thegbexchange.com", "accounts@thegbexchange.com"]
 *   }
 *
 * All denied access attempts are logged to server stdout for visibility.
 * NEVER log email message content, attachment data, or tokens here.
 */

import type { Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";

type MailboxGrants = Record<string, string[]>;

let cachedGrants: MailboxGrants | null = null;
let cacheLoadedAt: number | null = null;
// Reload the grants file if it changes, without a server restart.
const CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * loadMailboxGrants — Reads and caches MAILBOX_GRANTS.json.
 * Returns empty object on failure (fail-closed: deny all on misconfiguration).
 */
export function loadMailboxGrants(): MailboxGrants {
  const now = Date.now();
  if (cachedGrants && cacheLoadedAt && now - cacheLoadedAt < CACHE_TTL_MS) {
    return cachedGrants;
  }

  const grantsPath = path.resolve(
    process.env.MAILBOX_GRANTS_PATH || "config/MAILBOX_GRANTS.json"
  );

  try {
    const raw = fs.readFileSync(grantsPath, "utf8");
    cachedGrants = JSON.parse(raw) as MailboxGrants;
    cacheLoadedAt = now;
    // Normalize all emails to lowercase
    const normalized: MailboxGrants = {};
    for (const [user, boxes] of Object.entries(cachedGrants)) {
      normalized[user.toLowerCase()] = boxes.map((b) => b.toLowerCase());
    }
    cachedGrants = normalized;
    return cachedGrants;
  } catch (err: any) {
    process.stderr.write(
      `[mailboxGuard] WARN: Could not load MAILBOX_GRANTS.json at ${grantsPath}: ${err.message}\n`
    );
    // Fail closed — no grants means no access
    cachedGrants = {};
    cacheLoadedAt = now;
    return {};
  }
}

/**
 * getMailboxEmailForAccount — Resolves an account index to an email address.
 * Reads from GMAIL_ACCOUNT_1_EMAIL, GMAIL_ACCOUNT_2_EMAIL, etc.
 * Returns empty string if not configured (access will be denied).
 */
export function getMailboxEmailForAccount(accountIndex: number): string {
  return (
    process.env[`GMAIL_ACCOUNT_${accountIndex}_EMAIL`] || ""
  ).toLowerCase();
}

/**
 * canAccessMailbox — Core grant check.
 *
 * Admin users (in ADMIN_EMAILS) bypass grants and can access any mailbox.
 * Other users must be listed in grants for the target mailbox.
 */
export function canAccessMailbox(
  userEmail: string,
  targetMailboxEmail: string
): boolean {
  const normalized = userEmail.toLowerCase();
  const targetNorm = targetMailboxEmail.toLowerCase();

  // Admins have unrestricted mailbox access
  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (adminEmails.includes(normalized)) return true;

  // Non-admin: check grants file
  if (!targetNorm) {
    // No email configured for this account index — deny
    return false;
  }

  const grants = loadMailboxGrants();
  const allowedBoxes = grants[normalized] ?? [];
  return allowedBoxes.includes(targetNorm);
}

/**
 * requireMailboxAccess — Middleware factory.
 *
 * Usage:
 *   app.post("/api/query/run", requireAuth, requireMailboxAccess(req => {
 *     return (req.body.accountIds || []).map((id: string) =>
 *       getMailboxEmailForAccount(parseInt(id))
 *     );
 *   }), handler);
 *
 * getTargetMailboxes: extract the list of target mailbox emails from the request.
 * Any empty strings returned are skipped (unconfigured accounts are denied elsewhere).
 */
export function requireMailboxAccess(
  getTargetMailboxes: (req: Request) => string[]
) {
  return function (req: Request, res: Response, next: NextFunction): void {
    const user = req.session?.user;
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const targets = getTargetMailboxes(req).filter(Boolean);

    for (const target of targets) {
      if (!canAccessMailbox(user.email, target)) {
        process.stdout.write(
          `[MAILBOX-DENIED] user=${user.email} mailbox=${target} path=${req.path} method=${req.method}\n`
        );
        res.status(403).json({
          error: `Access denied: you are not authorized to access mailbox ${target}`,
        });
        return;
      }
    }

    next();
  };
}
