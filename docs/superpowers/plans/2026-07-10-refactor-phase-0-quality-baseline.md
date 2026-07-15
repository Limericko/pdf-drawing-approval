# Phase 0 Quality Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为现有 0.9.2 系统建立隔离、可重复的真实浏览器基线，使后续云端、UI、PDF 和数据重构都能用同一组关键路径证明没有回归。

**Architecture:** Playwright 启动独立的 SQLite 测试服务端和 Vite 客户端，数据、PDF、签名和日志全部写入 `.cache/e2e`。测试通过可访问角色流程驱动 UI，不复用真实运行数据库，不在本阶段改变业务、认证或生产部署。

**Tech Stack:** Node.js 24, TypeScript, React 19, Vite 6, Express 4, built-in `node:sqlite`, pdf-lib, Vitest, Playwright Chromium, axe-core.

---

## Scope

本计划只交付 Phase 0：

- Playwright 和 axe 测试依赖。
- 确定性 E2E 服务端与数据种子。
- 登录、角色导航、审批列表、PDF 详情和响应式基线。
- PDF canvas 非空像素检查。
- 当前 UI 的截图和 critical 可访问性门禁。
- 分组验证命令和验证记录。

本计划不做：

- PostgreSQL、对象存储或 Docker。
- 邀请制账号、MFA 或 Cookie 会话。
- 新 UI 组件或页面重构。
- WebDAV。
- 生产打包、发布或迁移。

## File Map

- `package.json`: 增加 E2E scripts 和测试 devDependencies。
- `package-lock.json`: 锁定 Playwright 和 axe 依赖。
- `playwright.config.ts`: 定义隔离服务、桌面/手机项目、报告和截图路径。
- `tsconfig.e2e.json`: 单独类型检查 Playwright 配置、support 和 spec。
- `vite.config.ts`: 允许 E2E 覆盖 API proxy target。
- `src/client/viteConfig.test.ts`: 保护默认 proxy 和 E2E override。
- `e2e/support/fixtures.ts`: 角色账号、端口和缓存目录常量。
- `e2e/support/seed.ts`: 创建 PDF、签名、用户、设置和审批数据。
- `e2e/support/seed.unit.test.ts`: 验证测试数据完整且不依赖真实目录。
- `e2e/support/server.ts`: 启动隔离服务并处理退出信号。
- `e2e/support/login.ts`: 通过可访问控件登录角色。
- `e2e/smoke/login-navigation.spec.ts`: 登录和角色导航基线。
- `e2e/smoke/approval-workbench.spec.ts`: 审批详情和 PDF canvas 基线。
- `e2e/smoke/responsive-accessibility.spec.ts`: 手机溢出、critical axe 和视觉截图。
- `vitest.config.ts`: 包含 `e2e/**/*.unit.test.ts`，不把 Playwright spec 交给 Vitest。
- `docs/verification.md`: 记录 Phase 0 命令、环境和结果。

## Task 1: Install and Configure Playwright

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `playwright.config.ts`
- Create: `tsconfig.e2e.json`

- [ ] **Step 1: Install test-only dependencies**

Run:

```powershell
npm install --save-dev @playwright/test @axe-core/playwright
```

Expected: `package.json` and `package-lock.json` change; runtime `dependencies` remain unchanged.

- [ ] **Step 2: Add E2E scripts to `package.json`**

Add these script entries without changing existing commands:

```json
{
  "e2e:server": "tsx e2e/support/server.ts",
  "e2e:client": "vite --host 127.0.0.1 --port 14173 --strictPort",
  "e2e:typecheck": "tsc -p tsconfig.e2e.json",
  "e2e": "playwright test",
  "e2e:headed": "playwright test --headed",
  "e2e:update": "playwright test --update-snapshots"
}
```

- [ ] **Step 3: Create `playwright.config.ts`**

```ts
import { defineConfig, devices } from "@playwright/test";

const apiUrl = "http://127.0.0.1:18080";
const webUrl = "http://127.0.0.1:14173";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  outputDir: ".cache/e2e/test-results",
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}-{projectName}{ext}",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: ".cache/e2e/playwright-report", open: "never" }]],
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { animations: "disabled", maxDiffPixelRatio: 0.02 }
  },
  use: {
    baseURL: webUrl,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    colorScheme: "light",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: [
    {
      command: "npm run e2e:server",
      url: `${apiUrl}/health`,
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: "npm run e2e:client",
      url: webUrl,
      env: { PDF_APPROVAL_DEV_API_TARGET: apiUrl },
      reuseExistingServer: false,
      timeout: 30_000
    }
  ],
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } }
    }
  ]
});
```

- [ ] **Step 4: Create `tsconfig.e2e.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["node", "vitest/globals", "@playwright/test"],
    "noEmit": true
  },
  "include": ["e2e/**/*.ts", "playwright.config.ts"]
}
```

- [ ] **Step 5: Install the pinned Chromium runtime**

Run:

```powershell
npx playwright install chromium
```

Expected: command exits `0` and reports Chromium installed or already present.

- [ ] **Step 6: Verify the E2E config type checks before specs exist**

Run:

```powershell
npm run e2e:typecheck
npx playwright --version
```

Expected: both commands exit `0`; Playwright reports its installed version.

- [ ] **Step 7: Commit tooling**

```powershell
git add package.json package-lock.json playwright.config.ts tsconfig.e2e.json
git commit -m "test: add Playwright browser harness"
```

## Task 2: Build an Isolated E2E Data Seed

**Files:**
- Create: `e2e/support/fixtures.ts`
- Create: `e2e/support/seed.ts`
- Create: `e2e/support/seed.unit.test.ts`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Create shared constants in `e2e/support/fixtures.ts`**

```ts
import path from "node:path";

export const e2eRoot = path.resolve(".cache", "e2e", "runtime");
export const e2ePort = 18080;

export const e2eUsers = {
  admin: { username: "admin", password: "admin123", landingPath: "/settings" },
  supervisor: { username: "supervisor", password: "123456", landingPath: "/" },
  process: { username: "process", password: "123456", landingPath: "/" },
  designer: { username: "designer_e2e", password: "designer123", landingPath: "/submit" }
} as const;
```

- [ ] **Step 2: Write the seed test before implementation**

Create `e2e/support/seed.unit.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/server/db.ts";
import { ApprovalRepository } from "../../src/server/repositories/approvals.ts";
import { SignatureAssetRepository } from "../../src/server/repositories/signatureAssets.ts";
import { UserRepository } from "../../src/server/repositories/users.ts";
import { seedE2eData } from "./seed.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("seedE2eData", () => {
  it("creates isolated users, signatures, a valid PDF, and a pending approval", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-approval-e2e-"));
    roots.push(root);
    const seeded = await seedE2eData(root);
    const db = createDatabase(seeded.databasePath);
    const users = new UserRepository(db);
    const approvals = new ApprovalRepository(db);
    const signatures = new SignatureAssetRepository(db);

    const designer = users.findByUsername("designer_e2e");
    expect(designer?.role).toBe("designer");
    expect(signatures.getActiveForUser(designer!.id)).not.toBeNull();
    expect(approvals.getById(seeded.approvalId)?.partName).toBe("E2E轴承座");
    expect(fs.readFileSync(seeded.pdfPath).subarray(0, 4).toString()).toBe("%PDF");
    expect(seeded.databasePath.startsWith(root)).toBe(true);
    db.close();
  });
});
```

- [ ] **Step 3: Include only E2E unit files in Vitest**

Update `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "e2e/**/*.unit.test.ts"]
  }
});
```

- [ ] **Step 4: Run the new test and verify it fails**

Run:

```powershell
npm test -- --run e2e/support/seed.unit.test.ts
```

Expected: FAIL because `e2e/support/seed.ts` does not exist.

- [ ] **Step 5: Implement `seedE2eData`**

Create `e2e/support/seed.ts`:

```ts
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createDatabase } from "../../src/server/db.ts";
import { ApprovalRepository } from "../../src/server/repositories/approvals.ts";
import { SettingsRepository } from "../../src/server/repositories/settings.ts";
import { SignatureAssetRepository } from "../../src/server/repositories/signatureAssets.ts";
import { UserRepository } from "../../src/server/repositories/users.ts";
import { e2eUsers } from "./fixtures.ts";

const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLz9QAAAABJRU5ErkJggg==",
  "base64"
);

export type E2eSeedResult = {
  rootDir: string;
  dataDir: string;
  databasePath: string;
  watchRoot: string;
  pdfPath: string;
  approvalId: number;
};

export async function seedE2eData(rootDir: string): Promise<E2eSeedResult> {
  const dataDir = path.join(rootDir, "data");
  const watchRoot = path.join(rootDir, "watch");
  const signatureDir = path.join(dataDir, "signatures");
  const databasePath = path.join(dataDir, "pdf-approval.sqlite");
  const pdfPath = path.join(watchRoot, "E2E项目", "E2E轴承座-a0A0.pdf");
  await fs.mkdir(path.dirname(pdfPath), { recursive: true });
  await fs.mkdir(signatureDir, { recursive: true });

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([842, 595]);
  page.drawText("PDF APPROVAL E2E DRAWING", { x: 60, y: 520, size: 24, font });
  page.drawRectangle({ x: 120, y: 180, width: 420, height: 220, borderWidth: 2 });
  const pdfBytes = await pdf.save();
  await fs.writeFile(pdfPath, pdfBytes);

  const db = createDatabase(databasePath);
  const users = new UserRepository(db);
  const settings = new SettingsRepository(db);
  const approvals = new ApprovalRepository(db);
  const signatures = new SignatureAssetRepository(db);
  users.ensureDefaultUsers();
  const designer = users.create({
    username: e2eUsers.designer.username,
    password: e2eUsers.designer.password,
    role: "designer",
    displayName: "E2E设计师",
    email: "designer-e2e@example.com"
  });

  for (const username of ["supervisor", "process", designer.username]) {
    const user = users.findByUsername(username)!;
    const signaturePath = path.join(signatureDir, `${username}.png`);
    await fs.writeFile(signaturePath, transparentPng);
    signatures.createForUser({ userId: user.id, kind: "uploaded_png", filePath: signaturePath });
  }

  settings.set("watch_root", watchRoot);
  settings.set("app_base_url", "http://127.0.0.1:14173");
  const approval = approvals.create({
    projectName: "E2E项目",
    partName: "E2E轴承座",
    version: "a0A0",
    minorVersion: "a0",
    majorVersion: "A0",
    originalFilePath: pdfPath,
    currentFilePath: pdfPath,
    submittedBy: designer.username,
    submittedByUserId: designer.id,
    source: "web_upload",
    originalFileHash: createHash("sha256").update(pdfBytes).digest("hex"),
    signatureStatus: "not_required",
    documentCode: "E2EDOC0001",
    materialCode: "E2EMAT0001",
    drawingName: "E2E轴承座"
  });
  db.close();

  return { rootDir, dataDir, databasePath, watchRoot, pdfPath, approvalId: approval.id };
}
```

- [ ] **Step 6: Run the seed test**

Run:

```powershell
npm test -- --run e2e/support/seed.unit.test.ts
```

Expected: PASS, 1 test passed.

- [ ] **Step 7: Commit the seed**

```powershell
git add e2e/support/fixtures.ts e2e/support/seed.ts e2e/support/seed.unit.test.ts vitest.config.ts
git commit -m "test: add isolated browser test data"
```

## Task 3: Start the Isolated Server and Configurable Vite Proxy

**Files:**
- Create: `e2e/support/server.ts`
- Modify: `vite.config.ts`
- Modify: `src/client/viteConfig.test.ts`

- [ ] **Step 1: Add a failing proxy override test**

Replace `src/client/viteConfig.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import viteConfig, { resolveApiProxyTarget } from "../../vite.config.ts";

describe("vite dev server proxy", () => {
  it("does not proxy frontend modules whose filenames start with api", () => {
    const proxy = viteConfig.server?.proxy ?? {};
    expect(Object.keys(proxy)).not.toContain("/api");
    expect(proxy).toEqual(expect.objectContaining({ "/api/": "http://localhost:8080" }));
    expect(proxy).toEqual(expect.objectContaining({ "/health": "http://localhost:8080" }));
  });

  it("allows the isolated browser harness to override the backend target", () => {
    expect(resolveApiProxyTarget({ PDF_APPROVAL_DEV_API_TARGET: "http://127.0.0.1:18080" })).toBe("http://127.0.0.1:18080");
    expect(resolveApiProxyTarget({})).toBe("http://localhost:8080");
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```powershell
npm test -- --run src/client/viteConfig.test.ts
```

Expected: FAIL because `resolveApiProxyTarget` is not exported.

- [ ] **Step 3: Implement the proxy seam in `vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export function resolveApiProxyTarget(env: Record<string, string | undefined> = process.env) {
  return env.PDF_APPROVAL_DEV_API_TARGET ?? "http://localhost:8080";
}

const apiTarget = resolveApiProxyTarget();

export default defineConfig({
  plugins: [react()],
  root: "src/client",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true
  },
  server: {
    proxy: {
      "/api/": apiTarget,
      "/health": apiTarget
    }
  }
});
```

- [ ] **Step 4: Run the proxy test**

Run:

```powershell
npm test -- --run src/client/viteConfig.test.ts
```

Expected: PASS, 2 tests passed.

- [ ] **Step 5: Create `e2e/support/server.ts`**

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { startPdfApprovalServer } from "../../src/server/startServer.ts";
import { e2ePort, e2eRoot } from "./fixtures.ts";
import { seedE2eData } from "./seed.ts";

await fs.rm(e2eRoot, { recursive: true, force: true });
await fs.mkdir(e2eRoot, { recursive: true });
const seeded = await seedE2eData(e2eRoot);

process.env.NODE_ENV = "test";
process.env.PORT = String(e2ePort);
process.env.PDF_APPROVAL_DATA_DIR = seeded.dataDir;
process.env.PDF_APPROVAL_DB = seeded.databasePath;
process.env.PDF_APPROVAL_JWT_SECRET = "e2e-only-secret";
process.env.PDF_APPROVAL_RELEASE_DIR = path.join(e2eRoot, "releases");

const server = startPdfApprovalServer({
  host: "127.0.0.1",
  logRoot: path.join(e2eRoot, "logs"),
  backupRoot: path.join(e2eRoot, "backups"),
  tempUploadCleanup: false
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

- [ ] **Step 6: Verify the isolated runtime type checks**

Run:

```powershell
npm run e2e:typecheck
npm test -- --run src/client/viteConfig.test.ts e2e/support/seed.unit.test.ts
```

Expected: both commands exit `0`; the first real browser run in Task 4 will prove both web servers start and stop cleanly.

- [ ] **Step 7: Commit the isolated runtime**

```powershell
git add e2e/support/server.ts vite.config.ts src/client/viteConfig.test.ts
git commit -m "test: isolate browser test runtime"
```

## Task 4: Cover Login and Role Navigation

**Files:**
- Create: `e2e/support/login.ts`
- Create: `e2e/smoke/login-navigation.spec.ts`

- [ ] **Step 1: Create the login helper**

```ts
import { expect, type Page } from "@playwright/test";
import { e2eUsers } from "./fixtures.ts";

export type E2eRole = keyof typeof e2eUsers;

export async function loginAs(page: Page, role: E2eRole) {
  const account = e2eUsers[role];
  await page.goto("/");
  await page.getByLabel("账号").fill(account.username);
  await page.getByLabel("密码").fill(account.password);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.locator(".app-layout")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#${account.landingPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
}
```

- [ ] **Step 2: Add role navigation tests**

Create `e2e/smoke/login-navigation.spec.ts`:

```ts
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { loginAs } from "../support/login.ts";

test("admin lands on system management and sees admin navigation", async ({ page }) => {
  await loginAs(page, "admin");
  await expect(page.getByRole("link", { name: "系统管理" })).toHaveClass(/active/);
  await expect(page.getByRole("link", { name: "全部图纸" })).toBeVisible();
  await expect(page.getByRole("link", { name: "零件库" })).toBeVisible();
});

test("reviewer lands on the review queue", async ({ page }) => {
  await loginAs(page, "supervisor");
  await expect(page.getByRole("heading", { name: "我的待审图纸" })).toBeVisible();
  await expect(page.getByRole("link", { name: "待我审核" })).toHaveClass(/active/);
});

test("designer with a configured signature can open submission", async ({ page }) => {
  await loginAs(page, "designer");
  await expect(page.getByRole("link", { name: "提交图纸" })).toHaveClass(/active/);
  await expect(page.getByText("请先配置签名")).toHaveCount(0);
});

test("login has no critical accessibility violations", async ({ page }) => {
  await page.goto("/");
  const result = await new AxeBuilder({ page }).include("main").analyze();
  const critical = result.violations.filter((item) => item.impact === "critical");
  expect(critical, JSON.stringify(critical, null, 2)).toEqual([]);
});
```

Phase 2 replaces the class-only active contract by making `aria-current="page"` mandatory in `AppNavigation`.

- [ ] **Step 3: Run the desktop navigation tests**

Run:

```powershell
npm run e2e -- --project=desktop-chromium e2e/smoke/login-navigation.spec.ts
```

Expected: 4 passed.

- [ ] **Step 4: Run the mobile navigation tests**

Run:

```powershell
npm run e2e -- --project=mobile-chromium e2e/smoke/login-navigation.spec.ts
```

Expected: 4 passed with the login action and role navigation visible at 390x844.

- [ ] **Step 5: Commit role coverage**

```powershell
git add e2e/support/login.ts e2e/smoke/login-navigation.spec.ts
git commit -m "test: cover browser login and role navigation"
```

## Task 5: Cover Approval Detail and PDF Rendering

**Files:**
- Create: `e2e/smoke/approval-workbench.spec.ts`

- [ ] **Step 1: Add the approval and canvas test**

Create `e2e/smoke/approval-workbench.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { loginAs } from "../support/login.ts";

test.beforeEach(async ({ page }) => {
  await loginAs(page, "supervisor");
});

test("reviewer opens the seeded approval and renders a nonblank PDF canvas", async ({ page }) => {
  const row = page.getByRole("row", { name: /E2E项目.*E2E轴承座/ });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "查看" }).click();
  await expect(page.getByRole("heading", { name: "E2E项目 / E2E轴承座" })).toBeVisible();

  const canvas = page.locator("canvas.pdf-annotation-canvas").first();
  await expect(canvas).toBeVisible();
  await expect.poll(async () =>
    canvas.evaluate((element: HTMLCanvasElement) => {
      const context = element.getContext("2d");
      if (!context || element.width === 0 || element.height === 0) return 0;
      const pixels = context.getImageData(0, 0, element.width, element.height).data;
      let nonWhite = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] > 0 && (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245)) nonWhite += 1;
      }
      return nonWhite;
    })
  ).toBeGreaterThan(100);
});

test("annotation tools and review actions remain available", async ({ page }) => {
  await page.getByRole("row", { name: /E2E项目.*E2E轴承座/ }).getByRole("link", { name: "查看" }).click();
  await expect(page.getByLabel("PDF 批注工具")).toBeVisible();
  for (const name of ["选择", "定位", "箭头", "矩形", "圆形", "文字", "画笔", "云线"]) {
    await expect(page.getByRole("button", { name })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: /通过/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /驳回/ })).toBeVisible();
});
```

- [ ] **Step 2: Run the test and inspect the first real failure**

Run:

```powershell
npm run e2e -- --project=desktop-chromium e2e/smoke/approval-workbench.spec.ts
```

Expected: if selectors reflect current accessible names, 2 passed. If the canvas never becomes nonblank, treat that as a real baseline defect and inspect the retained trace; do not weaken the pixel threshold.

- [ ] **Step 3: Add a reviewed desktop screenshot**

Append to the first test after the pixel assertion:

```ts
await expect(page).toHaveScreenshot("approval-workbench.png", {
  fullPage: true,
  mask: [page.locator("time")]
});
```

- [ ] **Step 4: Create and review the baseline screenshot**

Run:

```powershell
npm run e2e:update -- --project=desktop-chromium e2e/smoke/approval-workbench.spec.ts
```

Expected: a new PNG under `e2e/__screenshots__/`; open it and verify PDF, toolbar and side panel are visible and non-overlapping before staging.

- [ ] **Step 5: Re-run without updating**

Run:

```powershell
npm run e2e -- --project=desktop-chromium e2e/smoke/approval-workbench.spec.ts
```

Expected: 2 passed and screenshot comparison passed.

- [ ] **Step 6: Commit PDF baseline**

```powershell
git add e2e/smoke/approval-workbench.spec.ts e2e/__screenshots__
git commit -m "test: baseline PDF review workbench"
```

## Task 6: Add Responsive and Accessibility Baselines

**Files:**
- Create: `e2e/smoke/responsive-accessibility.spec.ts`

- [ ] **Step 1: Add page overflow and accessibility checks**

```ts
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { loginAs } from "../support/login.ts";

test("authenticated shell fits the viewport", async ({ page }) => {
  await loginAs(page, "admin");
  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth
  }));
  expect(overflow.document).toBeLessThanOrEqual(overflow.viewport + 1);
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
});

test("admin surface has no critical accessibility violations", async ({ page }) => {
  await loginAs(page, "admin");
  const result = await new AxeBuilder({ page }).include("#main-content").analyze();
  const critical = result.violations.filter((item) => item.impact === "critical");
  expect(critical, JSON.stringify(critical, null, 2)).toEqual([]);
  test.info().attach("axe-violations", {
    body: JSON.stringify(result.violations, null, 2),
    contentType: "application/json"
  });
});

test("authenticated shell visual baseline", async ({ page }) => {
  await loginAs(page, "admin");
  await expect(page).toHaveScreenshot("admin-shell.png", {
    fullPage: true,
    mask: [page.locator("time")]
  });
});
```

- [ ] **Step 2: Create the desktop and mobile baseline screenshots**

Run:

```powershell
npm run e2e:update -- e2e/smoke/responsive-accessibility.spec.ts
```

Expected: 6 passed across desktop and mobile and both snapshot files are created. Serious non-critical axe findings are attached as the Phase 2 remediation baseline; critical findings must be fixed before this task completes.

- [ ] **Step 3: Review the created screenshots**

Open the desktop and mobile PNG files under `e2e/__screenshots__/`. Verify both show the authenticated shell, visible navigation, readable labels, no overlap, and no clipped primary action. Do not approve a screenshot merely because Playwright created it.

- [ ] **Step 4: Re-run stable comparisons**

Run:

```powershell
npm run e2e -- e2e/smoke/responsive-accessibility.spec.ts
```

Expected: 6 passed.

- [ ] **Step 5: Commit responsive baseline**

```powershell
git add e2e/smoke/responsive-accessibility.spec.ts e2e/__screenshots__
git commit -m "test: baseline responsive and accessible UI"
```

## Task 7: Verify and Document the Phase 0 Gate

**Files:**
- Modify: `docs/verification.md`

- [ ] **Step 1: Run client tests**

```powershell
npm test -- --run src/client
```

Expected: exit `0`, no failed tests.

- [ ] **Step 2: Run server domain, repository, service, file, and PDF tests**

```powershell
npm test -- --run src/server/auth.test.ts src/server/domain src/server/repositories src/server/services src/server/files src/server/pdf
```

Expected: exit `0` within the 60-second hard timeout, no failed tests.

- [ ] **Step 3: Run core route tests**

```powershell
npm test -- --run src/server/routes/auth.test.ts src/server/routes/submissions.test.ts src/server/routes/approvals.test.ts src/server/routes/approvalAnnotations.test.ts src/server/routes/approvalComments.test.ts src/server/routes/pdm.test.ts
```

Expected: exit `0` within the 60-second hard timeout, no failed tests.

- [ ] **Step 4: Run remaining server and packaging tests**

```powershell
npm test -- --run src/server/routes/settings.test.ts src/server/routes/system.test.ts src/server/routes/users.test.ts src/server/routes/profile.test.ts src/server/routes/signatures.test.ts src/server/routes/signatureTemplates.test.ts src/server/routes/operationLogs.test.ts src/server/routes/reports.test.ts src/server/routes/tray.test.ts src/server/server.test.ts src/server/startServer.test.ts src/server/dbIndexes.test.ts
```

Expected: exit `0` within the 60-second hard timeout, no failed tests.

- [ ] **Step 5: Run the E2E type check**

```powershell
npm run e2e:typecheck
```

Expected: exit `0`, no TypeScript errors in Playwright support or specs.

- [ ] **Step 6: Run the production build**

```powershell
npm run build
```

Expected: TypeScript and Vite exit `0`; existing PDF chunk warning is recorded but is not a Phase 0 failure.

- [ ] **Step 7: Run Electron shell tests**

```powershell
npm run desktop:test
```

Expected: exit `0`, no failed tests.

- [ ] **Step 8: Run the browser gate**

```powershell
npm run e2e
```

Expected:

- Desktop and mobile Playwright projects pass.
- No Playwright webServer process remains after completion.

- [ ] **Step 9: Record evidence in `docs/verification.md`**

Append a dated section containing:

```markdown
## 2026-07-10 Phase 0 browser baseline

- Isolated runtime: `.cache/e2e/runtime`; no real data directories used.
- Client tests: passed.
- Server test groups: passed within 60 seconds per command.
- Build: passed.
- Desktop shell: passed.
- Playwright desktop/mobile: passed.
- PDF canvas nonblank pixel check: passed.
- Critical axe violations: 0.
- Baseline screenshots: login/navigation, admin shell, approval workbench.
```

Replace each `passed` only with the fresh command result from this task. Do not record evidence for commands that did not run.

- [ ] **Step 10: Inspect the final diff**

Run:

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors; only Phase 0 files are modified or untracked.

- [ ] **Step 11: Commit the Phase 0 gate**

```powershell
git add docs/verification.md
git commit -m "test: establish refactor quality baseline"
```

## Phase 0 Completion Checklist

- [ ] E2E runtime deletes and recreates only `.cache/e2e/runtime`.
- [ ] No test reads the repository `data/`, `output/`, `logs/`, `backups/` or real server config.
- [ ] Default admin/supervisor/process and seeded designer flows are deterministic.
- [ ] PDF fixture is generated in code and canvas pixel check proves it renders.
- [ ] Desktop and mobile Chromium suites pass.
- [ ] Critical axe violations are zero; serious findings are attached for Phase 2.
- [ ] Baseline screenshots were visually inspected before commit.
- [ ] Unit, build and Electron shell checks pass.
- [ ] No production behavior, schema or packaging path changed.

## Next Plan Gate

After Phase 0 is committed and reviewed:

1. Read the actual Playwright fixtures and any accessibility/performance findings.
2. Confirm the Hong Kong cloud provider or explicitly choose local-container-only execution for Phase 1.
3. Create `docs/superpowers/plans/2026-07-10-refactor-phase-1-cloud-data-security.md` using the now-stable browser and data fixtures.

Do not begin PostgreSQL, MFA, object storage or UI redesign work inside Phase 0.
