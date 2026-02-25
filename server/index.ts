import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import MemoryStore from "memorystore";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";

// ── Fail fast if SESSION_SECRET is not set ───────────────────────────────────
if (!process.env.SESSION_SECRET) {
  console.error("[FATAL] SESSION_SECRET environment variable is required.");
  process.exit(1);
}

const app = express();
const httpServer = createServer(app);

// ── Proxy trust ───────────────────────────────────────────────────────────────
// Set TRUST_PROXY=1 ONLY when running behind a known trusted reverse proxy.
// Without a proxy, leave TRUST_PROXY unset to prevent X-Forwarded-For spoofing.
// See server/middleware/adminGuard.ts for full explanation.
if (process.env.TRUST_PROXY === "1") {
  app.set("trust proxy", 1);
}

// ── Session store (in-memory, no DB required) ─────────────────────────────────
// memorystore prunes expired sessions automatically to prevent memory leaks.
// Sessions are ephemeral — users re-authenticate after server restart.
const MemStore = MemoryStore(session);
const SESSION_MAX_AGE = parseInt(process.env.SESSION_MAX_AGE_MS || "28800000", 10); // default 8 h

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,   // JS cannot read the cookie
      secure: process.env.NODE_ENV === "production", // HTTPS only in prod
      sameSite: "lax",  // CSRF mitigation for same-origin navigation
      maxAge: SESSION_MAX_AGE,
    },
    store: new MemStore({ checkPeriod: SESSION_MAX_AGE }),
  })
);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      // Skip logging response bodies for routes that return email content or binary data
      const suppressBody = path.startsWith("/api/query/run") ||
        path.startsWith("/api/attachments") ||
        path.startsWith("/api/download");
      if (capturedJsonResponse && !suppressBody) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
