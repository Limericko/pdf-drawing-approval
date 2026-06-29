# PDF Approval System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a LAN-only PDF drawing approval system that watches a Nutstore-synced Windows folder, creates approval records, supports parallel supervisor/process review, and moves approved or rejected PDFs into status folders.

**Architecture:** Use a single Windows-hosted web application with a local SQLite database and a file watcher pointed at the local Nutstore sync directory. Users access the app from browsers on the company LAN; email and browser notifications provide first-version reminders.

**Tech Stack:** Recommended stack is Node.js with TypeScript, Express/Fastify, SQLite, chokidar for file watching, React/Vite for the web UI, PDF preview through browser PDF rendering, and nodemailer for SMTP.

---

## Assumptions

- This is a new project directory.
- The first deployment target is one Windows computer in the company LAN.
- The system watches a local Nutstore sync folder, not remote WebDAV.
- Supervisor and process reviewer are fixed users.
- File naming rule is `零件名-a数字A数字.pdf`.

## Task 1: Scaffold Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/server/index.ts`
- Create: `src/server/config.ts`
- Create: `src/client/App.tsx`
- Create: `src/client/main.tsx`
- Create: `vite.config.ts`

**Step 1: Initialize package metadata**

Create scripts:

```json
{
  "scripts": {
    "dev": "tsx src/server/index.ts",
    "build": "tsc && vite build",
    "test": "vitest run"
  }
}
```

**Step 2: Add dependencies**

Install:

```bash
npm install express better-sqlite3 chokidar nodemailer bcryptjs jsonwebtoken zod
npm install -D typescript tsx vite react react-dom vitest @types/node @types/express @types/nodemailer
```

**Step 3: Add minimal server**

Create an HTTP server with `/health` returning:

```json
{ "ok": true }
```

**Step 4: Verify**

Run:

```bash
npm run dev
```

Expected: server starts and `GET /health` returns `{ "ok": true }`.

## Task 2: Define Core Data Model

**Files:**
- Create: `src/server/db.ts`
- Create: `src/server/schema.sql`
- Create: `src/server/repositories/approvals.ts`
- Create: `src/server/repositories/users.ts`
- Test: `src/server/repositories/approvals.test.ts`

**Step 1: Write repository tests**

Cover:

- Create approval record.
- Query approvals by status.
- Query historical versions by project and part name.
- Update supervisor review.
- Update process review.
- Total status becomes approved only when both reviewers approve.
- Total status becomes rejected when either reviewer rejects.

**Step 2: Create SQLite schema**

Tables:

- `users`
- `approvals`
- `settings`

Use explicit status strings:

- `pending`
- `rejected`
- `approved_for_print`
- `printed_archived`
- `filename_invalid`

**Step 3: Implement repositories**

Keep business status transitions in repository/service methods, not scattered across routes.

**Step 4: Verify**

Run:

```bash
npm test
```

Expected: repository tests pass.

## Task 3: Implement Filename Parser

**Files:**
- Create: `src/server/files/parseDrawingFileName.ts`
- Test: `src/server/files/parseDrawingFileName.test.ts`

**Step 1: Write failing tests**

Test valid examples:

```text
轴承座-a0A0.pdf
轴承座-a1A0.pdf
上盖板-a0A1.pdf
```

Expected fields:

- partName
- version
- minorVersion
- majorVersion

Test invalid examples:

```text
轴承座.pdf
轴承座-v1.pdf
轴承座-aA.pdf
轴承座-a1A0.docx
```

**Step 2: Implement parser**

Use a regex equivalent to:

```text
^(.+)-(a\d+A\d+)\.pdf$
```

Make matching case-sensitive for the version token unless the team decides otherwise.

**Step 3: Verify**

Run:

```bash
npm test -- parseDrawingFileName
```

Expected: parser tests pass.

## Task 4: Implement File Stability Check

**Files:**
- Create: `src/server/files/waitForStableFile.ts`
- Test: `src/server/files/waitForStableFile.test.ts`

**Step 1: Write tests**

Cover:

- File is considered stable when size and modified time do not change for two checks.
- Missing file returns a controlled failure.
- Timeout returns a controlled failure.

**Step 2: Implement stability check**

Default behavior:

- Check every 1 second.
- Require 2 equal checks.
- Timeout after 60 seconds.

**Step 3: Verify**

Run:

```bash
npm test -- waitForStableFile
```

Expected: stability tests pass.

## Task 5: Implement Folder Watcher

**Files:**
- Create: `src/server/files/watchSubmissions.ts`
- Test: `src/server/files/watchSubmissions.test.ts`

**Step 1: Write tests with temporary folders**

Cover:

- New PDF in `01-待提交/项目A` creates approval.
- Project name comes from the child folder.
- Invalid filename creates `filename_invalid` record or exception record.
- Duplicate project + part + version is ignored or marked duplicate.

**Step 2: Implement watcher**

Use `chokidar` to watch:

```text
<watch_root>/01-待提交/**/*.pdf
```

After stability check:

- Parse file name.
- Create approval record.
- Move valid files to `02-审批中/<project>/`.
- Send notification.

**Step 3: Verify**

Run:

```bash
npm test -- watchSubmissions
```

Expected: watcher tests pass.

## Task 6: Implement Approval API

**Files:**
- Create: `src/server/routes/approvals.ts`
- Modify: `src/server/index.ts`
- Test: `src/server/routes/approvals.test.ts`

**Step 1: Write API tests**

Cover:

- `GET /api/approvals`
- `GET /api/approvals/:id`
- `POST /api/approvals/:id/review`
- `POST /api/approvals/:id/mark-printed`

**Step 2: Implement routes**

Review input:

```json
{
  "role": "supervisor",
  "decision": "approved",
  "comment": "同意"
}
```

Reject input requires non-empty comment.

**Step 3: Implement file moves on final status**

- Approved by both reviewers: move to `04-已通过待打印/<project>/`.
- Rejected by either reviewer: move to `03-已驳回/<project>/`.
- Mark printed: move to `05-已打印归档/<project>/`.

**Step 4: Verify**

Run:

```bash
npm test -- approvals
```

Expected: approval route tests pass.

## Task 7: Implement Authentication

**Files:**
- Create: `src/server/auth.ts`
- Create: `src/server/routes/auth.ts`
- Modify: `src/server/index.ts`
- Test: `src/server/auth.test.ts`

**Step 1: Write tests**

Cover:

- Login with valid user returns token.
- Invalid login fails.
- Role is included in authenticated request context.

**Step 2: Implement simple JWT authentication**

Roles:

- `designer`
- `supervisor`
- `process`
- `printer`
- `admin`

**Step 3: Seed fixed users**

Provide a first-run admin account and allow password changes later.

**Step 4: Verify**

Run:

```bash
npm test -- auth
```

Expected: auth tests pass.

## Task 8: Implement Email Notifications

**Files:**
- Create: `src/server/notifications/email.ts`
- Create: `src/server/notifications/notifyApprovalCreated.ts`
- Test: `src/server/notifications/email.test.ts`

**Step 1: Write tests with mocked transport**

Cover:

- Supervisor and process reviewer both receive an email.
- Email contains project, part name, version, and approval link.
- SMTP failure is logged without crashing file ingestion.

**Step 2: Implement nodemailer adapter**

Read SMTP settings from database or config.

**Step 3: Verify**

Run:

```bash
npm test -- notifications
```

Expected: notification tests pass.

## Task 9: Build Web UI

**Files:**
- Create: `src/client/pages/LoginPage.tsx`
- Create: `src/client/pages/MyTasksPage.tsx`
- Create: `src/client/pages/ApprovalsPage.tsx`
- Create: `src/client/pages/ApprovalDetailPage.tsx`
- Create: `src/client/pages/SettingsPage.tsx`
- Create: `src/client/api.ts`
- Modify: `src/client/App.tsx`

**Step 1: Implement API client**

Create typed functions for login, list approvals, get approval detail, submit review, mark printed, and save settings.

**Step 2: Implement pages**

Required pages:

- Login
- 待我审核
- 全部图纸
- 图纸详情
- 配置

**Step 3: Implement PDF preview**

Use browser-native PDF display:

```html
<iframe src="/api/approvals/:id/file"></iframe>
```

**Step 4: Implement review controls**

Buttons:

- 通过
- 驳回

Reject requires comment.

**Step 5: Verify manually**

Run:

```bash
npm run dev
```

Expected:

- User can log in.
- Reviewer sees pending tasks.
- Reviewer opens PDF.
- Reviewer approves or rejects.

## Task 10: Add Settings and Windows Deployment Notes

**Files:**
- Create: `docs/deploy-windows-lan.md`
- Create: `scripts/start-server.ps1`
- Create: `scripts/install-startup-task.ps1`

**Step 1: Write deployment documentation**

Include:

- Install Node.js.
- Install dependencies.
- Configure Nutstore sync directory.
- Set static LAN IP or computer name.
- Start server.
- Access from another PC.
- Configure SMTP.
- Backup SQLite database.

**Step 2: Add start script**

PowerShell script starts the server from project directory.

**Step 3: Add optional startup task script**

Create a Windows scheduled task for startup.

**Step 4: Verify**

Run start script on the server PC.

Expected: service starts and LAN users can open the app URL.

## Task 11: End-to-End Acceptance Test

**Files:**
- Create: `docs/verification.md`

**Step 1: Prepare test folder**

Create:

```text
图纸审批/01-待提交/测试项目/
```

**Step 2: Submit test PDF**

Place:

```text
测试零件-a0A0.pdf
```

**Step 3: Verify ingestion**

Expected:

- Approval appears in the web app.
- File moves to `02-审批中/测试项目/`.
- Supervisor and process reviewer receive email.

**Step 4: Verify approval**

Supervisor approves. Process reviewer approves.

Expected:

- Total status becomes `已通过待打印`.
- File moves to `04-已通过待打印/测试项目/`.

**Step 5: Verify rejection**

Submit:

```text
测试零件-a1A0.pdf
```

One reviewer rejects with comment.

Expected:

- Total status becomes `已驳回`.
- File moves to `03-已驳回/测试项目/`.
- Comment appears in history.

**Step 6: Record results**

Write the actual command outputs, manual checks, and remaining risks into `docs/verification.md`.

## Milestone Order

1. Backend skeleton and database.
2. Filename parsing and folder watching.
3. Approval API and file moves.
4. Authentication.
5. Email notifications.
6. Web UI.
7. Windows LAN deployment script and documentation.
8. End-to-end office workflow test.

## First Release Acceptance Criteria

- A PDF named `零件名-a数字A数字.pdf` placed under `01-待提交/项目名/` creates an approval record.
- Supervisor and process reviewer can approve in parallel.
- Both approvals move the file to `04-已通过待打印` and mark it printable.
- Any rejection moves the file to `03-已驳回` and preserves the comment.
- Users can view PDF and approval history in the browser.
- Email notification works with configured SMTP.
- The app can run on one Windows LAN computer and be opened from another Windows computer.
