import nodemailer from "nodemailer";
import type Mail from "nodemailer/lib/mailer";

export type SmtpSettings = {
  smtp_host?: string;
  smtp_port?: string;
  smtp_user?: string;
  smtp_password?: string;
  smtp_from?: string;
};

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
};

export type MailTransport = Pick<Mail, "sendMail">;

export function createTransport(settings: SmtpSettings): MailTransport | null {
  if (!settings.smtp_host || !settings.smtp_user || !settings.smtp_password) return null;

  return nodemailer.createTransport({
    host: settings.smtp_host,
    port: Number(settings.smtp_port ?? 465),
    secure: Number(settings.smtp_port ?? 465) === 465,
    auth: {
      user: settings.smtp_user,
      pass: settings.smtp_password
    }
  });
}

export async function sendEmail(transport: MailTransport | null, settings: SmtpSettings, message: EmailMessage) {
  if (!transport) return { sent: false, reason: "smtp_not_configured" as const };

  await transport.sendMail({
    from: settings.smtp_from || settings.smtp_user,
    to: message.to,
    subject: message.subject,
    html: message.html
  });

  return { sent: true as const };
}

export async function sendTestEmail(settings: SmtpSettings, to: string, transport?: MailTransport | null) {
  const resolvedTransport = transport === undefined ? createTransport(settings) : transport;

  return sendEmail(resolvedTransport, settings, {
    to,
    subject: "PDF 审批系统测试邮件",
    html: `
      <p>这是一封 PDF 审批系统测试邮件。</p>
      <p>如果你收到此邮件，说明当前 SMTP 配置可以正常发送通知。</p>
    `
  });
}
