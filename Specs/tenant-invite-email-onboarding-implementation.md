# Tenant Invite Email Onboarding Implementation Plan

## Implementation Status (2026-04-10)

- Core invite email onboarding flow is implemented in production code.
- Invite model now supports two explicit types:
  - `personalized`: email-bound and consumed on successful join.
  - `shared`: reusable until expiry/revocation.
- Data model update shipped in:
  - `supabase/migrations/20260410153000_phase_k_invite_types.sql`.
- Shared-invite access control policy is implemented:
  - allowlist domains/emails,
  - optional password requirement for non-allowlisted shared-invite joins.
- Invite access policy data model update shipped in:
  - `supabase/migrations/20260410170000_phase_l_invite_access_controls.sql`.
- OAuth invite-link continuity and join UX are implemented:
  - invite token survives Google OAuth redirect chain,
  - invite accept page performs preview + auth-aware auto-join,
  - password-required shared invite errors route user into dashboard retry flow.

## 1. Purpose and Scope

**Decision**

Define a planning-only, implementation-ready blueprint for onboarding employees into tenant organizations via owner/admin-sent invite emails from the dashboard.

**Reasoning**

Invite onboarding is the critical path for org growth and access control. It should be isolated from map/instance work to reduce cross-domain coupling.

**Alternatives considered**

- Keep invite onboarding bundled with interior instance planning.
  - Rejected because backend onboarding and world rendering have different owners, rollout risk, and testing cadence.

---

## 2. Current State

**Decision**

Treat the current baseline as:

- Invite creation API exists: `POST /tenant/:tenantId/invites`.
- Invite redemption exists via `POST /tenant/onboarding` with `mode: join_invite`.
- Dashboard includes invite creation UX for owner/admin users with invite-create permission.
- SMTP email dispatch is integrated with fallback link/token behavior.
- Invite creation supports both personalized and shared invites.
- Dashboard includes invite access control UX with permission split:
  - owner/admin can update allowlist/access policy,
  - owner only can set/clear invite password.
- Public invite acceptance page exists (`/invite/accept`) with unauthenticated preview and authenticated auto-join.

**Reasoning**

This narrows work to onboarding and delivery only, without changing unrelated world/voice systems.

**Alternatives considered**

- Assume email send exists through another path.
  - Rejected; provider-backed send path is integrated in the tenant invite service.

---

## 3. Locked Product Decisions

### 3.1 Authorization Model

**Decision**

Invite creation remains permission-gated by `tenant.invite.create` (owner/admin).

**Reasoning**

Matches existing server permission architecture and avoids role schema changes in this phase.

**Alternatives considered**

- Keep only `admin` and `member`.
  - Rejected; ownership-sensitive settings (invite password and full tenant settings) need stronger authority boundary.

### 3.2 Delivery Model

**Decision**

Use SMTP (Gmail-compatible) in v1 with fallback:

- invite is persisted even if email send fails,
- API returns fallback invite link/token for manual sharing.

**Reasoning**

Prevents provider outage/rate-limit from blocking admin onboarding tasks.

**Alternatives considered**

- Hard-fail invite creation when email send fails.
  - Rejected due to poor reliability and UX.

### 3.3 Invite Type Model

**Decision**

Support both invite types in v1:

- `personalized` invite when `inviteEmail` is present,
- `shared` invite when `inviteEmail` is omitted.

**Reasoning**

Matches product behavior: targeted one-time invites for known recipients plus reusable links for broad onboarding.

**Alternatives considered**

- Single invite model only.
  - Rejected; cannot satisfy both targeted and broad distribution flows.

### 3.4 Shared Invite Access Policy Model

**Decision**

Shared invites support tenant-level access controls:

- allowlist by domain and/or full email,
- optional password challenge for non-allowlisted shared-invite users.

**Reasoning**

Matches Gather-style onboarding where known company domains auto-join, while unknown domains require a secret.

**Alternatives considered**

- Enforce password for all shared-invite users.
  - Rejected; adds friction for expected organizational users.
- Enforce domain allowlist only with no fallback password.
  - Rejected; blocks partner/contractor onboarding without manual admin intervention.

### 3.5 Password Storage and Verification

**Decision**

Store invite password as a salted hash and verify in constant-time-safe flow.

**Reasoning**

Prevents plaintext secret storage and reduces risk from timing-based comparisons.

**Alternatives considered**

- Store plaintext invite password.
  - Rejected for security reasons.
- Reuse OAuth/session token as invite password surrogate.
  - Rejected; changes threat model and creates coupling to auth provider behavior.

---

## 4. Detailed Implementation Design

## 4.1 Invite Creation + Email Dispatch

**Decision**

Implement invite persistence and email send attempt as one server operation with explicit delivery status output.

**Design**

1. Admin submits invite from dashboard (email + role key).
2. Frontend calls `POST /tenant/:tenantId/invites`.
3. Backend validates permission and role.
4. Backend creates invite token, stores hash in `tenant_invites`, and sets `invite_type`.
5. Backend treats invites as valid only when `status='pending'` and `expires_at > now` (query-time expiry enforcement).
6. If email is provided, backend attempts SMTP send.
7. Response returns both:
   - invite link/token fallback,
   - invite metadata (`inviteType`, role, expiry),
   - delivery metadata (`attempted`, `sent`, provider, optional error code).

**Reasoning**

Guarantees onboarding artifact durability regardless of provider health.

**Alternatives considered**

- Split send into separate endpoint.
  - Rejected; adds extra orchestration and failure states without product benefit.

## 4.2 Dashboard UX Flow

**Decision**

Add invite-send UI with explicit success/fallback/error states.

**Design**

- Invite form fields: email, role.
- Submit action:
  - success + email sent banner,
  - fallback banner with copy-link/token controls,
  - error banner for validation/auth failures.
- Permission-gated rendering by `tenant.invite.create`, `tenant.invite.access.manage`, and `tenant.invite.password.manage`.

**Reasoning**

Admins need one clear path and immediate fallback when provider delivery fails.

**Alternatives considered**

- Hide fallback details from UI.
  - Rejected; forces support/manual backend involvement.

## 4.3 Shared Invite Access Enforcement

**Decision**

Enforce shared invite allowlist/password rules at join time in the service layer.

**Design**

1. User submits `join_invite` onboarding request with `inviteToken` (and optional `invitePassword`).
2. Backend resolves pending invite (`status='pending'` and `expires_at > now`).
3. Personalized invite path:
   - requires authenticated email to match invite email.
   - invite is redeemed on success.
4. Shared invite path:
   - evaluate user email/domain against tenant allowlist.
   - if user is allowlisted, join proceeds with no password challenge.
   - if user is not allowlisted and password enforcement is enabled, require and verify `invitePassword`.
   - shared invite remains reusable and is not redeemed.

**Reasoning**

Keeps authorization authoritative and consistent across all entry points using the same service function.

**Alternatives considered**

- Enforce allowlist/password in dashboard frontend only.
  - Rejected; bypassable and not portable to other entry points.

## 4.4 Dashboard Invite Access Controls UX

**Decision**

Expose invite access policy controls directly in admin dashboard settings.

**Design**

- Inputs:
  - allowlist domains (comma/newline list),
  - allowlist emails (comma/newline list),
  - toggle: require password for non-allowlisted shared-invite users,
  - password set/clear controls.
- Submit:
  - `PATCH /tenant/:tenantId/settings` with `inviteAccessConfig`.
- UX guardrails:
  - cannot enable password-required policy without configured password.
  - cannot set and clear password in one request.

**Reasoning**

Avoids manual DB edits and keeps policy management in product-admin surface.

---

## 5. API and Contract Changes

**Decision**

Add only the minimum contract needed for frontend onboarding UX.

**Changes**

- `POST /tenant/:tenantId/invites` response adds:
  - `inviteType` (`shared` or `personalized`)
  - `delivery.attempted`
  - `delivery.sent`
  - `delivery.provider`
  - `delivery.errorCode` (optional)
- Existing invite token/link response fields remain available.
- `POST /tenant/onboarding` join behavior:
  - personalized invites require authenticated user email to match invite email,
  - shared invites skip redemption and remain reusable.
  - request accepts optional `invitePassword` for shared invite password-gated joins.
- `PATCH /tenant/:tenantId/settings` now accepts `inviteAccessConfig`:
  - `allowlistDomains: string[]`
  - `allowlistEmails: string[]`
  - `requirePasswordForUnlisted: boolean`
  - `inviteJoinPassword?: string`
  - `clearInviteJoinPassword?: boolean`
- `GET /tenant/me` tenant payload includes normalized `inviteAccessConfig`:
  - `allowlistDomains`, `allowlistEmails`, `requirePasswordForUnlisted`, `hasPassword`.

**Reasoning**

Supports robust UI states without breaking current invite redemption flow.

**Alternatives considered**

- New dedicated invite-delivery status endpoint.
  - Rejected as unnecessary for synchronous v1 flow.

---

## 6. Security, Failure Modes, and Observability

**Decision**

Keep server authoritative and fail closed on auth/permission, but fail open on provider delivery by returning fallback invite link.

**Security Rules**

- Enforce `tenant.invite.create` server-side.
- Do not trust client role labels.
- Keep raw invite tokens out of DB (hash only persisted).
- Enforce invite email matching for personalized invites.

**Failure Modes**

- Delivery failure:
  - invite remains valid,
  - UI receives fallback metadata.
- Invalid email:
  - request rejected with clear 4xx error.
- Personalized invite email mismatch:
  - join request rejected (`invite_email_mismatch`).
- Shared invite reuse:
  - invite remains `pending` after successful joins and can be reused until expiry/revocation.
- Shared invite password policy:
  - non-allowlisted user with missing password -> `invite_password_required`,
  - non-allowlisted user with wrong password -> `invite_password_invalid`,
  - policy enabled but password not configured -> `invite_password_not_configured` (fail closed).
- Expired invite status sync:
  - expired links are rejected by query-time checks even if row status is still `pending`,
  - optional scheduled maintenance may update old `pending` rows to `expired` for reporting UX.

**Observability to Add**

- invite creation count,
- email attempted count,
- email sent count,
- provider failure reasons.

**Reasoning**

This keeps onboarding resilient while preserving operational visibility.

**Alternatives considered**

- No invite delivery metrics in v1.
  - Rejected; hides rollout quality and provider reliability.

---

## 7. Testing and Acceptance Criteria

**Decision**

Use mixed API + UI + onboarding redemption scenarios.

### Test Scenarios

1. Admin invite with valid email -> invite created + sent.
2. Admin invite with provider failure -> invite created + fallback returned.
3. User without invite-create permission -> forbidden.
4. Personalized invite: matching email joins successfully and invite is redeemed.
5. Personalized invite: non-matching email is denied (`invite_email_mismatch`).
6. Shared invite: multiple users can join with the same token while invite is still valid.
7. Expired/invalid invite -> redemption denied with clear reason.
8. Shared invite, allowlisted domain/email -> join succeeds without password.
9. Shared invite, non-allowlisted user + password policy enabled + missing password -> join denied (`invite_password_required`).
10. Shared invite, non-allowlisted user + wrong password -> join denied (`invite_password_invalid`).
11. Shared invite, non-allowlisted user + valid password -> join succeeds.
12. Owner/admin updates allowlist policy and `GET /tenant/me` reflects saved values.
13. Admin cannot set/clear invite password (forbidden).
14. Owner can set/clear invite password.

### Acceptance Criteria

- Admin can invite by email from dashboard.
- Admin can create reusable shared invites with no recipient email.
- Owner/admin can manage shared-invite allowlist/access policy from dashboard.
- Only owner can set/clear shared-invite password.
- Delivery failure does not block onboarding artifact creation.
- Invite join behavior is correct for both invite types.
- Shared-invite allowlist/password behavior is enforced server-side, not client-side.

**Reasoning**

These scenarios cover both reliability and access correctness.

**Alternatives considered**

- Unit-only validation.
  - Rejected; onboarding requires end-to-end behavior coverage.

---

## 8. Rollout Plan

**Decision**

Ship in controlled stages with clear rollback boundaries.

### Stages

1. Backend SMTP integration + response contract.
2. Dashboard invite-send UI + fallback UX.
3. Canary rollout with invite delivery metrics.
4. Shared-invite access controls (allowlist/password) in API + dashboard.

### Rollback Points

- Disable email sending while retaining token invite creation.
- Keep invite redemption path unchanged.
- Disable password-required policy while keeping shared invites active, if onboarding friction spikes.

**Reasoning**

Decouples provider risk from core invite workflow.

**Alternatives considered**

- Big-bang enablement across all envs.
  - Rejected due to avoidable operational risk.

---

## Implementation Notes

- This document now includes implementation-aligned behavior updates.
- Billing gating is out of scope for this feature doc.
- Owner role redesign is out of scope for this feature doc.
- As of 2026-04-10, shared invite access controls and dashboard management UI are implemented in code.
