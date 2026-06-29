import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { renderConsoleHtml } = require("../../apps/server-exe/serverConsoleView.cjs");

describe("server exe console view", () => {
  it("renders service status, port settings, URLs, and runtime directories", () => {
    const html = renderConsoleHtml({
      state: "running",
      message: "服务已启动，端口 18080",
      effectivePort: 18080,
      savedPort: 18080,
      envPort: "",
      localUrl: "http://127.0.0.1:18080",
      lanUrl: "http://192.168.1.20:18080",
      dataDir: "D:\\PDF审批\\data",
      backupDir: "D:\\PDF审批\\backups",
      logDir: "D:\\PDF审批\\logs",
      releaseDir: "D:\\PDF审批\\releases",
      configPath: "D:\\PDF审批\\server-config.json",
      lastConfigMessage: "端口已保存"
    });

    expect(html).toContain("PDF 图纸审批服务端");
    expect(html).toContain("运行中");
    expect(html).toContain("启动设置");
    expect(html).toContain('name="port"');
    expect(html).toContain("保存并重启");
    expect(html).toContain("http://127.0.0.1:18080");
    expect(html).toContain("http://192.168.1.20:18080");
    expect(html).toContain("运行目录");
    expect(html).toContain("D:\\PDF审批\\releases");
    expect(html).toContain("D:\\PDF审批\\server-config.json");
    expect(html).toContain("data-directory");
    expect(html).toContain('data-directory="releases"');
    expect(html).toContain("隐藏窗口");
    expect(html).toContain("data-hide-window");
    expect(html).toContain("window.serverConsole.hideWindow()");
    expect(html).toContain("复制客户端地址");
    expect(html).toContain("给同事填写");
    expect(html).toContain("局域网地址");
    expect(html).toContain("更新发布");
    expect(html).toContain("复制清单地址");
    expect(html).toContain("http://192.168.1.20:18080/updates/latest.json");
    expect(html).toContain("无需在网页端填写更新清单地址");
    expect(html).toContain("data-copy-label=\"复制清单地址\"");
  });

  it("renders port occupied errors clearly", () => {
    const html = renderConsoleHtml({
      state: "error",
      message: "端口 8080 已被占用",
      effectivePort: 8080,
      savedPort: 8080,
      envPort: "",
      localUrl: "http://127.0.0.1:8080",
      lanUrl: "",
      dataDir: "",
      backupDir: "",
      logDir: "",
      releaseDir: "",
      configPath: "",
      lastConfigMessage: ""
    });

    expect(html).toContain("启动失败");
    expect(html).toContain("端口 8080 已被占用");
  });
});
