# Tenant Implementation Plan (Execution)

This document is the execution plan for [`tenant-architecture-plan.md`](./tenant-architecture-plan.md).
It translates architecture intent into build phases, concrete code changes, migration steps, and rollout gates.

## 1. Scope and Boundaries

### In scope

- Tenant-aware auth/context resolution for REST + socket flows.
- Main plaza + tenant interior runtime partitioning.
- Instance-scoped snapshot/chat/tag/teleport behavior.
- Interior-only voice room namespacing + token authorization.
- RLS enablement and rollout hardening.

### Out of scope for this plan

- Map format migration concerns (LDtk/Tiled pipeline) are intentionally excluded for now.
- Redis multi-node ownership and plaza sharding (covered in [`performance-and-scaling.md`](./performance-and-scaling.md)).

## 2. v1 Behavioral Decisions (Locked)

These decisions close ambiguities raised in architecture review issue 13.x.

- `public` tenant interiors allow non-member visitors to enter.
- Visitors may appear in presence and receive/send interior text chat.
- Visitors may be discoverable by mention and tag within the current instance.
- Teleport is membership-restricted in v1:
  - sender and target must both be active members of the same tenant.
  - sender and target must both be in the same interior instance.
  - visitors cannot send/receive teleport until a future visitor policy expansion.
- Main plaza has global text chat and no proximity/zone voice.
- `world_links` remains optional/deferred in v1 (do not block rollout).
- If tenant context lookup is unavailable:
  - existing joined sessions continue until disconnect.
  - new `world:join`, `world:change`, and LiveKit token issuance fail closed.
- Temporary instancing trigger rule (pre-Tiled):
  - remap existing `dev/design/game` zones in main plaza to portal triggers for `world:change`.
  - remove this mapping once Tiled adds dedicated portal entities.

## 3. Delivery Phases

### Implementation Status (as of 2026-04-07)

- Phase A: implemented in code.
- Phase B: implemented in code (world-scoped runtime + `world:join`/`world:change` + temporary portal mapping).
- Phase C: implemented in code (tenant/world-scoped teleport store + teleport policy guards + instance-scoped cleanup).
- Phase D: not implemented yet.
- Phase E: not implemented yet.
- Phase F: partially implemented (`POST /tenant/bootstrap` exists; remaining admin endpoints pending).
- Phase G: not implemented yet.

## 3.1 Phase A - Foundations (Schema, RLS, Tenant Service)

### Goals

- Stand up tenant schema and policies.
- Introduce a central `TenantService` used by REST and sockets.
- Make rollout safe with staged feature flags.

### Work items

- Add DB migrations for:
  - `tenants`
  - `tenant_memberships`
  - `worlds`
  - `tenant_invites`
- Seed one `main_plaza` world row.
- Add constraints/indexes from architecture section 4.
- Enable RLS policies for tenant-owned tables.
- Add `server/tenant/tenantService.js` with:
  - `resolveTenantContext(userId)`
  - `resolveMainPlazaWorld()`
  - `resolveTenantInteriorWorld(tenantId)`
  - `canAccessWorld(userId, worldId)`
  - `isTenantAdmin(userId, tenantId)`
- Add short-lived in-memory cache for tenant context (`TTL`, e.g. 60s) to reduce DB pressure.

### Acceptance

- RLS policies active and tested with non-service role.
- `GET /tenant/me` resolves tenant + world context.
- Tenant service can be called from both REST and socket layers.

### Status (2026-04-07)

- Implemented in code:
  - migration + seed + constraints + RLS: `supabase/migrations/20260407075655_phase_a_tenant_schema.sql`
  - tenant service methods + TTL cache: `server/tenant/tenantService.js`
  - `GET /tenant/me`: `server/routes/tenantRoutes.js`
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

## 3.6 Phase F - Admin APIs + UX Integration

### Goals

- Finalize tenant bootstrap/admin flows in product UX.

### Work items

- Implement/finish:
  - `POST /tenant/bootstrap`
  - `POST /tenants/:tenantId/invites`
  - `PATCH /tenants/:tenantId/members/:userId/role`
  - `DELETE /tenants/:tenantId/members/:userId`
  - `PATCH /tenants/:tenantId/settings`
- Add client `TenantContext` bootstrap gate.
- Add world transition loading state tied to `world:change` ack.

### Acceptance

- Admin/member permissions enforced server-side.
- Client cannot enter gameplay route without resolved tenant context.

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

## 4. Code Touch Plan (Expected)

### Server

- `server/index.js`
- `server/middleware/requireAuth.js`
- `server/chat/commandRouter.js`
- `server/chat/teleportRequestsStore.js`
- `server/tenant/tenantService.js`
- `server/tenant/tenantRepository.js`
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
  - role enforcement on admin endpoints
  - RLS policy checks for non-service roles

### Manual QA

- Two accounts, different tenants:
  - isolate snapshots/chat/teleport/voice in interiors
- Portal trigger validation (pre-Tiled):
  - entering remapped `dev/design/game` trigger zones causes `world:change` and loading transition.
- Public interior visitor behavior:
  - chat + presence allowed
  - teleport denied for non-members
- Main plaza behavior:
  - global text chat works
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

- Tenant bootstrap and admin APIs operational with role enforcement.
- Runtime is world-scoped (`playersByWorld`) with no global snapshot/player leakage.
- Teleport/chat/tag behavior matches tenant and instance policy.
- Interior voice is fully world-namespaced and authorized.
- RLS enabled on tenant tables and validated in CI.
