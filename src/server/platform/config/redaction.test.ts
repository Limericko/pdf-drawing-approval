import { describe, expect, it } from "vitest";
import { redactConfigError, redactConfigText } from "./redaction.ts";

describe("platform config redaction", () => {
  it("redacts URL-encoded and decoded PostgreSQL passwords", () => {
    const encodedPassword = "p%40ss%3Aword%2Fvalue";
    const decodedPassword = "p@ss:word/value";
    const databaseUrl = `postgresql://platform_web:${encodedPassword}@db.example/platform`;
    const env = { PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL: databaseUrl };
    const output = redactConfigError(
      new Error(`connection failed: ${databaseUrl}; password=${decodedPassword}`),
      env
    );

    expect(output).toContain("connection failed");
    expect(output).not.toContain(encodedPassword);
    expect(output).not.toContain(decodedPassword);
    expect(output).not.toContain(databaseUrl);
  });

  it("redacts S3, SMTP and keyring values including nested key material", () => {
    const keyMaterial = Buffer.alloc(32, 7).toString("base64");
    const keyringJson = JSON.stringify({ currentVersion: "v1", keys: { v1: keyMaterial } });
    const env = {
      PDF_APPROVAL_STORAGE_S3_SECRET_KEY: "s3/$ecret@value",
      PDF_APPROVAL_SMTP_PASSWORD: "smtp:p@ss/value",
      PDF_APPROVAL_TOTP_KEYRING: keyringJson
    };
    const output = redactConfigText(
      `s3/$ecret@value smtp:p@ss/value ${keyringJson} ${keyMaterial}`,
      env
    );

    expect(output).not.toContain("s3/$ecret@value");
    expect(output).not.toContain("smtp:p@ss/value");
    expect(output).not.toContain(keyringJson);
    expect(output).not.toContain(keyMaterial);
  });

  it("keeps stable error codes and field names", () => {
    expect(redactConfigError(new Error("PLATFORM_CONFIG_INVALID:PDF_APPROVAL_STORAGE_DRIVER"))).toBe(
      "PLATFORM_CONFIG_INVALID:PDF_APPROVAL_STORAGE_DRIVER"
    );
  });

  it("redacts every non-empty secret including one to three character values", () => {
    const encodedDatabasePassword = "p%40";
    const decodedDatabasePassword = "p@";
    const databaseUrl = `postgresql://platform_web:${encodedDatabasePassword}@db.example/platform`;
    const shortSecrets = [decodedDatabasePassword, "x", "yz", "abc"];
    const env = {
      PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL: databaseUrl,
      PDF_APPROVAL_STORAGE_S3_SECRET_KEY: shortSecrets[1],
      PDF_APPROVAL_SMTP_PASSWORD: shortSecrets[2],
      PDF_APPROVAL_STORAGE_S3_ACCESS_KEY: shortSecrets[3]
    };
    const output = redactConfigText(
      `url=${databaseUrl}; encoded=${encodedDatabasePassword}; decoded=${decodedDatabasePassword}; one=${shortSecrets[1]}; two=${shortSecrets[2]}; three=${shortSecrets[3]}`,
      env
    );

    expect(shortSecrets.some((secret) => output.includes(secret))).toBe(false);
    expect(output.includes(encodedDatabasePassword)).toBe(false);
    expect(output).toContain("one=[REDACTED]");
    expect(output).toContain("two=[REDACTED]");
    expect(output).toContain("three=[REDACTED]");
  });

  it("preserves stable error and environment identifiers while redacting a one-character value", () => {
    const output = redactConfigText(
      "PLATFORM_CONFIG_INVALID:PDF_APPROVAL_STORAGE_DRIVER password=P",
      { PDF_APPROVAL_SMTP_PASSWORD: "P" }
    );

    expect(output).toContain("PLATFORM_CONFIG_INVALID:PDF_APPROVAL_STORAGE_DRIVER");
    expect(output).toContain("password=[REDACTED]");
    expect(output.includes("password=P")).toBe(false);
  });
});
