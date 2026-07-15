import { z } from "zod";
import type { VersionedKeyring, PlatformSmtpConfig } from "../config/types.ts";
import type { QueryExecutor } from "../database/queryExecutor.ts";
import { decryptSecret, encryptSecret } from "../security/secretEncryption.ts";

const smtpSchema = z.object({ host: z.string().trim().min(1).max(253), port: z.number().int().min(1).max(65535),
  from: z.string().email().max(254), secure: z.boolean(), requireTls: z.boolean(),
  username: z.string().max(254).optional(), password: z.string().max(1024).optional() }).strict();

type RuntimeSettingRow = { encrypted_value: Buffer; key_version: string };
export type StoredSmtpSettings = z.infer<typeof smtpSchema>;

export async function loadSmtpRuntimeSetting(executor: QueryExecutor,
  keyring: VersionedKeyring): Promise<PlatformSmtpConfig | undefined> {
  const result = await executor.query<RuntimeSettingRow>(
    "SELECT encrypted_value,key_version FROM platform.runtime_settings WHERE setting_key='smtp'"
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const plaintext = decryptSecret({ encryptedSecret: row.encrypted_value, keyVersion: row.key_version }, keyring);
  try {
    const parsed = smtpSchema.safeParse(JSON.parse(plaintext.toString("utf8")));
    if (!parsed.success) throw new Error("RUNTIME_SMTP_SETTING_INVALID");
    return { ...parsed.data, username: parsed.data.username, password: parsed.data.password };
  } finally {
    plaintext.fill(0);
  }
}

export async function saveSmtpRuntimeSetting(executor: QueryExecutor, keyring: VersionedKeyring,
  updatedByUserId: string, settings: StoredSmtpSettings) {
  const parsed = smtpSchema.parse(settings);
  const plaintext = Buffer.from(JSON.stringify(parsed), "utf8");
  const encrypted = encryptSecret(plaintext, keyring);
  try {
    await executor.query(
      `INSERT INTO platform.runtime_settings(setting_key,encrypted_value,key_version,updated_by_user_id,updated_at)
       VALUES ('smtp',$1,$2,$3,clock_timestamp())
       ON CONFLICT (setting_key) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value,
         key_version=EXCLUDED.key_version,updated_by_user_id=EXCLUDED.updated_by_user_id,
         updated_at=EXCLUDED.updated_at`,
      [encrypted.encryptedSecret, encrypted.keyVersion, updatedByUserId]
    );
  } finally {
    plaintext.fill(0);
    encrypted.encryptedSecret.fill(0);
  }
}

export function publicSmtpSetting(settings: PlatformSmtpConfig | undefined) {
  if (!settings || settings.enabled === false) return { configured: false as const, passwordConfigured: false };
  return { configured: true as const, host: settings.host, port: settings.port, from: settings.from,
    secure: settings.secure, requireTls: settings.requireTls, username: settings.username ?? "",
    passwordConfigured: Boolean(settings.password) };
}
