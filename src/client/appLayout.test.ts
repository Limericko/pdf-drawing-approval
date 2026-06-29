import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.resolve("src/client/App.tsx"), "utf8");

describe("app shell layout structure", () => {
  it("renders a collapsible sidebar with icon-only compact navigation", () => {
    expect(source).toContain("sidebarCollapsed");
    expect(source).toContain("app-layout--sidebar-collapsed");
    expect(source).toContain("sidebar-toggle");
    expect(source).toContain('src="/app-icon.png"');
    expect(source).toContain("navIconForRoute");
    expect(source).toContain("side-nav__icon");
    expect(source).not.toContain("compactNavLabel");
  });

  it("reuses route permission instead of repeating the same check across page branches", () => {
    expect(source).toContain("const routeAllowed =");
    expect(source.match(/routeAllowedForRole\(user, route\.name\)/g)?.length).toBe(2);
  });

  it("renders the self-service profile page route", () => {
    expect(source).toContain("ProfilePage");
    expect(source).toContain('route.name === "profile"');
    expect(source).toContain("onUserUpdated={setUser}");
  });

  it("checks client updates for every signed-in role and renders a client-only download banner", () => {
    expect(source).toContain("getClientUpdateInfo");
    expect(source).toContain("getDesktopClientVersion");
    expect(source).toContain("ClientUpdateBanner");
    expect(source).not.toContain('if (!user || user.role === "admin")');
    expect(source).toContain("clientInstaller");
    expect(source).not.toContain("serverInstallerUrl");
  });

  it("renders desktop startup update progress outside the signed-in workflow", () => {
    expect(source).toContain("DesktopUpdateDialog");
    expect(source).toContain("getDesktopUpdateStatus");
    expect(source).toContain("onDesktopUpdateStatus");
    expect(source).toContain("openDownloadedUpdateInstaller");
    expect(source).toContain("desktopUpdateDialog");
    expect(source).toContain("<LoginPage onLogin={setUser}");
    expect(source).toContain("{desktopUpdateDialog}");
  });

  it("lazy loads authenticated business pages and preloads them from navigation", () => {
    expect(source).toContain("lazy(");
    expect(source).toContain("<Suspense fallback={<PageLoadingFallback");
    expect(source).toContain("const pageLoaders");
    expect(source).toContain("function preloadRoute");
    expect(source).toContain("onMouseEnter={() => preloadRoute(item.route)}");
    expect(source).toContain("onFocus={() => preloadRoute(item.route)}");
    expect(source).not.toContain('import { MyTasksPage } from "./pages/MyTasksPage.tsx"');
    expect(source).not.toContain('import { SettingsPage } from "./pages/SettingsPage.tsx"');
  });
});
