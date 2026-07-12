import nodemailer from "nodemailer";
import type Mail from "nodemailer/lib/mailer";
import type { PlatformSmtpConfig } from "../config/types.ts";

export type InvitationMail = {
  readonly invitationId: string;
  readonly recipient: string;
  readonly activationUrl: string;
};

export interface PlatformMailTransport {
  checkHealth(): Promise<void>;
  sendInvitation(input: InvitationMail): Promise<void>;
  close(): void;
}

type SendMail = (message: Mail.Options) => Promise<unknown>;
type Verify = () => Promise<unknown>;

export function createPlatformMailTransport(options: {
  readonly config: PlatformSmtpConfig;
  readonly sendMail?: SendMail;
  readonly verify?: Verify;
}): PlatformMailTransport {
  const transport = options.sendMail ? undefined : nodemailer.createTransport({
    host: options.config.host,
    port: options.config.port,
    secure: options.config.secure,
    requireTLS: options.config.requireTls,
    auth: options.config.username ? { user: options.config.username, pass: options.config.password } : undefined
  });
  const sendMail = options.sendMail ?? transport!.sendMail.bind(transport);
  const verify = options.verify ?? transport?.verify.bind(transport);
  return Object.freeze({
    async checkHealth() {
      if (!verify) throw new Error("PLATFORM_SMTP_HEALTH_UNAVAILABLE");
      await verify();
    },
    async sendInvitation(input: InvitationMail) {
      assertMail(input);
      const escapedUrl = escapeHtml(input.activationUrl);
      await sendMail({
        from: options.config.from,
        to: input.recipient,
        subject: "PDF Approval invitation",
        messageId: `<invitation-${input.invitationId}@pdf-approval.local>`,
        text: `Open this invitation link to continue:\n${input.activationUrl}`,
        html: `<p>Open this invitation link to continue:</p><p><a href="${escapedUrl}">${escapedUrl}</a></p>`
      });
    },
    close() { transport?.close(); }
  });
}

function assertMail(input: InvitationMail) {
  if (!input || !/^[0-9a-f-]{36}$/.test(input.invitationId) ||
      typeof input.recipient !== "string" || !input.recipient || /[\r\n]/.test(input.recipient) ||
      typeof input.activationUrl !== "string" || !/^https?:\/\//.test(input.activationUrl) || /[\r\n]/.test(input.activationUrl)) {
    throw new Error("INVALID_INVITATION_MAIL");
  }
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
