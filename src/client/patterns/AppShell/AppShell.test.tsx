import { FileText } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppNavigation } from "../../ui/navigation/index.tsx";
import { AppShell } from "./index.tsx";

describe("AppShell", () => {
  it("owns shell semantics while navigation receives pre-filtered items", () => {
    const html = renderToStaticMarkup(<AppShell collapsed={false} onToggleCollapsed={() => undefined}
      brand={{ name: "图纸协同", subtitle: "工程工作台", logoSrc: "/app-icon.png" }}
      user={{ displayName: "林工", roleLabel: "主管", compactRoleLabel: "主" }} onLogout={() => undefined}
      navigation={<AppNavigation currentId="tasks" collapsed={false} items={[
        { id: "tasks", href: "#/", label: "我的任务", icon: FileText }
      ]} />}>内容</AppShell>);
    expect(html).toContain('aria-label="主导航"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('href="#main-content"');
    expect(html).toContain("我的任务");
  });
});
