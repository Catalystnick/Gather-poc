# Tenant Invite Email Onboarding Implementation Plan

## 1. Purpose and Scope

**Decision**

Define a planning-only, implementation-ready blueprint for onboarding employees into tenant organizations via admin-sent invite emails from the dashboard.

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
- Dashboard exists but does not provide a full “send invite email” experience.
- No email provider integration is currently active in tenant invite flow.

**Reasoning**

This narrows work to onboarding and delivery only, without changing unrelated world/voice systems.

**Alternatives considered**

- Assume email send exists through another path.
  - Rejected; no integrated provider-backed invite send path is present.

---

## 3. Locked Product Decisions

### 3.1 Authorization Model

**Decision**

Invite creation remains permission-gated by `tenant.invite.create` (admin-only in v1 behavior).

**Reasoning**

Matches existing server permission architecture and avoids role schema changes in this phase.

**Alternatives considered**

- Introduce owner role now.
  - Rejected for v1 to avoid role migration churn.

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

---

## 4. Detailed Implementation Design

## 4.1 Invite Creation + Email Dispatch

**Decision**

Implement invite persistence and email send attempt as one server operation with explicit delivery status output.

**Design**

1. Admin submits invite from dashboard (email + role key).
2. Frontend calls `POST /tenant/:tenantId/invites`.
3. Backend validates permission and role.
4. Backend creates invite token, stores hash in `tenant_invites`.
5. If email is provided, backend attempts SMTP send.
6. Response returns both:
   - invite link/token fallback,
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
- Permission-gated rendering by `tenant.invite.create`.

**Reasoning**

Admins need one clear path and immediate fallback when provider delivery fails.

**Alternatives considered**

- Hide fallback details from UI.
  - Rejected; forces support/manual backend involvement.

---

## 5. API and Contract Changes

**Decision**

Add only the minimum contract needed for frontend onboarding UX.

**Changes**

- `POST /tenant/:tenantId/invites` response adds:
  - `delivery.attempted`
  - `delivery.sent`
  - `delivery.provider`
  - `delivery.errorCode` (optional)
- Existing invite token/link response fields remain available.

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

**Failure Modes**

- Delivery failure:
  - invite remains valid,
  - UI receives fallback metadata.
- Invalid email:
  - request rejected with clear 4xx error.

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
3. Non-admin invite -> forbidden.
4. New user receives link, signs up, redeems invite -> active membership.
5. Expired/invalid invite -> redemption denied with clear reason.

### Acceptance Criteria

- Admin can invite by email from dashboard.
- Delivery failure does not block onboarding artifact creation.
- Invite redemption flow remains stable.

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

### Rollback Points

- Disable email sending while retaining token invite creation.
- Keep invite redemption path unchanged.

**Reasoning**

Decouples provider risk from core invite workflow.

**Alternatives considered**

- Big-bang enablement across all envs.
  - Rejected due to avoidable operational risk.

---

## Implementation Notes

- Planning only; no implementation in this document.
- Billing gating is out of scope for this feature doc.
- Owner role redesign is out of scope for this feature doc.
