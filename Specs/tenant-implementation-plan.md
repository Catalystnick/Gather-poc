# Tenant Implementation Plan (Execution)

This document is the execution plan for [`tenant-architecture-plan.md`](./tenant-architecture-plan.md).
It translates architecture intent into build phases, concrete code changes, migration steps, and rollout gates.
In this plan, `tenant` means a tenant organization/workspace owner.

## 1. Scope and Boundaries

### In scope

- Tenant-aware auth/context resolution for REST + socket flows.
- Main plaza + tenant interior runtime partitioning.
- Instance-scoped snapshot/chat/tag/teleport behavior.
- Interior-only voice room namespacing + token authorization.
- RLS enablement and rollout hardening.
- Dashboard-first tenant onboarding without billing enforcement.

### Out of scope for this plan

- Map format migration concerns (LDtk/Tiled pipeline) are intentionally excluded for now.
- Redis multi-node ownership and plaza sharding (covered in [`performance-and-scaling.md`](./performance-and-scaling.md)).
- Billing integration and payment-gated workspace/org creation.

## 2. v1 Behavioral Decisions (Locked)

These decisions close ambiguities raised in architecture review issue 13.x.

- `public` tenant interiors allow non-member visitors to enter.
- `private` tenant interiors deny non-member visitors.
- Guest/member interaction behavior inside interiors is config-driven via a backend-managed per-tenant access config table (not additional `access_policy` enum variants).
- Visitors may appear in presence and receive/send interior text chat.
- Visitors may be discoverable by mention and tag within the current instance.
- When `guest_zone_enforced=true`, visitors are confined to a tenant-defined visitor zone (zone key TBD).
- In v1 defaults, visitor chat/tag is enabled and visitor teleport remains disabled unless explicitly expanded later.
- Visitor elevation/revocation is backend-managed; tenant members/admins (permission-gated server checks) can grant and revoke elevated access.
- Visitor zone identifier is map-configured and remains TBD until zone schema is finalized.
- Teleport is membership-restricted in v1:
  - sender and target must both be active members of the same tenant.
  - sender and target must both be in the same interior instance.
  - visitors cannot send/receive teleport until a future visitor policy expansion.
- Main plaza has global text chat and no proximity/zone voice.
- Main plaza can include a map-defined `town_hall`/common-room zone for social gathering; this is a plaza feature, not a tenant interior access policy.
- Authorization model uses roles + permissions:
  - seed roles in current implementation: `owner`, `admin`, `member`
  - enforce permissions server-side (not client-provided role labels)
- `world_links` remains optional/deferred in v1 (do not block rollout).
- If tenant context lookup is unavailable:
  - existing joined sessions continue until disconnect.
  - new `world:join`, `world:change`, and LiveKit token issuance fail closed.
- Temporary instancing trigger rule (pre-Tiled):
  - remap existing `dev/design/game` zones in main plaza to portal triggers for `world:change`.
  - remove this mapping once Tiled adds dedicated portal entities.

## 3. Delivery Phases

### Implementation Status (as of 2026-04-10)

- Phase A: implemented in code.
- Phase B: implemented in code (world-scoped runtime + `world:join`/`world:change` + temporary portal mapping).
- Phase C: implemented in code (tenant/world-scoped teleport store + teleport policy guards + instance-scoped cleanup).
- Phase D: implemented in code (world-scoped LiveKit room naming + token world access validation).
- Phase E: implemented in code (world-scoped disconnect teardown + optional socket auth checkpoints + token refresh re-validation).
- Phase F: partially implemented (bootstrap + tenant settings + invite/member admin endpoints + in-game logout + tenant bootstrap gate + dashboard route + admin-gated org/member list UI + invite creation UI/email dispatch implemented; member role/remove mutation frontend UI still pending).
- Note: production-style billing gate is not implemented yet; tenant creation currently does not require completed payment.
- Phase G: partially implemented (observability counters + internal observability endpoint + canary-oriented env flags implemented; 7-day SLO validation still pending).
- Phase H (post-launch cleanup): completed — see section 3.8.
- Phase L (invite access controls): implemented in code — see section 3.9.
- Phase M (owner role + permission split): implemented in code — see section 3.10.

## 3.1 Phase A - Foundations (Schema, RLS, Tenant Service)

### Goals

- Stand up tenant schema and policies.
- Introduce a central `TenantService` used by REST and sockets.
- Make rollout safe with staged feature flags.

### Work items

- Add DB migrations for:
  - `tenants`
  - `roles`
  - `permissions`
  - `role_permissions`
  - `tenant_memberships`
  - `tenant_access_configs`
  - `worlds`
  - `tenant_invites`
- keep tenant `access_policy` coarse (`public|private`) and enforce fine-grained behavior through `tenant_access_configs`
- Seed one `main_plaza` world row.
- Add constraints/indexes from architecture section 4.
- Enable RLS policies for tenant-owned tables.
- Add `server/tenant/tenantService.js` with:
  - `resolveTenantContext(userId)`
  - `resolveMainPlazaWorld()`
  - `resolveTenantInteriorWorld(tenantId)`
  - `canAccessWorld(userId, worldId)`
  - permission checks for admin endpoints (seeded via role-permission mappings)
- Add short-lived in-memory cache for tenant context (`TTL`, e.g. 60s) to reduce DB pressure.

### Acceptance

- RLS policies active and tested with non-service role.
- `GET /tenant/me` resolves tenant + world context.
- Tenant service can be called from both REST and socket layers.

### Status (2026-04-08)

- Implemented in code:
  - migration + seed + constraints + RLS: `supabase/migrations/20260407075655_phase_a_tenant_schema.sql`
  - RBAC extension migration (roles/permissions/role_permissions + membership/invite role_id backfill): `supabase/migrations/20260408093000_phase_h_rbac_roles_permissions.sql`
  - tenant access config migration (table + backfill + RLS + defaults): `supabase/migrations/20260408113000_phase_i_tenant_access_configs.sql`
  - tenant service methods + TTL cache: `server/tenant/tenantService.js`
  - tenant repository/context now resolves role key + permission set + tenant access config: `server/tenant/tenantRepository.js`
  - `GET /tenant/me`: `server/routes/tenantRoutes.js`
  - `PATCH /tenant/:tenantId/settings` (access policy + access config update, permission-gated): `server/routes/tenantRoutes.js`
  - socket calls tenant service on join path: `server/socket/registerGameSocketHandlers.js`
  - staged feature flags: `ENABLE_TENANT_ROUTES`, `ENABLE_TENANT_SOCKET_CONTEXT`
  - RLS non-service-role integration test added: `server/tests/tenantRlsPolicies.test.js` (env-gated)

## 3.2 Phase B - Realtime Runtime Partitioning

### Goals

- Replace global runtime state with world-instance partitions.

### Work items

- Replace global `players` with:
  - `playersByWorld: Map<worldId, Map<userId, PlayerState>>`
  - `socketWorldIndex: Map<socketId, worldId>`
- Add socket room model:
  - `user:{userId}` personal room
  - `world:{worldId}` active instance room
- Update simulation/snapshot loop:
  - iterate active worlds
  - emit `world:snapshot` to `world:{worldId}` only
- Update join/change events:
  - `world:join` (entry)
  - `world:change` (instance switch with loading acknowledgment payload)
- Add temporary portal trigger mapping for test runs:
  - `dev -> interior_world_dev`
  - `design -> interior_world_design`
  - `game -> interior_world_game`
  - (replace with Tiled-defined portal entities later)

### Acceptance

- No global `io.emit('world:snapshot')` in runtime path.
- Players in one interior never appear in another interior/plaza snapshots.

### Status (2026-04-07)

- Implemented in code:
  - world-partitioned runtime:
    - `playersByWorld: Map<worldId, Map<userId, PlayerState>>`
    - `socketWorldIndex: Map<socketId, worldId>`
  - socket room model:
    - `user:{userId}`
    - `world:{worldId}`
  - world-scoped snapshots:
    - snapshot loop iterates active worlds and emits to `world:{worldId}` only
  - world join/change contracts:
    - `world:join`
    - `world:change`
    - `player:join` kept as backward-compatible alias
  - temporary portal mapping for test runs:
    - `dev -> interior_world_dev`
    - `design -> interior_world_design`
    - `game -> interior_world_game`
  - client updated to use `world:join` and trigger `world:change` via temporary zone mapping.
- Validation:
  - no global `io.emit('world:snapshot')` path remains
  - added runtime partitioning test: `server/tests/worldRuntimePartitioning.test.js`

## 3.3 Phase C - Interaction Scoping + Teleport Store Rewrite

### Goals

- Make interaction behavior world- and tenant-safe.

### Work items

- Rewrite `TeleportRequestsStore` key space to include context:
  - `worldId`
  - `tenantId`
  - `senderId`
  - `targetId`
- Enforce event scoping in handlers:
  - chat/tag/mentions resolved from current instance only
  - teleport only for same-tenant members in same interior instance
  - reject teleport in `main_plaza`
- Ensure cooldown and cleanup are scoped to instance context.

### Acceptance

- Cross-tenant teleport requests are rejected.
- Cross-instance mentions/tags/teleport do not resolve.
- Disconnect clears only relevant instance-scoped requests.

### Status (2026-04-07)

- Implemented in code:
  - teleport request store is now scoped by `worldId`, `tenantId`, `senderId`, and `targetId`: `server/chat/teleportRequestsStore.js`
  - teleport request/response handlers now require scoped context (`worldId`, `tenantId`): `server/chat/commandRouter.js`
  - socket guards enforce:
    - `main_plaza` teleport denial
    - same-tenant active-member teleport policy in the active interior world
    - world-scoped disconnect cleanup for pending teleport requests
  - references: `server/socket/registerGameSocketHandlers.js`
- Validation:
  - updated store and movement tests:
    - `server/tests/teleportRequestsStore.test.js`
    - `server/tests/teleportMovementState.test.js`

## 3.4 Phase D - LiveKit Refactor (Dedicated)

### Goals

- Move from static global room names to world-scoped interior rooms.

### Work items

- Client room naming:
  - proximity: `gather-tenant-interior-{worldId}`
  - zone: `gather-tenant-interior-{worldId}-zone-{zoneKey}`
- Server `/livekit/token` validation:
  - validate requested `worldId` is a tenant interior
  - validate caller can access that world via `TenantService`
  - deny main plaza room issuance
- Remove static `ALLOWED_ROOMS` dependency on fixed literal names.

### Acceptance

- Users in different interior instances never share voice rooms.
- No voice token can be minted for unauthorized world access.

### Status (2026-04-08)

- Implemented in code:
  - server token route now validates `worldId`, enforces `tenant_interior` world type, checks access via tenant service, and derives room names server-side:
    - proximity: `gather-tenant-interior-{worldId}`
    - zone: `gather-tenant-interior-{worldId}-zone-{zoneKey}`
    - file: `server/routes/livekitTokenRoute.js`
  - removed static allowed room dependency from token issuance path.
  - client voice utilities now derive room names from `worldId` and send `worldId`/`zoneKey` to `/livekit/token`:
    - file: `client/src/utils/voiceRoom.ts`
  - `useVoice` now receives `worldId`, skips setup when unavailable, and scopes zone token cache/backoff by world+zone:
    - file: `client/src/hooks/useVoice.ts`
  - `World` now forwards active world id into voice hook:
    - file: `client/src/components/scene/World.tsx`
- Validation:
  - added LiveKit route helper tests: `server/tests/livekitTokenRoute.test.js`

## 3.5 Phase E - Disconnect Teardown + Session Security

### Goals

- Make teardown deterministic and secure for long sessions.

### Work items

- Define and implement ordered disconnect teardown:
  - resolve `worldId` from socket index
  - remove from `playersByWorld[worldId]`
  - clear instance-scoped teleport requests
  - emit `player:left` to `world:{worldId}` only
  - emit updated instance snapshot only for that world
- Add token rotation handling policy:
  - client updates `socket.auth` on refresh
  - server enforces re-auth at reconnect and optionally at periodic checkpoints
  - document long-session behavior and rejection semantics

### Acceptance

- No global `player:left` leaks.
- Long sessions remain secure without silent indefinite trust.

### Status (2026-04-08)

- Implemented in code:
  - world-scoped disconnect teardown already active in socket handlers:
    - resolves world from socket index, removes world player state, clears world-scoped teleport requests, emits `player:left` only to `world:{worldId}`, emits world snapshot only for that world.
    - file: `server/socket/registerGameSocketHandlers.js`
  - server now supports optional periodic auth checkpoints for connected sockets:
    - verifies checkpoint token against Supabase JWKS and rejects subject mismatch/invalid token.
    - controlled by env vars:
      - `SOCKET_AUTH_CHECKPOINT_MS` (set `>0` to enable, default `0` disabled)
      - `SOCKET_AUTH_CHECKPOINT_TIMEOUT_MS` (ack timeout, default `10000`)
    - files: `server/index.js`, `server/socket/registerGameSocketHandlers.js`, `server/middleware/requireAuth.js`
  - client now handles server checkpoint requests and emits refresh validation:
    - responds to `auth:checkpoint` with the latest token.
    - sends `auth:refresh` when access token updates while connected.
    - file: `client/src/hooks/useSocket.ts`

## 3.6 Phase F - Admin APIs + UX Integration

### Goals

- Finalize tenant bootstrap/admin flows in product UX.
- Keep gameplay UX focused while moving non-game administration to a dashboard surface.

### Work items

- Implement/finish:
  - `POST /tenant/onboarding`
  - `POST /tenant/:tenantId/invites`
  - `GET /tenant/:tenantId/members`
  - `PATCH /tenant/:tenantId/members/:userId/role`
  - `DELETE /tenant/:tenantId/members/:userId`
  - `PATCH /tenant/:tenantId/settings` (includes `tenant_access_configs` updates)
- Add client `TenantContext` bootstrap gate.
- Add in-game admin settings UI for policy toggles backed by `tenant_access_configs`.
- Add a protected dashboard route for onboarding + organization administration flows.
- Add world transition loading state tied to `world:change` ack.
- Add in-game logout action in the authenticated gameplay shell.

### Acceptance

- Admin/member permissions enforced server-side.
- Permission enforcement is server-side and role-key changes do not require schema changes.
- Client cannot enter gameplay route without resolved tenant context.
- Tenant admins can update policy toggles from frontend, and runtime behavior reflects backend-saved config.
- Onboarding/invite/member-role administration is dashboard-first (`/dashboard`), not embedded in the gameplay shell.

### Status (2026-04-08)

- Implemented in code:
  - `PATCH /tenant/:tenantId/settings` endpoint with service-layer permission enforcement: `server/routes/tenantRoutes.js`
  - service-level validation + permission checks + config persistence:
    - `updateTenantSettings(...)`: `server/tenant/tenantService.js`
- Implemented in client UX:
  - in-game `Log out` button wired to `AuthContext.signOut()` in gameplay route shell:
    - file: `client/src/pages/game/GameRoute.tsx`
  - gameplay route now redirects users without membership to dashboard onboarding:
    - file: `client/src/pages/game/GameRoute.tsx`
  - new protected dashboard route now hosts onboarding and non-game tenant admin flows:
    - file: `client/src/pages/dashboard/DashboardRoute.tsx`
  - dashboard admin sections are permission-gated (`tenant.members.manage`, `tenant.invite.create`, `tenant.invite.access.manage`) rather than hard-coded role-name checks:
    - file: `client/src/pages/dashboard/DashboardRoute.tsx`
  - member list renders the minimal server payload (`membershipId`, `userId`, `email`, `displayName`, `roleKey`) from a single backend query:
    - file: `client/src/pages/dashboard/DashboardRoute.tsx`
  - tenant admin settings panel now allows updating access policy + `tenant_access_configs` toggles from frontend:
    - file: `client/src/pages/game/GameRoute.tsx`
- Implemented in code:
  - `POST /tenant/:tenantId/invites` with service-layer permission checks and role-based invite creation:
    - route: `server/routes/tenantRoutes.js`
    - service: `createTenantInvite(...)` in `server/tenant/tenantService.js`
  - `GET /tenant/:tenantId/members` with service-layer permission checks; returns only dashboard-needed fields (`membershipId`, `userId`, `email`, `displayName`, `roleKey`) via `tenant_member_profiles` view (single DB query):
    - route: `server/routes/tenantRoutes.js`
    - service: `listTenantMembers(...)` in `server/tenant/tenantService.js`
    - repository: `listActiveMembershipsForTenant(...)` in `server/tenant/tenantRepository.js`
    - migration: `supabase/migrations/20260410120000_phase_j_tenant_member_profiles_view.sql` + `20260410130000_phase_j1_fix_tenant_member_profiles_view.sql`
  - `PATCH /tenant/:tenantId/members/:userId/role` with service-layer permission checks, owner-role hierarchy checks, and last-owner safety:
    - route: `server/routes/tenantRoutes.js`
    - service: `updateTenantMemberRole(...)` in `server/tenant/tenantService.js`
  - `DELETE /tenant/:tenantId/members/:userId` using membership disable flow with owner-role hierarchy checks and last-owner safety:
    - route: `server/routes/tenantRoutes.js`
    - service: `removeTenantMember(...)` in `server/tenant/tenantService.js`
- Pending:
  - frontend member mutation UI (change role, remove member actions)

## 3.8 Phase H - Post-Launch Code Quality and Architecture Hardening

### Goals

- Remove dead code and redundant logic identified in post-implementation review.
- Enforce correct architectural boundaries (auth vs authorization, middleware vs service layer).
- Eliminate N+1 query patterns in member resolution.
- Harden security posture of auth and invite flows.

### Work items completed (2026-04-10)

**Auth flow:**
- Fixed OAuth invite token loss for first-time Google sign-in users: `signInWithGoogle` now embeds `?next=<encoded-path>` in `redirectTo` URL, mirroring the email signup pattern. Token survives the OAuth redirect chain via URL rather than relying solely on `localStorage`.
- Enforced PKCE flow explicitly (`flowType: 'pkce'`) in Supabase client config: `client/src/lib/supabase.ts`.
- Removed implicit OAuth hash-parsing dead code (`hashParams`, `hasHashSessionParams`): `client/src/lib/supabase.ts`.
- Removed raw `access_token` logging from `onAuthStateChange`.

**Authorization architecture:**
- Removed `requireTenantPermission` middleware from all routes. Authorization is now exclusively service-layer via `ensureTenantPermission(...)`. Rationale: middleware was coupled to Express `req.params` (unusable from socket handlers), duplicated DB permission checks, and violated the principle that the service layer owns business rules.
- Removed `isTenantAdmin` export from `tenantService.js` (functionality is a subset of `hasTenantPermission`; no callers existed).

**Dead endpoint removal:**
- Removed `POST /tenant/bootstrap` alias — use `POST /tenant/onboarding`.
- Removed `GET /tenant/memberships` — current tenant data is fully served by `GET /tenant/me`; dashboard org section now reads from already-loaded `tenantContext`.
- Removed `listJoinedTenants` service function and `listActiveMembershipsByUserId` repository import (no longer referenced).

**Member profile resolution — N+1 eliminated:**
- Introduced `tenant_member_profiles` Postgres view (`public` schema) joining `tenant_memberships → auth.users → roles` with `LEFT JOIN` to handle deleted users gracefully.
- `GET /tenant/:tenantId/members` now resolves `membershipId`, `userId`, `email`, `displayName`, and `roleKey` in one PostgREST query instead of N parallel Auth Admin API calls.
- Repository now selects only `id,user_id,role_key,email,display_name` from `tenant_member_profiles` for this endpoint.
- View access revoked from `public`, `anon`, and `authenticated` roles — accessible only via service-role key.
- Migrations: `20260410120000_phase_j_tenant_member_profiles_view.sql`, `20260410130000_phase_j1_fix_tenant_member_profiles_view.sql`.

**Invite model hardening (shared vs personalized):**
- Added invite type support (`shared` vs `personalized`) in `tenant_invites` and backfilled existing rows:
  - migration: `supabase/migrations/20260410153000_phase_k_invite_types.sql`
- Invite creation now sets:
  - `personalized` when `inviteEmail` is present
  - `shared` when no email is provided
- Invite join flow now enforces email match for personalized invites (`invite_email_mismatch` on mismatch).
- Personalized invites are redeemed (single-use). Shared invites remain `pending` and reusable until expiry/revocation.
- Invite expiry is enforced at read-time (`status = pending` and `expires_at > now`) when resolving invite tokens; backend does not need to synchronously rewrite status to reject expired links.
- Optional cleanup/reporting improvement: a scheduled DB job can mark stale `pending` rows as `expired` for admin visibility, without changing authorization correctness.
- Onboarding route now passes authenticated email into service join logic:
  - `joinTenantFromInvite({ userId, userEmail, inviteToken })`

**Tenant context pattern cleanup:**
- Replaced ad-hoc tenant context hook usage with a standard provider pattern:
  - `TenantContextProvider` in `client/src/contexts/TenantContext.tsx`
  - App-level wiring in `client/src/App.tsx`
  - consumers (`DashboardRoute`, `GameRoute`) now call `useTenantContext()` without passing tokens.

**Tenant context cache hardening:**
- Added `TENANT_CONTEXT_CACHE_MAX = 10_000` cap to in-memory TTL cache in `tenantService.js`. Evicts oldest entry (insertion-order) when limit is reached, preventing unbounded memory growth under sustained load.

**Dashboard data loading:**
- Permission-gated data (member list/org admin surfaces) is not fetched for users without management permissions. `loadDashboardData` now bails early unless the user has `tenant.members.manage`.
- Org information section now reads directly from `tenantContext.tenant` (already in memory) rather than issuing a redundant `/tenant/memberships` fetch.
- Member list displays `displayName` (from Google OAuth metadata) or `email`, falling back to `userId` only if both are unavailable.

### Migrations introduced

| File | Purpose |
|---|---|
| `20260410120000_phase_j_tenant_member_profiles_view.sql` | Creates `tenant_member_profiles` view with LEFT JOINs and role revocation |
| `20260410130000_phase_j1_fix_tenant_member_profiles_view.sql` | Drops and recreates view with correct column aliases (`role_key` not `role_id`) |
| `20260410153000_phase_k_invite_types.sql` | Adds `tenant_invites.invite_type` (`shared`/`personalized`), backfills from `email_optional`, and enforces personalized-email consistency |
| `20260410170000_phase_l_invite_access_controls.sql` | Adds shared-invite allowlist/password policy fields to `tenant_access_configs` with password-required consistency constraint |
| `20260410193000_phase_m_owner_role_and_invite_permission_split.sql` | Adds `owner` role, splits invite access/password permissions, removes admin password/settings authority, and backfills tenant creators to owner |

## 3.9 Phase L - Shared Invite Access Controls (Allowlist + Password)

### Goals

- Support Gather-style shared invite admission controls:
  - allowlist by email/domain for automatic join,
  - optional password requirement for non-allowlisted users.
- Keep personalized invite behavior unchanged (email-bound + single-use).

### Work items completed (2026-04-10)

- DB model extended in `tenant_access_configs`:
  - `invite_allowlist_domains text[]`
  - `invite_allowlist_emails text[]`
  - `invite_require_password_for_unlisted boolean`
  - `invite_password_hash text`
  - constraint requires hash when password enforcement is enabled
  - migration: `supabase/migrations/20260410170000_phase_l_invite_access_controls.sql`
- Server-side shared invite join enforcement:
  - loads tenant invite access config
  - checks allowlisted email/domain
  - requires and verifies invite password for non-allowlisted users when configured
  - error codes:
    - `invite_password_required`
    - `invite_password_invalid`
    - `invite_password_not_configured` (fail-closed policy misconfiguration)
  - file: `server/tenant/tenantService.js`
- Invite password handling:
  - scrypt-based hashing + timing-safe verification
  - minimum/maximum length checks
  - never stores plaintext password
  - file: `server/tenant/tenantService.js`
- Settings API and tenant context updates:
  - `PATCH /tenant/:tenantId/settings` accepts `inviteAccessConfig`
  - `GET /tenant/me` tenant payload includes normalized `inviteAccessConfig`
  - files: `server/routes/tenantRoutes.js`, `server/tenant/tenantRepository.js`, `server/tenant/accessConfigMapper.js`
- Dashboard admin UX for invite access controls:
  - manage allowlist domains/emails
  - toggle password enforcement for non-allowlisted users
  - set/clear invite join password
  - files: `client/src/pages/dashboard/DashboardRoute.tsx`, `client/src/pages/dashboard/TenantDashboardView.tsx`, `client/src/pages/dashboard/dashboardApi.ts`
- Onboarding and invite acceptance UX:
  - onboarding join supports optional `invitePassword`
  - invite accept page redirects authenticated users to `/dashboard?inviteToken=...` when password is required/invalid, enabling retry flow
  - dashboard auto-join view now supports password prompt only when backend requires it
  - files: `client/src/contexts/TenantContext.tsx`, `client/src/pages/invite/InviteAcceptPage.tsx`, `client/src/pages/dashboard/DashboardStateViews.tsx`

### Acceptance

- Allowlisted shared-invite users can join without password.
- Non-allowlisted shared-invite users are blocked unless valid invite password is provided (when enabled).
- Personalized invites remain email-bound and redeem on successful join.
- Owner/admin can configure invite allowlists from dashboard; only owner can set/clear invite access passwords.

## 3.10 Phase M - Owner Role + Permission Split

### Goals

- Make tenant creator the authoritative `owner`.
- Allow admins to manage users and allowlists, but prevent admin invite-password changes.

### Work items completed (2026-04-10)

- RBAC migration added:
  - introduces `owner` system role,
  - introduces `tenant.invite.access.manage` and `tenant.invite.password.manage` permissions,
  - assigns owner full permissions,
  - removes `tenant.settings.manage` and `tenant.invite.password.manage` from admin role,
  - backfills active creator memberships (`tenants.created_by`) to owner.
  - migration: `supabase/migrations/20260410193000_phase_m_owner_role_and_invite_permission_split.sql`
- Server authorization split:
  - `updateTenantSettings(...)` now enforces permission by patch type:
    - `tenant.settings.manage` for core tenant settings,
    - `tenant.invite.access.manage` for allowlist/access policy changes,
    - `tenant.invite.password.manage` for password hash set/clear.
  - file: `server/tenant/tenantService.js`
- Membership hierarchy controls:
  - non-owner cannot assign/manage/remove `owner` role,
  - last owner cannot be demoted/removed.
  - file: `server/tenant/tenantService.js`
- Onboarding ownership:
  - tenant creator is assigned `owner` role at tenant creation.
  - file: `server/tenant/tenantService.js`
- Dashboard permission UX:
  - admin surfaces now use permission checks (not `roleKey === "admin"`),
  - invite password controls are owner-only in UI.
  - files: `client/src/pages/dashboard/DashboardRoute.tsx`, `client/src/pages/dashboard/TenantDashboardView.tsx`

---

## 3.7 Phase G - Hardening, Rollout, and Cleanup

### Goals

- Ship safely with controlled feature-flag rollout.

### Work items

- Canary rollout with feature flags by environment.
- Add observability:
  - join/change success/failure rates
  - per-instance player counts
  - snapshot payload size and tick lag
  - LiveKit token rejection reasons

### Acceptance

- Stability SLOs achieved for 7 consecutive days.

### Status (2026-04-09)

- Implemented in code:
  - canary-oriented environment flags:
    - `ENABLE_INTERNAL_OBSERVABILITY_ROUTES`
    - `OBSERVABILITY_LOG_INTERVAL_MS`
    - `OBSERVABILITY_INTERNAL_KEY` (optional key for internal observability endpoint)
    - files: `server/index.js`, `server/.env.example`
  - in-memory observability module:
    - world join success/failure counts + reasons
    - world change success/failure counts + reasons
    - LiveKit token issued/rejected counts + rejection reasons
    - snapshot payload stats (`last/max/avg bytes`) + tick lag (`last/max`)
    - per-world player counts
    - file: `server/observability/tenantObservability.js`
  - socket instrumentation for world join/change outcomes:
    - file: `server/socket/registerGameSocketHandlers.js`
  - runtime snapshot instrumentation:
    - file: `server/world/runtime.js`
  - LiveKit token rejection reason instrumentation:
    - file: `server/routes/livekitTokenRoute.js`
  - internal endpoint for canary monitoring:
    - `GET /internal/observability`
    - file: `server/index.js`
- Pending:
  - production SLO validation and 7-day stability signoff

## 4. Code Touch Plan (Actual)

### Server

- `server/index.js`
- `server/middleware/requireAuth.js`
- ~~`server/middleware/requireTenantPermission.js`~~ — removed; authorization is service-layer only
- `server/chat/commandRouter.js`
- `server/chat/teleportRequestsStore.js`
- `server/tenant/tenantService.js`
- `server/tenant/tenantRepository.js`
- `server/tenant/accessConfigMapper.js`
- `server/routes/tenantRoutes.js`
- `server/routes/livekitTokenRoute.js`
- `server/socket/registerGameSocketHandlers.js`
- `server/world/runtime.js`
- `supabase/migrations/20260407075655_phase_a_tenant_schema.sql`
- `supabase/migrations/20260408070129_phase_h_rbac_roles_permissions.sql`
- `supabase/migrations/20260408093000_phase_h_rbac_roles_permissions.sql`
- `supabase/migrations/20260408113000_phase_i_tenant_access_configs.sql`
- `supabase/migrations/20260410120000_phase_j_tenant_member_profiles_view.sql`
- `supabase/migrations/20260410130000_phase_j1_fix_tenant_member_profiles_view.sql`
- `supabase/migrations/20260410153000_phase_k_invite_types.sql`
- `supabase/migrations/20260410170000_phase_l_invite_access_controls.sql`
- `supabase/migrations/20260410193000_phase_m_owner_role_and_invite_permission_split.sql`
- `server/tests/tenantRlsPolicies.test.js`
- `server/tests/worldRuntimePartitioning.test.js`

### Client

- `client/src/lib/supabase.ts`
- `client/src/contexts/AuthContext.tsx`
- `client/src/hooks/useSocket.ts`
- `client/src/hooks/useChat.ts`
- `client/src/hooks/useVoice.ts`
- `client/src/contexts/TenantContext.tsx`
- `client/src/App.tsx`
- `client/src/utils/voiceRoom.ts`
- `client/src/utils/nextPath.ts`
- `client/src/components/auth/ProtectedRoute.tsx`
- `client/src/components/scene/World.tsx`
- `client/src/pages/auth/AuthCallbackPage.tsx`
- `client/src/pages/auth/LoginPage.tsx`
- `client/src/pages/auth/SignupPage.tsx`
- `client/src/pages/auth/VerifyPendingPage.tsx`
- `client/src/pages/dashboard/DashboardRoute.tsx`
- `client/src/pages/dashboard/DashboardStateViews.tsx`
- `client/src/pages/dashboard/TenantDashboardView.tsx`
- `client/src/pages/dashboard/dashboardApi.ts`
- `client/src/pages/invite/InviteAcceptPage.tsx`

## 5. Test Plan by Phase

### Automated tests

- Unit:
  - tenant access checks
  - teleport store scoped keys + cooldown behavior
  - world-scoped mention/tag filtering
- Integration:
  - `world:join` and `world:change` transitions
  - disconnect teardown path
  - LiveKit token authorization by world access
- Security:
  - permission enforcement on admin endpoints
  - RLS policy checks for non-service roles

### Manual QA

- Two accounts, different tenants:
  - isolate snapshots/chat/teleport/voice in interiors
- Portal trigger validation (pre-Tiled):
  - entering remapped `dev/design/game` trigger zones causes `world:change` and loading transition.
- Public interior visitor behavior:
  - config-driven behavior applied (zone confinement toggle + chat/tag toggles)
  - teleport denied for non-members
- Shared invite access controls:
  - allowlisted domains/emails auto-join with shared invites
  - non-allowlisted users require invite password when policy enabled
  - invalid/missing password is rejected with clear join error codes
- Main plaza behavior:
  - global text chat works
  - `town_hall`/common-room zone behavior is plaza-scoped and independent from tenant interior access config
  - proximity/zone voice unavailable

## 6. Rollback Strategy

- Keep feature flags for each major capability until cutover complete.
- If Phase C/D regression appears:
  - disable tenant routing flag
  - restrict transitions and keep users in main plaza until fix is deployed.
- If Phase E regression appears:
  - disable voice namespacing flag
  - keep text/presence gameplay operational while voice is repaired.

## 7. Exit Criteria for v1 Completion

- Tenant bootstrap and admin APIs operational with permission enforcement.
- Runtime is world-scoped (`playersByWorld`) with no global snapshot/player leakage.
- Teleport/chat/tag behavior matches tenant and instance policy.
- Interior voice is fully world-namespaced and authorized.
- RLS enabled on tenant tables and validated in CI.
