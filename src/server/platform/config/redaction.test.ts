import { describe, expect, it } from "vitest";
import { redactConfigError, redactConfigText } from "./redaction.ts";
import { PlatformConfigError } from "./types.ts";

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

  it("redacts WebDAV credential JSON and every nested username or password", () => {
    const json = JSON.stringify({ "secret/webdav/test": {
      username: "designer@example.test", password: "webdav-app-password"
    } });
    const output = redactConfigText(`failure ${json} designer@example.test webdav-app-password`, {
      PDF_APPROVAL_WEBDAV_CREDENTIALS_JSON: json
    });
    expect(output).not.toContain(json);
    expect(output).not.toContain("designer@example.test");
    expect(output).not.toContain("webdav-app-password");
  });

  it("rebuilds structured config errors from trusted fields instead of the message", () => {
    const error = new PlatformConfigError("PLATFORM_CONFIG_INVALID", "PDF_APPROVAL_STORAGE_DRIVER");
    error.message = "untrusted message password=local-only-password";

    expect(redactConfigError(error, { PDF_APPROVAL_SMTP_PASSWORD: "local-only-password" })).toBe(
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

  it("does not protect an environment-looking secret in a generic error", () => {
    const secret = "PDF_APPROVAL_SMTP_PASSWORD";
    const output = redactConfigError(new Error(`mail failed password=${secret}`), {
      PDF_APPROVAL_SMTP_PASSWORD: secret
    });

    expect(output.includes(secret)).toBe(false);
  });

  it("redacts URL userinfo with an empty username", () => {
    const encodedPassword = "p%40";
    const decodedPassword = "p@";
    const databaseUrl = `postgresql://:${encodedPassword}@db.example/platform`;
    const output = redactConfigText(`connection failed: ${databaseUrl}; decoded=${decodedPassword}`);

    expect([databaseUrl, encodedPassword, decodedPassword].some((secret) => output.includes(secret))).toBe(false);
  });

  it("chooses a marker that cannot reproduce a secret", () => {
    const secrets = ["[REDACTED]", "REDACTED"];

    for (const secret of secrets) {
      const output = redactConfigText(`password=${secret}`, { PDF_APPROVAL_SMTP_PASSWORD: secret });
      expect(output.includes(secret)).toBe(false);
    }
  });
});
