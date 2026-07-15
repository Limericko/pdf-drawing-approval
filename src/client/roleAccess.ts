import type { User } from "./api.ts";

export type AppRouteName =
  | "tasks"
  | "submit"
  | "signature"
  | "profile"
  | "approvals"
  | "settings"
  | "pdm"
  | "pdmPending"
  | "detail"
  | "pdmDetail";

export type NavItem = {
  href: string;
  label: string;
  route: AppRouteName;
};

export function navigationForRole(user: Pick<User, "role">): NavItem[] {
  if (user.role === "designer") {
    return [
      { href: "#/submit", label: "提交图纸", route: "submit" },
      { href: "#/approvals", label: "全部图纸", route: "approvals" },
      { href: "#/pdm", label: "零件库", route: "pdm" },
      { href: "#/signature", label: "我的签名", route: "signature" },
      { href: "#/profile", label: "我的资料", route: "profile" }
    ];
  }

  if (user.role === "supervisor" || user.role === "process") {
    return [
      { href: "#/", label: "我的任务", route: "tasks" },
      { href: "#/approvals", label: "全部图纸", route: "approvals" },
      { href: "#/pdm", label: "零件库", route: "pdm" },
      { href: "#/signature", label: "我的签名", route: "signature" },
      { href: "#/profile", label: "我的资料", route: "profile" }
    ];
  }

  if (user.role === "admin") {
    return [
      { href: "#/settings", label: "系统管理", route: "settings" },
      { href: "#/approvals", label: "全部图纸", route: "approvals" },
      { href: "#/pdm", label: "零件库", route: "pdm" },
      { href: "#/profile", label: "我的资料", route: "profile" }
    ];
  }

  return [];
}

export function defaultRouteForRole(user: Pick<User, "role">): Exclude<AppRouteName, "detail" | "pdmDetail"> {
  if (user.role === "designer") return "submit";
  if (user.role === "supervisor" || user.role === "process") return "tasks";
  return "settings";
}

export function routeAllowedForRole(user: Pick<User, "role">, route: AppRouteName) {
  if (route === "detail") return routeAllowedForRole(user, "approvals");
  if (route === "pdmDetail") return routeAllowedForRole(user, "pdm");
  if (route === "pdmPending") return user.role === "admin" || user.role === "designer";
  return navigationForRole(user).some((item) => item.route === route);
}

export function routePath(route: Exclude<AppRouteName, "detail" | "pdmDetail">) {
  return {
    tasks: "#/",
    submit: "#/submit",
    signature: "#/signature",
    profile: "#/profile",
    approvals: "#/approvals",
    settings: "#/settings",
    pdm: "#/pdm",
    pdmPending: "#/pdm/pending-metadata"
  }[route];
}
