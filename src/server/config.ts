import path from "node:path";

export type AppConfig = {
  port: number;
  dataDir: string;
  databasePath: string;
  jwtSecret: string;
  releaseDir?: string;
};

export const defaultJwtSecret = "change-this-before-production";

export function loadConfig(): AppConfig {
  const dataDir = process.env.PDF_APPROVAL_DATA_DIR ?? path.resolve("data");

  return {
    port: Number(process.env.PORT ?? 8080),
    dataDir,
    databasePath: process.env.PDF_APPROVAL_DB ?? path.join(dataDir, "pdf-approval.sqlite"),
    jwtSecret: process.env.PDF_APPROVAL_JWT_SECRET ?? defaultJwtSecret,
    releaseDir: process.env.PDF_APPROVAL_RELEASE_DIR ?? path.resolve("dist")
  };
}
