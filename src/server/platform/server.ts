import { writeSync } from "node:fs";
import path from "node:path";
import express, { type RequestHandler } from "express";
import { createIdentityRoutes } from "../modules/identity/routes/identityRoutes.ts";
import { createErrorMiddleware, type EmergencySink } from "./http/errorMiddleware.ts";
import { HttpProblem } from "./http/problemResponse.ts";
import { requestContext } from "./http/requestContext.ts";
import { createPlatformHealthRouter, type PlatformHealthOptions } from "./health.ts";
import type { WebPlatformConfig } from "./config/types.ts";

type IdentityServices = Parameters<typeof createIdentityRoutes>[0]["services"];
type SecurityLogger = Parameters<typeof createErrorMiddleware>[0]["logger"];

export type CreatePlatformServerOptions = {
  readonly config: WebPlatformConfig;
  readonly services: IdentityServices;
  readonly health: PlatformHealthOptions;
  readonly logger: SecurityLogger;
  readonly emergencySink: EmergencySink;
  readonly clientDist?: string;
};

type EmergencyOutput = { write(line: string): unknown };

export function createPlatformEmergencySink(
  output: EmergencyOutput = { write: (line) => writeSync(process.stderr.fd, line) }
): EmergencySink {
  return (event) => {
    try {
      output.write(`${JSON.stringify({ level: "fatal", code: event.code, requestId: event.requestId })}\n`);
    } catch {
      // This is the final fallback. Recursive reporting would create another logging path.
    }
  };
}

export function createPlatformSecurityLogger(output: EmergencyOutput = process.stderr): SecurityLogger {
  return Object.freeze({
    error(event) {
      output.write(`${JSON.stringify({ level: "error", code: event.code, requestId: event.requestId,
        ...(event.userId ? { userId: event.userId } : {}) })}\n`);
    }
  });
}

export function createPlatformServer(options: CreatePlatformServerOptions) {
  if (!options?.config || !options.services || !options.health || !options.logger ||
      typeof options.emergencySink !== "function") throw new Error("PLATFORM_SERVER_OPTIONS_INVALID");
  const app = express();
  app.set("trust proxy", options.config.trustedProxy);
  app.use(requestContext());
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/v2", createIdentityRoutes({
    config: {
      publicBaseUrl: options.config.publicBaseUrl,
      environment: options.config.environment,
      cookieName: "platform_session",
      cookieSecure: options.config.session.cookieSecure
    },
    csrfKeyring: options.config.keyrings.csrfHmac,
    services: options.services,
    logger: options.logger
  }));
  app.use("/api", (_request, _response, next) => {
    next(new HttpProblem(404, "ROUTE_NOT_FOUND", "Not found"));
  });
  app.use(createErrorMiddleware({ logger: options.logger, emergencySink: options.emergencySink }));

  const clientDist = path.resolve(options.clientDist ?? "dist/client");
  const staticClient = express.static(clientDist, { fallthrough: true, index: false });
  app.use(skipOperationalPaths(staticClient));
  app.use(createPlatformHealthRouter(options.health));
  app.get("*", (request, response, next) => {
    if (isOperationalPath(request.path)) {
      next();
      return;
    }
    response.sendFile(path.join(clientDist, "index.html"), (error) => {
      if (error) next();
    });
  });
  return app;
}

function skipOperationalPaths(staticClient: RequestHandler): RequestHandler {
  return (request, response, next) => {
    if (isOperationalPath(request.path)) {
      next();
      return;
    }
    staticClient(request, response, next);
  };
}

function isOperationalPath(requestPath: string) {
  return requestPath === "/health" || requestPath.startsWith("/health/") ||
    requestPath === "/api" || requestPath.startsWith("/api/");
}
