# Dev Interior Instance Switching + TMJ Loading Implementation Plan

## 1. Purpose and Scope

**Decision**

Define a planning-only, implementation-ready blueprint for moving users from main plaza `dev` zone into their tenant interior instance and loading interior content from TMJ assets.

**Reasoning**

World transition and map loading are a dedicated runtime/rendering concern and should be isolated from invite onboarding planning.

**Alternatives considered**

- Keep this merged with invite onboarding in one doc.
  - Rejected; separate technical owners and failure domains.

---

## 2. Current State

**Decision**

Treat current baseline as:

- Socket world transitions exist (`world:join`, `world:change`).
- Dev zone trigger currently depends on temporary mapping logic.
- Client map loader path is LDtk-only (`/hub.ldtk`).
- Interior TMJ asset exists at `client/public/interior/dev_interior.tmj` with tileset PNG.
- Server runtime currently uses a global loaded map profile unless explicitly extended.

**Reasoning**

Highlights exact delta needed for interior instance to be visually and authoritatively correct.

**Alternatives considered**

- Assume interior files auto-work with current loader.
  - Rejected; TMJ parsing path is not active in current runtime.

---

## 3. Locked Product Decisions

### 3.1 Dev Portal Target

**Decision**

Main plaza `dev` zone routes user to their tenant home interior world (`homeInteriorWorldId`).

**Reasoning**

Preserves one-interior-per-tenant isolation model.

**Alternatives considered**

- Shared global dev interior world.
  - Rejected due to tenant isolation conflict.

### 3.2 Map Format Strategy

**Decision**

Support TMJ for interiors now, while keeping LDtk for main plaza.

**Reasoning**

Fastest path to use provided assets without conversion blockers.

**Alternatives considered**

- Convert TMJ into LDtk first.
  - Rejected for current delivery speed.

### 3.3 Interior Map Key

**Decision**

Use `map_key = dev_interior` for tenant interior worlds in this phase.

**Reasoning**

Provides deterministic map-source selection and simplifies loader/routing contracts.

**Alternatives considered**

- Continue `interior_default` while special-casing client routing.
  - Rejected as ambiguous and error-prone.

---

## 4. Detailed Implementation Design

## 4.1 Transition Flow

**Decision**

Use explicit target world transition payloads and include `mapKey` in server acks.

**Design**

1. User enters plaza `dev` zone.
2. Client emits `world:change` with explicit interior target world id.
3. Server validates world access and tenant context.
4. Ack returns spawn + world metadata including `mapKey`.
5. Client updates active world and selects correct map source.

**Reasoning**

Eliminates fragile hardcoded portal->world key assumptions.

**Alternatives considered**

- Keep static `dev -> interior_world_dev` mapping.
  - Rejected; inconsistent with per-tenant interior worlds.

## 4.2 Map Source Selection and Parsing

**Decision**

Add map-source switch by `mapKey`:

- plaza -> LDtk parser,
- `dev_interior` -> TMJ parser.

**Design**

TMJ parser should normalize into runtime shape consumed by existing rendering/gameplay systems:

- tile layers for rendering,
- collision data source (if present),
- zone definitions (if present),
- spawn candidate/fallback,
- tileset path normalization for `/public/interior` assets.

**Reasoning**

Keeps rendering pipeline unified and avoids dual engine paths.

**Alternatives considered**

- Create separate TMJ-only render path.
  - Rejected due to duplication and maintenance overhead.

## 4.3 Server Runtime Map Profile Consistency

**Decision**

Authoritative simulation must resolve map profile per world using `worlds.map_key`.

**Design**

- world join/change picks world-specific profile.
- collision/zone/spawn checks run against that profile.

**Reasoning**

Prevents client/server desync and rubberbanding in interiors.

**Alternatives considered**

- Keep server on plaza map while client renders interior.
  - Rejected due to correctness risk.

---

## 5. API and Contract Changes

**Decision**

Add only world/map metadata fields needed for deterministic client map selection.

**Changes**

- `world:join` ack adds `mapKey`.
- `world:change` ack adds `mapKey`.
- world creation/default data path uses interior `map_key` consistent with TMJ asset.

**Reasoning**

Makes map loading explicit and avoids hidden client inference.

**Alternatives considered**

- Infer map on client from `worldKey` naming conventions.
  - Rejected as brittle.

---

## 6. Security, Failure Modes, and Observability

**Decision**

Fail closed for invalid target world/access; keep user in current world on transition failure.

**Failure Modes**

- target world missing/denied -> ack error, no world switch.
- map key unknown -> safe loader error state, no crash.
- TMJ parse failure -> surfaced error + rollback to stable world selection UX.

**Observability to Add**

- world-change success/failure by reason,
- map load success/failure by `mapKey` and source,
- interior spawn/collision mismatch indicators (if available).

**Reasoning**

Enables safe canary rollout and quick diagnosis of world/map issues.

**Alternatives considered**

- Minimal logging only.
  - Rejected; insufficient for transition correctness debugging.

---

## 7. Testing and Acceptance Criteria

**Decision**

Use scenario coverage across socket transition, map rendering, and authoritative movement.

### Test Scenarios

1. Enter `dev` zone in plaza -> transition to tenant interior succeeds.
2. Transition ack includes `mapKey` and client loads TMJ interior.
3. Leaving interior returns to plaza and restores LDtk path.
4. Unauthorized world change is denied and user remains stable.
5. Interior movement/collision behavior is consistent client + server.

### Acceptance Criteria

- Dev zone reliably transitions to tenant interior for authorized users.
- Interior TMJ map renders correctly.
- No regression in plaza map rendering or world partition behavior.

**Reasoning**

Covers user-visible behavior and core runtime correctness.

**Alternatives considered**

- Validate visuals only without authoritative simulation checks.
  - Rejected due to high desync risk.

---

## 8. Rollout Plan

**Decision**

Ship in sequenced runtime stages with rollback points.

### Stages

1. Add `mapKey` in world ack contracts.
2. Add TMJ loader path + source switch by `mapKey`.
3. Align server map profile by world key.
4. Canary with transition/load metrics.

### Rollback Points

- Disable TMJ source switch while keeping transition contracts.
- Keep users in plaza on interior load errors as temporary safety mode.

**Reasoning**

Allows controlled stabilization of transition and renderer changes.

**Alternatives considered**

- Ship all runtime changes in one release.
  - Rejected as high-risk for multiplayer/world-state regressions.

---

## Implementation Notes

- Planning only; no implementation in this document.
- Invite workflow and email provider integration are out of scope for this feature doc.
