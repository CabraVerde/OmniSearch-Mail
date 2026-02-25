/**
 * adminGuard.ts — Admin route protection middleware.
 *
 * Security model:
 * 1. User must be authenticated.
 * 2. User's email must be in the ADMIN_EMAILS allowlist (env var).
 * 3. Request IP must match ADMIN_ALLOWED_IPS (env var) — enforces VPN requirement.
 *
 * All attempts (success and failure) are written to an append-only audit log.
 *
 * IMPORTANT — IP detection & proxy configuration:
 * ─────────────────────────────────────────────────
 * IP detection uses Express's req.ip, which respects the "trust proxy" setting.
 *
 * If this server runs DIRECTLY on the internet (no reverse proxy):
 *   - Do NOT set TRUST_PROXY=1. req.ip will always be the real socket address.
 *
 * If this server runs BEHIND a trusted reverse proxy (nginx, ELB, Cloudflare, etc.):
 *   - Set TRUST_PROXY=1 in environment AND set `app.set("trust proxy", 1)` in index.ts.
 *   - With this setting Express reads X-Forwarded-For from the LAST hop only.
 *   - NEVER trust X-Forwarded-For without a real proxy in front — clients can spoof it.
 *
 * For VPN enforcement:
 *   - ADMIN_ALLOWED_IPS should be the VPN server's exit IP or internal network CIDR.
 *   - If users connect through VPN to an internal network, use the internal VPN IP range.
 *   - Example: ADMIN_ALLOWED_IPS=10.8.0.1,10.8.0.2
 */

import type { Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";

// ── Env var parsers ──────────────────────────────────────────────────────────

function getAdminEmails(): string[] {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function getAdminIps(): string[] {
  return (process.env.ADMIN_ALLOWED_IPS || "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);
}

// ── Audit logging ────────────────────────────────────────────────────────────

interface AuditEvent {
  type: "admin_access" | "admin_denied";
  email: string | null;
  ip: string;
  method: string;
  path: string;
  reason?: string;
}

/**
 * auditLog — Appends a single JSON line to the audit log file.
 *
 * SECURITY NOTE: Only email, IP, path, and denial reason are logged.
 * Tokens, passwords, request bodies, and credential values are NEVER logged.
 *
 * Configure path with AUDIT_LOG_PATH env var (default: audit.log in cwd).
 * In production, rotate this file with logrotate or ship to a SIEM.
 */
function auditLog(event: AuditEvent): void {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    ...event,
  });

  const logPath = path.resolve(
    process.env.AUDIT_LOG_PATH || "audit.log"
  );

  try {
    fs.appendFileSync(logPath, entry + "\n", { encoding: "utf8", flag: "a" });
  } catch (writeErr) {
    // If we can't write the audit log, emit to stderr — never silently drop events.
    process.stderr.write(
      `[AUDIT-FAIL] Could not write to ${logPath}: ${entry}\n`
    );
  }

  // Also emit to server stdout for real-time visibility in container logs.
  process.stdout.write(`[ADMIN-AUDIT] ${entry}\n`);
}

// ── Middleware ───────────────────────────────────────────────────────────────

/**
 * requireAdmin — Enforces admin auth + VPN IP check.
 * Apply ONLY to /admin/* routes. Normal routes must NOT use this middleware.
 *
 * Failure always returns 403 (not 401) to avoid leaking whether a route exists.
 */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Express populates req.ip from the socket or trusted proxy header,
  // depending on the "trust proxy" app setting.
  const clientIp = req.ip || req.socket.remoteAddress || "unknown";
  const userEmail = (req.session?.user?.email ?? "").toLowerCase();
  const adminEmails = getAdminEmails();
  const allowedIps = getAdminIps();
  const eventBase = { email: userEmail || null, ip: clientIp, method: req.method, path: req.path };

  // Check 1 — authenticated
  if (!req.session?.user) {
    auditLog({ type: "admin_denied", ...eventBase, email: null, reason: "not_authenticated" });
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // Check 2 — email is in admin allowlist
  if (!adminEmails.includes(userEmail)) {
    auditLog({ type: "admin_denied", ...eventBase, reason: "not_admin_email" });
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // Check 3 — IP is in VPN allowlist (only enforced if ADMIN_ALLOWED_IPS is set)
  if (allowedIps.length > 0 && !allowedIps.includes(clientIp)) {
    auditLog({ type: "admin_denied", ...eventBase, reason: "ip_not_in_vpn_allowlist" });
    res.status(403).json({ error: "Forbidden – admin access requires VPN" });
    return;
  }

  // All checks passed — log successful admin access
  auditLog({ type: "admin_access", ...eventBase });
  next();
}

/**
 * isAdminUser — Returns true if the session user is an admin.
 * Used to conditionally expose admin UI data in regular API responses.
 */
export function isAdminUser(req: Request): boolean {
  return req.session?.user?.isAdmin === true;
}
