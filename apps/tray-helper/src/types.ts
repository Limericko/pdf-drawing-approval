export type UserRole = "admin" | "designer" | "supervisor" | "process";

export type TrayUser = {
  id: number;
  username: string;
  role: UserRole;
  displayName: string;
};

export type TraySummary = {
  serverTime: string;
  user: TrayUser;
  tasks: {
    pendingCount: number;
    latestIds: number[];
    latest: Array<{
      id: number;
      projectName: string;
      partName: string;
      version: string;
      submittedAt: string;
      href: string;
    }>;
  };
  admin: {
    overallStatus: "ok" | "warning" | "error";
    riskCount: number;
  } | null;
};
