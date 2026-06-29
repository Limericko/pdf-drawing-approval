import type { ApprovalRepository } from "../repositories/approvals.ts";
import type { OperationLogRepository } from "../repositories/operationLogs.ts";
import type { SettingsRepository } from "../repositories/settings.ts";
import { defaultNotificationPreferencesForRole, type UserPreferenceRepository } from "../repositories/userPreferences.ts";
import type { UserRepository } from "../repositories/users.ts";
import type { MailTransport } from "./email.ts";
import { notifyApprovalEvent } from "./approvalNotifications.ts";

export async function notifyApprovalCreated(
  approvalId: number,
  deps: {
    approvals: ApprovalRepository;
    users: UserRepository;
    settings: SettingsRepository;
    userPreferences?: Pick<UserPreferenceRepository, "getForUser">;
    operationLogs?: OperationLogRepository;
    transport?: MailTransport | null;
  }
) {
  return notifyApprovalEvent({
    event: "reviewTaskCreated",
    approvalId,
    approvals: deps.approvals,
    users: deps.users,
    userPreferences: deps.userPreferences ?? {
      getForUser: (user) => ({
        userId: user.id,
        commonProjects: [],
        notificationPreferences: defaultNotificationPreferencesForRole(user.role),
        updatedAt: null
      })
    },
    settings: deps.settings,
    operationLogs: deps.operationLogs,
    transport: deps.transport
  });
}
