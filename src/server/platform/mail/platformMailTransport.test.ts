import { describe, expect, it, vi } from "vitest";
import type Mail from "nodemailer/lib/mailer";
import { createPlatformMailTransport } from "./platformMailTransport.ts";

describe("PlatformMailTransport", () => {
  it("verifies SMTP health through the transport without sending mail", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "unused" }));
    const verify = vi.fn(async () => true as const);
    const transport = createPlatformMailTransport({
      config: {
        host: "127.0.0.1", port: 51025, from: "pdf-approval@local.test",
        secure: false, requireTls: false, username: undefined, password: undefined
      },
      sendMail,
      verify
    });

    await expect(transport.checkHealth()).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledOnce();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("sends a stable, escaped invitation message without leaking the token into headers", async () => {
    const sendMail = vi.fn(async (_message: Mail.Options) => ({ messageId: "accepted" }));
    const transport = createPlatformMailTransport({
      config: {
        host: "127.0.0.1", port: 51025, from: "pdf-approval@local.test",
        secure: false, requireTls: false, username: undefined, password: undefined
      },
      sendMail
    });

    await transport.sendInvitation({
      invitationId: "01890f1e-9b4a-7cc2-8f00-000000000053",
      recipient: "invitee@example.test",
      activationUrl: "https://approval.example/#/accept-invitation?token=secret%26value"
    });

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: "invitee@example.test",
      messageId: "<invitation-01890f1e-9b4a-7cc2-8f00-000000000053@pdf-approval.local>"
    }));
    const message = sendMail.mock.calls[0]![0];
    expect(message.html).toContain("secret%26value");
    expect(message.html).not.toContain("<script");
    expect(message.subject).not.toContain("secret");
  });
});
