import { writeSync } from "node:fs";
import path from "node:path";
import express, { type RequestHandler } from "express";
import { createCsrfProtection } from "./security/csrf.ts";
import { createIdentityRoutes } from "../modules/identity/routes/identityRoutes.ts";
import { createApprovalRoutes } from "../modules/approvals/routes/approvalRoutes.ts";
import { createTaskRoutes } from "../modules/tasks/routes/taskRoutes.ts";
import { createPdmRoutes } from "../modules/pdm/routes/pdmRoutes.ts";
import { createStorageRoutes } from "./storage/storageRoutes.ts";
import { createSignatureRoutes } from "../modules/signatures/routes/signatureRoutes.ts";
import { createIssueRoutes } from "../modules/issues/routes/issueRoutes.ts";
import { createAdministrationRoutes } from "../modules/administration/routes/administrationRoutes.ts";
import { createPrintArchiveRoutes } from "../modules/approvals/routes/printArchiveRoutes.ts";
import { createWebDavSyncRoutes } from "../modules/sync/routes/webDavSyncRoutes.ts";
import { createErrorMiddleware, type EmergencySink } from "./http/errorMiddleware.ts";
import { HttpProblem } from "./http/problemResponse.ts";
import { requestContext } from "./http/requestContext.ts";
import { createPlatformHealthRouter, type PlatformHealthOptions } from "./health.ts";
import type { WebPlatformConfig } from "./config/types.ts";

type IdentityServices = Parameters<typeof createIdentityRoutes>[0]["services"];
type ApprovalService = Parameters<typeof createApprovalRoutes>[0]["approvals"];
type TaskService = Parameters<typeof createTaskRoutes>[0]["tasks"];
type PdmService = Parameters<typeof createPdmRoutes>[0]["pdm"];
type StorageObjectService = Parameters<typeof createStorageRoutes>[0]["storageObjects"];
type StorageAccessService = Parameters<typeof createStorageRoutes>[0]["storageAccess"];
type SignatureService = Parameters<typeof createSignatureRoutes>[0]["signatures"];
type IssueService = Parameters<typeof createIssueRoutes>[0]["issues"];
type AdministrationService = Parameters<typeof createAdministrationRoutes>[0]["administration"];
type PrintArchiveService = Parameters<typeof createPrintArchiveRoutes>[0]["printArchive"];
type WebDavSyncService = Parameters<typeof createWebDavSyncRoutes>[0]["webDavSync"];
type SecurityLogger = Parameters<typeof createErrorMiddleware>[0]["logger"];

export type CreatePlatformServerOptions = {
  readonly config: WebPlatformConfig;
  readonly services: IdentityServices & {
    readonly approvals: ApprovalService;
    readonly tasks: TaskService;
    readonly pdm: PdmService;
    readonly storageObjects: StorageObjectService;
    readonly storageAccess: StorageAccessService;
    readonly signatures: SignatureService;
    readonly issues: IssueService;
    readonly administration: AdministrationService;
    readonly printArchive: PrintArchiveService;
    readonly webDavSync: WebDavSyncService;
  };
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
  app.use("/api/v2/projects", createApprovalRoutes({
    approvals: options.services.approvals,
    sessions: options.services.sessions,
    publicBaseUrl: options.config.publicBaseUrl,
    cookie: {
      name: options.config.environment === "production" ? "__Host-pdf_approval_session" : "platform_session",
      secure: options.config.session.cookieSecure
    },
    csrf: createCsrfProtection({ keyring: options.config.keyrings.csrfHmac })
  }));
  app.use("/api/v2/tasks", createTaskRoutes({
    tasks: options.services.tasks,
    sessions: options.services.sessions,
    cookie: {
      name: options.config.environment === "production" ? "__Host-pdf_approval_session" : "platform_session",
      secure: options.config.session.cookieSecure
    }
  }));
  app.use("/api/v2/storage", createStorageRoutes({
    storageObjects: options.services.storageObjects,
    storageAccess: options.services.storageAccess,
    sessions: options.services.sessions,
    publicBaseUrl: options.config.publicBaseUrl,
    cookie: {
      name: options.config.environment === "production" ? "__Host-pdf_approval_session" : "platform_session",
      secure: options.config.session.cookieSecure
    },
    csrf: createCsrfProtection({ keyring: options.config.keyrings.csrfHmac })
  }));
  app.use("/api/v2/signature", createSignatureRoutes({
    signatures: options.services.signatures,
    sessions: options.services.sessions,
    publicBaseUrl: options.config.publicBaseUrl,
    cookie: {
      name: options.config.environment === "production" ? "__Host-pdf_approval_session" : "platform_session",
      secure: options.config.session.cookieSecure
    },
    csrf: createCsrfProtection({ keyring: options.config.keyrings.csrfHmac })
  }));
  app.use("/api/v2/projects", createIssueRoutes({
    issues: options.services.issues,
    sessions: options.services.sessions,
    publicBaseUrl: options.config.publicBaseUrl,
    cookie: {
      name: options.config.environment === "production" ? "__Host-pdf_approval_session" : "platform_session",
      secure: options.config.session.cookieSecure
    },
    csrf: createCsrfProtection({ keyring: options.config.keyrings.csrfHmac })
  }));
  app.use("/api/v2/administration", createAdministrationRoutes({
    administration: options.services.administration,
    sessions: options.services.sessions,
    publicBaseUrl: options.config.publicBaseUrl,
    cookie: {
      name: options.config.environment === "production" ? "__Host-pdf_approval_session" : "platform_session",
      secure: options.config.session.cookieSecure
    },
    csrf: createCsrfProtection({ keyring: options.config.keyrings.csrfHmac })
  }));
  app.use("/api/v2/projects", createPrintArchiveRoutes({
    printArchive: options.services.printArchive,
    sessions: options.services.sessions,
    publicBaseUrl: options.config.publicBaseUrl,
    cookie: {
      name: options.config.environment === "production" ? "__Host-pdf_approval_session" : "platform_session",
      secure: options.config.session.cookieSecure
    },
    csrf: createCsrfProtection({ keyring: options.config.keyrings.csrfHmac })
  }));
  app.use("/api/v2/projects", createPdmRoutes({
    pdm: options.services.pdm,
    sessions: options.services.sessions,
    publicBaseUrl: options.config.publicBaseUrl,
    cookie: {
      name: options.config.environment === "production" ? "__Host-pdf_approval_session" : "platform_session",
      secure: options.config.session.cookieSecure
    },
    csrf: createCsrfProtection({ keyring: options.config.keyrings.csrfHmac })
  }));
  app.use("/api/v2/webdav-sync", createWebDavSyncRoutes({
    webDavSync: options.services.webDavSync,
    sessions: options.services.sessions,
    publicBaseUrl: options.config.publicBaseUrl,
    cookie: {
      name: options.config.environment === "production" ? "__Host-pdf_approval_session" : "platform_session",
      secure: options.config.session.cookieSecure
    },
    csrf: createCsrfProtection({ keyring: options.config.keyrings.csrfHmac })
  }));
  app.use("/api", (_request, _response, next) => {
    next(new HttpProblem(404, "ROUTE_NOT_FOUND", "Not found"));
  });
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
      if (error) next(error);
    });
  });
  app.use(createErrorMiddleware({ logger: options.logger, emergencySink: options.emergencySink }));
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
