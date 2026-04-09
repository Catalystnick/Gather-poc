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
  - seed roles in v1: `admin`, `member`
  - enforce permissions server-side (not client-provided role labels)
- `world_links` remains optional/deferred in v1 (do not block rollout).
- If tenant context lookup is unavailable:
  - existing joined sessions continue until disconnect.
  - new `world:join`, `world:change`, and LiveKit token issuance fail closed.
- Temporary instancing trigger rule (pre-Tiled):
  - remap existing `dev/design/game` zones in main plaza to portal triggers for `world:change`.
  - remove this mapping once Tiled adds dedicated portal entities.

## 3. Delivery Phases

### Implementation Status (as of 2026-04-08)

- Phase A: implemented in code.
- Phase B: implemented in code (world-scoped runtime + `world:join`/`world:change` + temporary portal mapping).
- Phase C: implemented in code (tenant/world-scoped teleport store + teleport policy guards + instance-scoped cleanup).
- Phase D: implemented in code (world-scoped LiveKit room naming + token world access validation).
- Phase E: implemented in code (world-scoped disconnect teardown + optional socket auth checkpoints + token refresh re-validation).
- Phase F: partially implemented (bootstrap + tenant settings + invite/member admin endpoints + in-game logout + tenant bootstrap gate + dashboard route + dashboard org/user list UI implemented; invite/member mutation frontend UI still pending).
- Note: production-style billing gate is not implemented yet; tenant creation currently does not require completed payment.
- Phase G: partially implemented (observability counters + internal observability endpoint + canary-oriented env flags implemented; 7-day SLO validation still pending).

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
  - route-level permission guard middleware pattern added (`requireTenantPermission('tenant.settings.manage')`): `server/middleware/requireTenantPermission.js`
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
  - `POST /tenant/onboarding` (`/tenant/bootstrap` remains alias)
  - `GET /tenant/memberships`
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
  - `PATCH /tenant/:tenantId/settings` endpoint: `server/routes/tenantRoutes.js`
  - route-level permission middleware for settings update:
    - `requireTenantPermission('tenant.settings.manage')`: `server/middleware/requireTenantPermission.js`
  - service-level validation + permission checks + config persistence:
    - `updateTenantSettings(...)`: `server/tenant/tenantService.js`
- Implemented in client UX:
  - in-game `Log out` button wired to `AuthContext.signOut()` in gameplay route shell:
    - file: `client/src/pages/GameRoute.tsx`
  - gameplay route now redirects users without membership to dashboard onboarding:
    - file: `client/src/pages/GameRoute.tsx`
  - new protected dashboard route now hosts onboarding and non-game tenant admin flows:
    - file: `client/src/pages/DashboardRoute.tsx`
  - dashboard now shows organizations joined and current-tenant users list (permission-gated):
    - file: `client/src/pages/DashboardRoute.tsx`
  - tenant admin settings panel now allows updating access policy + `tenant_access_configs` toggles from frontend:
    - file: `client/src/pages/GameRoute.tsx`
- Implemented in code:
  - `GET /tenant/memberships` for current user's joined organizations:
    - route: `server/routes/tenantRoutes.js`
    - service: `listJoinedTenants(...)` in `server/tenant/tenantService.js`
    - repository: `listActiveMembershipsByUserId(...)` in `server/tenant/tenantRepository.js`
  - `POST /tenant/:tenantId/invites` with server-side permission checks and role-based invite creation:
    - route: `server/routes/tenantRoutes.js`
    - service: `createTenantInvite(...)` in `server/tenant/tenantService.js`
  - `GET /tenant/:tenantId/members` with server-side permission checks:
    - route: `server/routes/tenantRoutes.js`
    - service: `listTenantMembers(...)` in `server/tenant/tenantService.js`
    - repository: `listActiveMembershipsForTenant(...)` in `server/tenant/tenantRepository.js`
  - `PATCH /tenant/:tenantId/members/:userId/role` with server-side permission checks and last-admin safety:
    - route: `server/routes/tenantRoutes.js`
    - service: `updateTenantMemberRole(...)` in `server/tenant/tenantService.js`
  - `DELETE /tenant/:tenantId/members/:userId` using membership disable flow with last-admin safety:
    - route: `server/routes/tenantRoutes.js`
    - service: `removeTenantMember(...)` in `server/tenant/tenantService.js`
- Pending:
  - frontend invite/member mutation UI (create invite, change role, remove member actions)

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

## 4. Code Touch Plan (Expected)

### Server

- `server/index.js`
- `server/middleware/requireAuth.js`
- `server/middleware/requireTenantPermission.js`
- `server/chat/commandRouter.js`
- `server/chat/teleportRequestsStore.js`
- `server/tenant/tenantService.js`
- `server/tenant/tenantRepository.js`
- `server/tenant/accessConfigMapper.js`
- `server/routes/tenantRoutes.js`
- `server/routes/livekitTokenRoute.js`
- `server/socket/registerGameSocketHandlers.js`
- `server/world/runtime.js`
- `supabase/migrations/*`
- `server/tests/tenantRlsPolicies.test.js`
- `server/tests/worldRuntimePartitioning.test.js`

### Client

- `client/src/hooks/useSocket.ts`
- `client/src/hooks/useChat.ts`
- `client/src/hooks/useVoice.ts`
- `client/src/utils/voiceRoom.ts`
- `client/src/components/scene/World.tsx`
- `client/src/contexts/*` (tenant context additions)
- `client/src/pages/DashboardRoute.tsx`

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
