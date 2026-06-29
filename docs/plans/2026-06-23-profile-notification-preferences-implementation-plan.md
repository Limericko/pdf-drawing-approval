# User Profile And Notification Preferences Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add self-service user profiles, common projects, and role-specific notification preferences to the LAN PDF approval system.

**Architecture:** Store user basics in the existing `users` table and store per-user preferences in a new `user_preferences` table. Add `/api/profile` for self-service edits, a notification preference layer for email delivery decisions, and a reusable approval notification service called from submission, review, signing, and print-archive flows.

**Tech Stack:** Node 24, TypeScript, Express, built-in `node:sqlite`, React/Vite, Vitest, existing `nodemailer` wrapper.

---

### Task 1: User Preference Persistence

**Files:**
- Modify: `src/server/schema.sql`
- Modify: `src/server/db.ts`
- Create: `src/server/repositories/userPreferences.ts`
- Create: `src/server/repositories/userPreferences.test.ts`

**Step 1: Write failing repository tests**

Create `src/server/repositories/userPreferences.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { UserRepository } from "./users.ts";
import { UserPreferenceRepository } from "./userPreferences.ts";

describe("UserPreferenceRepository", () => {
  it("returns role defaults when a user has no saved preferences", () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const preferences = new UserPreferenceRepository(db);
    const designer = users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });

    const profile = preferences.getForUser(designer);

    expect(profile.commonProjects).toEqual([]);
    expect(profile.notificationPreferences.email.approvalRejected).toBe(true);
    expect(profile.notificationPreferences.email.reviewTaskCreated).toBe(false);
  });

  it("saves cleaned common projects and notification preferences", () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const preferences = new UserPreferenceRepository(db);
    const supervisor = users.create({ username: "supervisor", password: "123456", role: "supervisor", displayName: "主管" });

    const saved = preferences.upsertForUser(supervisor, {
      commonProjects: ["  项目A  ", "项目A", "", "项目B"],
      notificationPreferences: {
        email: {
          reviewTaskCreated: false,
          peerReviewCompleted: true
        }
      }
    });

    expect(saved.commonProjects).toEqual(["项目A", "项目B"]);
    expect(saved.notificationPreferences.email.reviewTaskCreated).toBe(false);
    expect(saved.notificationPreferences.email.peerReviewCompleted).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- --run src/server/repositories/userPreferences.test.ts
```

Expected: fail because `userPreferences.ts` does not exist.

**Step 3: Add schema and migration**

In `src/server/schema.sql`, add:

```sql
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id INTEGER PRIMARY KEY,
  common_projects_json TEXT NOT NULL DEFAULT '[]',
  notification_preferences_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

In `src/server/db.ts`, add `migrateUserPreferences(db)` and call it from `migrateDatabase`.

**Step 4: Implement repository**

Create `src/server/repositories/userPreferences.ts` with:

- `NotificationEventKey` union:
  - `reviewTaskCreated`
  - `peerReviewCompleted`
  - `approvalRejected`
  - `approvalApprovedForPrint`
  - `signatureFailed`
  - `approvalPrinted`
  - `systemRisk`
- `defaultNotificationPreferencesForRole(role)`
- `cleanCommonProjects(projects)`
- `UserPreferenceRepository.getForUser(user)`
- `UserPreferenceRepository.upsertForUser(user, input)`

Rules:

- Max common projects: 20.
- Max project name length: 80.
- Trim and dedupe names.
- Merge partial preferences with role defaults.

**Step 5: Run test to verify it passes**

Run:

```powershell
npm test -- --run src/server/repositories/userPreferences.test.ts
```

Expected: pass.

---

### Task 2: Self-Service Profile API

**Files:**
- Modify: `src/server/repositories/users.ts`
- Create: `src/server/routes/profile.ts`
- Create: `src/server/routes/profile.test.ts`
- Modify: `src/server/server.ts`

**Step 1: Write failing route tests**

Create `src/server/routes/profile.test.ts` covering:

- authenticated user can read profile.
- user can update display name, email, common projects, and notification preferences.
- unauthenticated requests return 401.
- role, username, active status cannot be changed.

Test shape:

```ts
const response = await request(app)
  .put("/api/profile")
  .set("Authorization", `Bearer ${token}`)
  .send({
    displayName: "张工",
    email: "designer@example.com",
    commonProjects: ["项目A", "项目B"],
    notificationPreferences: { email: { approvalRejected: false } }
  })
  .expect(200);

expect(response.body.user.displayName).toBe("张工");
expect(response.body.commonProjects).toEqual(["项目A", "项目B"]);
expect(response.body.notificationPreferences.email.approvalRejected).toBe(false);
```

**Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- --run src/server/routes/profile.test.ts
```

Expected: fail because route does not exist.

**Step 3: Add user self-update repository method**

In `src/server/repositories/users.ts`, add:

```ts
updateProfile(id: number, input: { displayName: string; email?: string | null }): User
```

It updates only `display_name` and `email`.

**Step 4: Add profile route**

Create `src/server/routes/profile.ts`:

- `GET /`
- `PUT /`

Use `requireAuth(deps.jwtSecret)`.

`PUT` validation:

- `displayName`: trimmed min 1.
- `email`: valid email or empty string.
- `commonProjects`: array of strings, max 20.
- `notificationPreferences`: object with optional `email` object.

Write `operationLogs` action `user.profile_updated`.

**Step 5: Register route**

In `src/server/server.ts`:

- import `UserPreferenceRepository`.
- instantiate it.
- add to `ServerDeps`.
- register `app.use("/api/profile", profileRoutes(...))`.

**Step 6: Run tests**

Run:

```powershell
npm test -- --run src/server/routes/profile.test.ts src/server/repositories/userPreferences.test.ts
```

Expected: pass.

---

### Task 3: Approval Notification Service

**Files:**
- Create: `src/server/notifications/approvalNotifications.ts`
- Create: `src/server/notifications/approvalNotifications.test.ts`
- Modify: `src/server/notifications/notifyApprovalCreated.ts`

**Step 1: Write failing notification tests**

Create tests for:

- `reviewTaskCreated` emails supervisor and process users with enabled preferences.
- disabled preference skips that user.
- missing email skips that user.
- SMTP not configured does not throw.
- `approvalRejected` emails the submitting designer.
- `signatureFailed` emails designer and admins with enabled preferences.

**Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- --run src/server/notifications/approvalNotifications.test.ts
```

Expected: fail because service does not exist.

**Step 3: Implement service**

Create:

```ts
export async function notifyApprovalEvent(input: {
  event: NotificationEventKey;
  approvalId: number;
  approvals: ApprovalRepository;
  users: UserRepository;
  userPreferences: UserPreferenceRepository;
  settings: SettingsRepository;
  operationLogs?: OperationLogRepository;
  transport?: MailTransport | null;
  actorUserId?: number | null;
  actorUsername?: string | null;
}): Promise<{ attempted: number; sent: number; skipped: number; failed: number }>;
```

Recipient rules:

- `reviewTaskCreated`: active supervisor + process users.
- `peerReviewCompleted`: the opposite reviewer role if still relevant.
- `approvalRejected`: submitted designer plus reviewer users.
- `approvalApprovedForPrint`: submitted designer plus supervisor/process.
- `signatureFailed`: submitted designer plus admins.
- `approvalPrinted`: submitted designer.
- `systemRisk`: admins only.

Use `createTransport(settings)` unless `transport` is explicitly passed.

Log:

- `notification.email_sent`
- `notification.email_skipped`
- `notification.email_failed`

**Step 4: Update legacy creation notifier**

Refactor `notifyApprovalCreated.ts` to call `notifyApprovalEvent({ event: "reviewTaskCreated", ... })`, preserving existing compatibility.

**Step 5: Run tests**

Run:

```powershell
npm test -- --run src/server/notifications/approvalNotifications.test.ts src/server/notifications/email.test.ts
```

Expected: pass.

---

### Task 4: Wire Notifications Into Approval Flow

**Files:**
- Modify: `src/server/server.ts`
- Modify: `src/server/routes/submissions.ts`
- Modify: `src/server/routes/approvals.ts`
- Modify: `src/server/services/signingWorkflow.ts`
- Modify: related tests:
  - `src/server/routes/submissions.test.ts`
  - `src/server/routes/approvals.test.ts`
  - `src/server/services/signingWorkflow.test.ts`

**Step 1: Add failing route tests**

Add tests verifying:

- web upload confirmation triggers `reviewTaskCreated`.
- a single reviewer approval while approval remains pending triggers `peerReviewCompleted`.
- rejection triggers `approvalRejected`.
- final approval triggers `approvalApprovedForPrint`.
- mark printed triggers `approvalPrinted`.
- signature generation failure triggers `signatureFailed`.

Use fake `MailTransport` and assert `sendMail` calls or operation logs.

**Step 2: Run focused tests to verify failures**

Run:

```powershell
npm test -- --run src/server/routes/submissions.test.ts src/server/routes/approvals.test.ts src/server/services/signingWorkflow.test.ts
```

Expected: new tests fail because notifications are not wired.

**Step 3: Extend dependencies**

Add `userPreferences` and optional notification callback dependencies where needed:

- `submissionRoutes`
- `approvalRoutes`
- `tryGenerateSignedPdfForApproval`

Keep existing tests simple by defaulting missing notification dependencies to no-op if needed.

**Step 4: Call notifications**

Call notification service:

- after `createApprovalFromUpload` succeeds.
- after `deps.approvals.review`.
- after `markPrinted`.
- inside signing workflow when `setSignatureStatus(..., "failed")` occurs.

Do not block approval result on notification failure; the service catches and logs email failures.

**Step 5: Run focused tests**

Run:

```powershell
npm test -- --run src/server/routes/submissions.test.ts src/server/routes/approvals.test.ts src/server/services/signingWorkflow.test.ts
```

Expected: pass.

---

### Task 5: Client API And Routing

**Files:**
- Modify: `src/client/api.ts`
- Modify: `src/client/api.test.ts`
- Modify: `src/client/roleAccess.ts`
- Modify: `src/client/roleAccess.test.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/appRouting.test.ts`
- Modify: `src/client/appLayout.test.ts`

**Step 1: Write failing client API tests**

Add tests for:

- `getProfile()` calls `/api/profile`.
- `updateProfile(input)` calls `PUT /api/profile`.

**Step 2: Write failing routing tests**

Expected:

- `navigationForRole` includes `我的资料` for every role, and keeps `全部图纸` reachable for admins so drawing deletion remains available from the ledger page.
- `routeFromHash("#/profile")` returns `{ name: "profile" }`.
- route allowed for each role.

**Step 3: Run tests**

Run:

```powershell
npm test -- --run src/client/api.test.ts src/client/roleAccess.test.ts src/client/appRouting.test.ts src/client/appLayout.test.ts
```

Expected: fail.

**Step 4: Implement client API types/functions**

Add:

```ts
export type NotificationPreferences = { email: Record<string, boolean> };
export type Profile = {
  user: User;
  commonProjects: string[];
  notificationPreferences: NotificationPreferences;
  availableNotificationEvents: Array<{ key: string; label: string; description: string }>;
};
export function getProfile(): Promise<Profile>;
export function updateProfile(input: ...): Promise<Profile>;
```

**Step 5: Add route/nav**

Add route name `profile`, nav item `我的资料`, and rendering placeholder `<ProfilePage ... />` after Task 6.

**Step 6: Run tests**

Run:

```powershell
npm test -- --run src/client/api.test.ts src/client/roleAccess.test.ts src/client/appRouting.test.ts src/client/appLayout.test.ts
```

Expected: pass after Task 6 page exists.

---

### Task 6: My Profile Page

**Files:**
- Create: `src/client/pages/ProfilePage.tsx`
- Create: `src/client/pages/ProfilePage.test.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`

**Step 1: Write page tests**

Test source-level or helper-level behavior consistent with existing lightweight frontend tests:

- page exposes profile form labels.
- notification event labels render from API data.
- save calls `updateProfile`.

**Step 2: Run tests to verify failures**

Run:

```powershell
npm test -- --run src/client/pages/ProfilePage.test.ts
```

Expected: fail because page does not exist.

**Step 3: Implement page**

Page sections:

- Basic profile:
  - username readonly
  - role readonly
  - display name input
  - email input
- Common projects:
  - input + add button
  - removable project chips
- Notification preferences:
  - toggle checkboxes for `availableNotificationEvents`
- Save button.

Props:

```ts
export function ProfilePage({ onUserUpdated }: { onUserUpdated: (user: User) => void })
```

After saving, call `onUserUpdated(profile.user)` so sidebar name updates.

**Step 4: Wire App**

In `App.tsx`, render:

```tsx
{routeAllowed && route.name === "profile" && <ProfilePage onUserUpdated={setUser} />}
```

**Step 5: Style**

Use existing app form/card conventions. Avoid nested cards. Use compact settings-like layout.

**Step 6: Run focused tests**

Run:

```powershell
npm test -- --run src/client/pages/ProfilePage.test.ts src/client/appRouting.test.ts src/client/appLayout.test.ts
```

Expected: pass.

---

### Task 7: Common Projects On Submit Page

**Files:**
- Modify: `src/client/pages/SubmitDrawingPage.tsx`
- Modify: `src/client/pages/submitDrawingLayout.test.ts`

**Step 1: Write failing submit page tests**

Add test asserting source contains:

- `getProfile`
- `common-projects`
- common project click sets project name.

Use the current source-level style already present in `submitDrawingLayout.test.ts`.

**Step 2: Run test**

Run:

```powershell
npm test -- --run src/client/pages/submitDrawingLayout.test.ts
```

Expected: fail.

**Step 3: Implement common project quick selection**

In `SubmitDrawingPage`:

- fetch profile on mount.
- store `commonProjects`.
- show quick buttons near project input when list is non-empty.
- clicking a project sets `projectName`.

**Step 4: Run test**

Run:

```powershell
npm test -- --run src/client/pages/submitDrawingLayout.test.ts
```

Expected: pass.

---

### Task 8: Final Verification

**Files:**
- Potentially update: `docs/verification.md` if project convention requires it.

**Step 1: Run focused test group**

Run:

```powershell
npm test -- --run src/server/repositories/userPreferences.test.ts src/server/routes/profile.test.ts src/server/notifications/approvalNotifications.test.ts src/client/api.test.ts src/client/roleAccess.test.ts src/client/pages/ProfilePage.test.ts src/client/pages/submitDrawingLayout.test.ts
```

Expected: pass.

**Step 2: Run full test suite**

Run:

```powershell
npm test
```

Expected: pass.

**Step 3: Run production build**

Run:

```powershell
npm run build
```

Expected: pass. Existing PDF chunk size warning may remain.

**Step 4: Manual smoke checklist**

- Login as designer.
- Open “我的资料”, set display name, email, common projects, and notification preferences.
- Open “提交图纸”, click a common project, verify project input fills.
- Submit a PDF and verify supervisor/process notification path does not block submission.
- Login as supervisor/process, approve/reject and verify operation logs contain notification events.

**Step 5: Delivery note**

Summarize:

- profile page and API.
- common projects on submission.
- notification events and role defaults.
- verification command results.
- SMTP dependency and non-blocking behavior.
