# Email Password Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add email-based password reset for users who know their account name and registered email.

**Architecture:** Public auth routes issue short-lived one-time reset tokens and send reset links through the existing SMTP configuration. Tokens are stored as SHA-256 hashes in SQLite, expire after 30 minutes, and are marked used after a successful password reset. The login page hosts request/reset forms without exposing whether an account exists.

**Tech Stack:** Node 24, Express, built-in `node:sqlite`, React/Vite, nodemailer-compatible transport, Vitest/Supertest.

---

### Task 1: Backend Reset Token Flow

**Files:**
- Modify: `src/server/schema.sql`
- No change needed: `src/server/db.ts` already executes `schema.sql` during startup migration.
- Create: `src/server/repositories/passwordResetTokens.ts`
- Modify: `src/server/routes/auth.ts`
- Modify: `src/server/server.ts`
- Test: `src/server/routes/auth.test.ts`

- [x] Write failing route tests for request/reset behavior, no account enumeration, expiry, one-time use, and SMTP-not-configured handling.
- [x] Add `password_reset_tokens` table and repository with token hashing, expiry and consume semantics.
- [x] Inject settings, operation logs, mail transport and reset-token repository into auth routes.
- [x] Implement `POST /api/auth/password-reset/request` and `POST /api/auth/password-reset/confirm`.
- [x] Run `npm test -- --run src/server/routes/auth.test.ts`.

### Task 2: Client Reset Flow

**Files:**
- Modify: `src/client/api.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/pages/LoginPage.tsx`
- Modify: `src/client/styles.css`
- Test: `src/client/api.test.ts`
- Test: `src/client/appRouting.test.ts`
- Test: `src/client/pages/LoginPage.test.ts`

- [x] Write failing client tests for API calls, reset hash routing, and login page reset UI.
- [x] Add `requestPasswordReset` and `confirmPasswordReset` API helpers.
- [x] Route `#/reset-password?token=...` to a login-page reset mode when no user is logged in.
- [x] Add forgot-password request and token-confirm forms with local validation and safe user-facing messages.
- [x] Run `npm test -- --run src/client/api.test.ts src/client/appRouting.test.ts src/client/pages/LoginPage.test.ts`.

### Task 3: Verification

**Files:**
- No additional files.

- [x] Run `npm test`.
- [x] Run `npm run build`.
- [x] Restart the dev server.
- [x] Smoke test `/health`, safe reset request response, and invalid reset token rejection.
