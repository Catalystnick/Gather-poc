# Tenant Architecture Plan (Tenants + Worlds)

## 1. Purpose

Design a multi-tenant system for the current Gather codebase where:

- each user belongs to one home tenant,
- all tenant building/workspace exteriors exist in one shared **main plaza** map,
- each tenant has a dedicated **interior world instance** entered from its building exterior,
- tenants support two roles: `admin` and `member`,
- users can walk around the main plaza and enter interiors with a loading transition between instances,
- realtime presence/chat/tag/teleport/voice are isolated by the currently joined instance (`main_plaza` vs `tenant_interior`),
- main plaza has global text chat and no proximity/zone voice,
- teleport is used only inside tenant interiors for users in the same tenant and same interior instance,
- `revox` is an ordinary tenant like all other tenants (no special platform privileges).

This document is architecture-first and backend-focused, with explicit refactor notes for the current implementation.

---

## 2. Current Codebase State (What Exists Today)

### Auth + identity

- Supabase Auth is active in client (`AuthContext`), session token passed into Socket.IO.
- Server verifies Supabase JWT in `server/middleware/requireAuth.js`.
- No tenant state exists in DB or server runtime.

### Realtime server runtime

- Server keeps a single global `players` map in memory (`server/index.js`).
- `room:state`, `world:snapshot`, `chat:message`, `tag`, and `teleport` currently broadcast globally (or user-room targeted), not tenant/world partitioned.
- Teleport and chat services assume one shared world state.

### Client runtime

- Client socket hooks (`useSocket`, `useChat`) assume one active world session.
- Voice room naming is globally fixed (`gather-world` and zone variants), not tenant/world namespaced.

### Implication

Without tenant/world scoping, users from different tenants share presence and events unintentionally.

---

## 3. Target Architecture

## 3.1 System Overview

```mermaid
flowchart TB
  subgraph Client["Client (React + Phaser)"]
    Auth["Supabase Session"]
    TenantCtx["Tenant Context\nhomeTenant, role, currentWorld, instanceType"]
    SocketClient["Socket.IO Client\nworld:join/world:change"]
    HUD["HUD\nchat/tag/teleport(interior-only)"]
  end

  subgraph Edge["API + Gateway"]
    AuthMW["JWT Verify Middleware"]
    TenantSvc["Tenant Service\n(tenant membership, role, world access)"]
    TenantApi["Tenant REST API\nbootstrap + membership + admin"]
    Gateway["Socket Gateway\ninstance routing + handoff"]
  end

  subgraph Realtime["Realtime Workers (N nodes)"]
    WorkerA["Worker A\nauthoritative instances"]
    WorkerB["Worker B\nauthoritative instances"]
  end

  subgraph Coord["Redis Coordination"]
    OwnerDir["instance:owner + heartbeats"]
    Presence["presence indexes + main plaza global text chat bus"]
    PubSub["Socket adapter pub/sub"]
  end

  subgraph WorldTopo["World Topology"]
    Plaza["Shared main_plaza\n(all tenant exteriors)"]
    Interiors["Tenant interior instances\n(one per tenant in v1)"]
  end

  subgraph Data["Supabase Postgres"]
    Org[(tenants)]
    Member[(tenant_memberships)]
    Worlds[(worlds)]
    Invite[(tenant_invites)]
    Links[(world_links optional)]
  end

  subgraph Voice["LiveKit"]
    LK["Interior-only voice\nproximity + interior zone/privacy"]
  end

  Auth --> AuthMW
  AuthMW --> TenantSvc
  TenantCtx --> SocketClient
  SocketClient --> Gateway
  HUD --> SocketClient

  TenantApi --> TenantSvc
  Gateway --> TenantSvc
  Gateway --> OwnerDir
  Gateway --> WorkerA
  Gateway --> WorkerB
  SocketClient --> Plaza
  Plaza -->|enter tenant door| Interiors
  Interiors -->|exit to plaza| Plaza

  TenantSvc --> Org
  TenantSvc --> Member
  TenantSvc --> Worlds
  TenantSvc --> Invite
  TenantSvc --> Links

  WorkerA --> Presence
  WorkerB --> Presence
  WorkerA --> PubSub
  WorkerB --> PubSub
  OwnerDir --> PubSub
  WorkerA --> Plaza
  WorkerB --> Plaza
  WorkerA --> Interiors
  WorkerB --> Interiors

  WorkerA --> LK
  WorkerB --> LK
```

## 3.2 Core Multi-Tenant Principles

- **Tenant identity = tenant membership**.
- **Session entry point = shared main plaza** used as tenant selection/exploration surface.
- **World session identity = current instance** (`main_plaza` or `tenant_interior`).
- **Realtime isolation boundary = instance room** in Socket.IO.
- **Main plaza chat = one global text channel** (existing chat behavior).
- **Tenant interior chat/voice = instance-scoped only**.
- **Zone/privacy voice = interior-designated zones only** (never in main plaza).
- **Role enforcement boundary = tenant ownership/admin APIs**.
- **Durable tenant metadata = Postgres**; runtime movement/presence remains in-memory for PoC.

---

## 4. Data Model

```mermaid
%%{init: {'themeVariables': {'fontSize': '28px'}, 'er': {'fontSize': 30}}}%%
erDiagram
  TENANTS ||--o{ TENANT_MEMBERSHIPS : has
  TENANTS ||--o| WORLDS : has_interior
  TENANTS ||--o{ TENANT_INVITES : issues
  WORLDS ||--o{ WORLD_LINKS : links_from
  WORLDS ||--o{ WORLD_LINKS : links_to

  TENANTS {
    uuid id PK
    text name
    text slug
    text access_policy "public|private"
    uuid created_by
    timestamptz created_at
    timestamptz updated_at
  }

  TENANT_MEMBERSHIPS {
    uuid id PK
    uuid tenant_id FK
    uuid user_id "auth.users.id"
    text role "admin|member"
    text status "active|invited|disabled"
    timestamptz created_at
    timestamptz updated_at
  }

  WORLDS {
    uuid id PK
    uuid tenant_id FK "NULL for main plaza"
    text world_type "main_plaza|tenant_interior"
    text key
    text display_name
    text map_key
    boolean is_active
    timestamptz created_at
    timestamptz updated_at
  }

  TENANT_INVITES {
    uuid id PK
    uuid tenant_id FK
    text token_hash
    text role "admin|member"
    text email_optional
    timestamptz expires_at
    text status "pending|redeemed|expired|revoked"
    uuid invited_by
    uuid redeemed_by
    timestamptz created_at
    timestamptz redeemed_at
  }

  WORLD_LINKS {
    uuid id PK
    uuid from_world_id FK
    uuid to_world_id FK
    boolean enabled
    timestamptz created_at
  }
```

## 4.1 Constraints and Rules

- One active membership per user in v1 (`UNIQUE(user_id)` where status=`active`).
- Exactly one shared main plaza row in `worlds` (`world_type='main_plaza'`).
- One interior world per tenant in v1 (`UNIQUE(tenant_id)` where `world_type='tenant_interior'`).
- `admin` can manage members/invites/settings of own tenant only.
- `member` can interact in worlds they can access but cannot administer tenant settings.

## 4.2 Required Database Tables and Relationships

### v1 Table Checklist

| Table                    |    Required in v1 | Purpose                                                         |
| ------------------------ | ----------------: | --------------------------------------------------------------- |
| `tenants`                |               yes | Tenant root entity.                                             |
| `tenant_memberships`     |               yes | User membership + role (`admin`/`member`) per tenant.           |
| `worlds`                 |               yes | Stores one shared main plaza world and tenant interior worlds.  |
| `tenant_invites`         |               yes | Invite workflow for joining tenants.                            |
| `world_links`            |    optional in v1 | Optional curated world-to-world travel graph.                   |
| `auth.users` (Supabase)  | external required | Identity source referenced by memberships/invites.              |

### Relationship Map (Implementation-Oriented)

- `tenants.id` -> `tenant_memberships.tenant_id` (one-to-many).
- `tenants.id` -> `worlds.tenant_id` (one-to-one for `tenant_interior`; `NULL` for main plaza).
- `tenants.id` -> `tenant_invites.tenant_id` (one-to-many).
- `worlds.id` -> `world_links.from_world_id` (one-to-many).
- `worlds.id` -> `world_links.to_world_id` (one-to-many).
- `tenant_memberships.user_id` -> `auth.users.id` (many-to-one).

### Minimum Constraint Set for Migrations

- `tenants.slug` unique.
- exactly one `main_plaza` world row.
- `worlds.tenant_id` unique where `world_type='tenant_interior'`.
- `worlds.world_type` constrained to `main_plaza|tenant_interior`.
- `tenant_memberships` partial unique active membership per user in v1.
- Foreign keys from all child tables to parent IDs with delete/update policies defined explicitly.
- Indexes on high-frequency lookups:
  - `tenant_memberships(user_id, status)`
  - `tenant_memberships(tenant_id, role, status)`
  - `worlds(world_type, tenant_id)`
  - `tenant_invites(tenant_id, status, expires_at)`

## 4.3 Tenant Database Best Practices (Shared DB / Shared Schema)

- Use one shared Postgres database and schema with strict tenant scoping.
- Every tenant-owned row must carry `tenant_id` (`NOT NULL`) and FK to `tenants(id)`.
- Allow explicit shared-world exceptions only where intended (for example the single `main_plaza` world row with `tenant_id=NULL`).
- Default to row-level security (RLS) on tenant tables:
  - allow access only when caller is an active member of the row's `tenant_id`.
  - bypass only for trusted backend service role.
- Never create tenant-visible unique constraints without `tenant_id` unless global uniqueness is intentional:
  - example: use `UNIQUE(tenant_id, key)` instead of global `UNIQUE(key)`.
- Prefer tenant-safe foreign keys for child tables:
  - include `tenant_id` on child rows and enforce parent references within same tenant.
- All reads/writes on tenant data must include an explicit tenant predicate, even when RLS exists.
- Index every high-frequency query by tenant first:
  - pattern: `(tenant_id, <secondary columns...>)`.

---

## 5. Authorization Model

### 5.1 Access Policies

- `main_plaza` access: any authenticated user can join.
- `public` tenant interior (v1 default): any authenticated user can enter from main plaza.
- `private` tenant interior: only tenant members (or explicitly authorized visitors in future) can enter.

### 5.2 Actions vs Roles

| Action                                                       | member | admin |
| ------------------------------------------------------------ | -----: | ----: |
| Walk in shared main plaza                                    |    yes |   yes |
| Read own tenant + own membership                             |    yes |   yes |
| Enter public tenant interiors                                |    yes |   yes |
| Enter private tenant interiors across tenants                |     no |    no |
| Send teleport request (same tenant, same interior instance)  |    yes |   yes |
| Send teleport request in main plaza or cross-tenant          |     no |    no |
| Invite users to own tenant                                   |     no |   yes |
| Remove member from own tenant                                |     no |   yes |
| Promote/demote roles in own tenant                           |     no |   yes |
| Change tenant access policy                                  |     no |   yes |

### 5.3 Server Enforcement Points

- HTTP middleware: verify token, resolve tenant context.
- REST admin endpoints: tenant ownership + role checks.
- Socket `world:join(main_plaza)` for initial entry.
- Socket `world:change(tenant_interior)`: interior access policy check.
- Event handlers: enforce same-instance semantics for interactions.

---

## 6. User Flows

## 6.1 Signup/Login -> Tenant Bootstrap

```mermaid
sequenceDiagram
  participant U as User
  participant C as Client
  participant SA as Supabase Auth
  participant API as Tenant API
  participant DB as Postgres

  U->>C: Sign up / Sign in
  C->>SA: Auth flow
  SA-->>C: Session JWT
  C->>API: GET /tenant/me

  alt membership exists
    API->>DB: lookup membership + tenant + mainPlazaWorld + homeInteriorWorld
    API-->>C: tenant context (mainPlazaWorldId, homeInteriorWorldId)
  else no membership
    C->>API: POST /tenant/bootstrap
    Note over C,API: mode=create_tenant OR join_invite
    API->>DB: create/redeem membership + ensure tenant interior world + main plaza exists
    API-->>C: tenant context (mainPlazaWorldId, homeInteriorWorldId)
  end

  C->>C: Set TenantContext
  C->>C: Enter game with currentWorld=mainPlazaWorld, instanceType=main_plaza
```

## 6.2 Join Shared Main Plaza Session

```mermaid
sequenceDiagram
  participant C as Client
  participant G as Socket Gateway
  participant T as Tenant Service
  participant W as Realtime Worker

  C->>G: connect(auth.token)
  G->>T: resolve user tenant context
  T-->>G: userId + homeTenant + role + mainPlazaWorldId

  C->>G: world:join(mainPlazaWorldId)
  G->>T: authorize main plaza access
  T-->>G: allowed
  G->>W: join player to main_plaza instance
  W-->>C: room:state(main-plaza scoped)
  W-->>C: world:snapshot(main-plaza scoped)
  W-->>C: chat:scope(main_plaza_global)
  W-->>C: voice:scope(disabled_in_main_plaza)
  W-->>C: teleport:scope(disabled_in_main_plaza)
  Note over C,W: No proximity/zone voice in main_plaza
```

## 6.3 Enter Tenant Interior from Main Plaza

```mermaid
sequenceDiagram
  participant C as Client
  participant G as Socket Gateway
  participant T as Tenant Service
  participant W as Realtime Worker
  participant LK as LiveKit Token API

  C->>G: world:change(targetInteriorWorldId)
  G->>T: check interior access policy + visitor rights

  alt allowed
    T-->>G: allowed
    Note over C,G: Show loading transition while switching instances
    G->>W: remove from main plaza runtime
    G->>W: add to target interior runtime
    W-->>C: ack(success + spawn)
    W-->>C: room:state(target interior)
    W-->>C: instance:type(tenant_interior)
    W-->>C: chat:scope(interior_instance_local)
    W-->>C: voice:scope(interior_proximity_and_zone)
    W-->>C: teleport:scope(enabled_same_tenant_same_instance)
    C->>LK: POST /livekit/token (interior room)
    LK-->>C: token (interior-only voice)
  else denied
    T-->>G: denied(reason)
    G-->>C: ack(error=access_denied)
  end
```

## 6.4 Admin Invite + Role Management

```mermaid
sequenceDiagram
  participant A as Admin Client
  participant API as Tenant API
  participant T as Tenant Service
  participant DB as Postgres
  participant U as Invited User

  A->>API: POST /tenants/{tenantId}/invites
  API->>T: verify admin rights
  T-->>API: allowed
  API->>DB: create invite token
  API-->>A: invite link/token

  U->>API: POST /tenant/bootstrap (invite token)
  API->>DB: validate + redeem invite
  API-->>U: membership active + home interior world

  A->>API: PATCH /tenants/{tenantId}/members/{userId}/role
  API->>T: verify admin rights
  T-->>API: allowed
  API->>DB: update role
  API-->>A: updated
```

## 6.5 Seamless Portal Transition (Entry Point + LRU Prefetch)

```mermaid
sequenceDiagram
  participant C as Client
  participant G as Socket Gateway
  participant O as Owner Directory (Redis)
  participant W as Target Realtime Worker
  participant T as Tenant Service
  participant L as Client LRU Cache

  Note over C: Player approaches tenant house door in main plaza
  C->>G: world:prefetch(targetInteriorWorldId, portalId)
  G->>T: authorize prefetch access

  alt allowed
    T-->>G: allowed
    G->>O: resolve target instance owner
    O-->>G: ownerNode
    G->>W: build warm snapshot seed
    W-->>G: prefetchToken + seedSnapshot + assetHints
    G-->>C: prefetch ack(prefetchToken, seedSnapshot, assetHints)
    C->>L: store warm world bundle (LRU)
  else denied
    T-->>G: denied
    G-->>C: prefetch denied
  end

  Note over C: Player crosses door trigger
  Note over C: Warm path minimizes loading; cold path shows normal loading transition
  C->>G: world:change(targetInteriorWorldId, prefetchToken?)
  G->>T: re-check access + validate token TTL
  G->>O: resolve current owner

  alt same-node owner + warm handoff valid
    T-->>G: allowed_via_prefetch
    G->>W: fast-path join
    W-->>C: change ack(fast-path spawn + delta)
  else cross-node owner handoff
    O-->>G: owner_changed
    G-->>C: handoff redirect + handoffToken
    C->>G: reconnect target owner + join
    G->>W: finalize join
    W-->>C: change ack(spawn + delta_or_cold)
  else denied
    T-->>G: denied
    G-->>C: ack(error=access_denied)
  end
```

## 6.6 Horizontal Routing and Ownership Failover

```mermaid
sequenceDiagram
  participant C as Client
  participant G as Socket Gateway
  participant O as Owner Directory (Redis)
  participant W1 as Worker-OldOwner
  participant W2 as Worker-NewOwner

  C->>G: world:join(worldId)
  G->>O: lookup instance:owner:{worldId}

  alt owner alive
    O-->>G: owner=W1 epoch=42
    G->>W1: route join(worldId, epoch=42)
    W1-->>C: joined + snapshot
  else owner heartbeat expired
    O-->>G: owner missing
    G->>O: elect new owner
    O-->>G: owner=W2 epoch=43
    G->>W2: route join(worldId, epoch=43)
    W2-->>C: joined + snapshot
  end

  Note over W1,W2: Only highest valid epoch may emit authoritative snapshots
```

## 6.7 Teleport Inside Interior Instance

```mermaid
sequenceDiagram
  participant C1 as Sender Client
  participant C2 as Target Client
  participant G as Socket Gateway
  participant T as Tenant Service
  participant W as Interior Worker

  C1->>G: teleport:request(targetUserId)
  G->>T: validate same tenant + same interior instance

  alt valid
    T-->>G: allowed
    G->>W: create teleport request
    W-->>C2: teleport:incoming
    C2->>G: teleport:respond(accept)
    G->>W: apply teleport in same interior instance
    W-->>C1: teleport:result(accepted)
    W-->>C2: teleport:result(accepted)
  else invalid_context
    T-->>G: denied(in_plaza_or_cross_tenant_or_cross_instance)
    G-->>C1: teleport:error(not_allowed)
  end
```

---

## 7. Backend Refactor Plan (Current Code Mapped)

## 7.1 Tenant + world partition in server runtime (in-memory hot path)

Current:

- global `players` in `server/index.js`.

Target:

- `playersByWorld: Map<worldId, Map<userId, PlayerState>>`.
- world-scoped snapshot loop and broadcasting.
- socket joins both:
  - personal room: `user:{userId}`
  - active world room: `world:{worldId}`.

Notes:

- `playersByWorld` is runtime in-memory state on each realtime server node.
- `worldId` represents either the shared main plaza or a tenant interior world instance.
- It should contain only currently connected players in that world (not all registered users).
- Players outside the current world are naturally excluded from that world's broadcast loop.
- For visibility efficiency, layer an AOI/spatial index per world (grid/quadtree) so each player receives nearby entities, not every player in the world.
- This is the lowest-latency option for movement/snapshot hot paths in v1.

## 7.2 Tenant service layer

Add service (new module):

- `resolveTenantContext(userId)`
- `resolveMainPlazaWorld()`
- `resolveTenantInteriorWorld(tenantId)`
- `canAccessWorld(userId, worldId)`
- `isTenantAdmin(userId, tenantId)`

This removes tenant/role logic from socket handlers and keeps handlers focused on realtime behavior.

## 7.3 Event contract updates

- `player:join` should include `worldId` or be replaced by `world:join` then `player:join` world-local.
- `world:snapshot` payload includes `worldId` for safety and debugging.
- `chat:message`, `tag:send`, `teleport:*` all resolve and enforce same active instance.
- `teleport:request` is allowed only in `tenant_interior` and enforces same-tenant + same-instance between sender and target.

## 7.4 Teleport/Tag/Chat world scoping

- Teleport request store must key by `(worldId, senderId, targetId, tenantId)`.
- Tag target resolution must occur only among players in same world.
- Mentions should resolve only against world-local online users.
- Main plaza text chat is a single global channel (existing chat behavior is retained).
- Interior text chat is restricted to the active interior instance only.
- Presence in main plaza is plaza-scoped; presence inside interiors is interior-instance scoped.
- Teleport rule:
  - reject in `main_plaza` with `teleport:not_allowed_in_plaza`.
  - sender and target must both have active membership in the same tenant.
  - sender and target must both be in the same interior instance.
  - otherwise reject with `teleport:not_allowed_cross_tenant` or `teleport:not_same_instance`.

## 7.5 Voice isolation

- No proximity voice in `main_plaza`.
- LiveKit voice is enabled only for tenant interiors:
  - interior proximity: `gather-tenant-interior-{worldId}`
  - interior zone/privacy voice: `gather-world-{worldId}-zone-{zoneKey}`
- Zone/privacy voice is available only in designated interior zone spaces.
- Users must be in the same interior instance and same zone channel to hear each other.

## 7.6 Seamless handoff pipeline (server)

- Add a prewarm path before `world:change`:
  - `world:prefetch(targetInteriorWorldId, portalId)` authorizes and prepares a warm seed snapshot.
- Add short-lived prefetch tokens:
  - server-issued token bound to `userId + targetInteriorWorldId + portalId`, TTL (example: 30s).
- Keep per-user warm state with LRU semantics:
  - `warmWorldsByUser: Map<userId, LRU<worldId, WarmWorldState>>`.
  - cap size small (example: 2-3 worlds) to control memory.
- On `world:change`, re-check authorization even if token exists:
  - valid token -> fast-path spawn + delta snapshot.
  - missing/stale token -> cold-path join (functional fallback, slower UX).
- Never treat prefetch as authorization grant:
  - authorization must pass on both prefetch and final change.

## 7.7 Scale-out strategy (Redis + hybrid runtime)

Recommendation for production scale:

- Use a hybrid model, not Redis-only realtime state.
- Keep `playersByWorld` local/in-memory for per-tick movement, proximity checks, and snapshot generation.
- Use Redis for cross-node coordination:
  - global presence/online indexes
  - world ownership/affinity metadata (optional)
  - pub/sub fanout between realtime nodes
  - short-lived shared artifacts (prefetch tokens, rate-limit counters, ephemeral flags)
- Do not make Redis the primary per-frame store for `PlayerState`; network and serialization overhead will increase latency.

When to adopt:

- Single-node or early PoC: in-memory only is acceptable.
- Multi-node horizontal scale: add Redis adapter + distributed presence while retaining local world runtime loops.

## 7.8 Horizontal scaling solution (target production topology)

### 7.8.1 Topology

```mermaid
flowchart LR
  subgraph Clients["Clients"]
    C1["Browser Clients"]
  end

  LB["Ingress / Load Balancer"]

  subgraph Edge["Gateway/API Pods"]
    GW["Socket Gateway + REST API"]
  end

  subgraph Workers["Realtime Worker Pods"]
    P1["main_plaza shard-1\n(shared exteriors)"]
    P2["main_plaza shard-2\n(shared exteriors)"]
    I1["tenant interior instance A"]
    I2["tenant interior instance B"]
  end

  subgraph Redis["Redis"]
    OWN["instance:owner + heartbeats"]
    PS["Socket adapter pub/sub"]
    PRES["presence + plaza global text chat bus"]
  end

  subgraph Postgres["Postgres"]
    DB["tenants, memberships, worlds, invites"]
  end

  subgraph Voice["LiveKit"]
    LK["Interior-only voice rooms\nproximity + zone/privacy"]
  end

  C1 --> LB
  LB --> GW
  GW --> OWN
  GW --> DB
  GW --> P1
  GW --> P2
  GW --> I1
  GW --> I2
  P1 --> PS
  P2 --> PS
  I1 --> PS
  I2 --> PS
  P1 --> PRES
  P2 --> PRES
  I1 --> PRES
  I2 --> PRES
  I1 --> LK
  I2 --> LK
```

- API/Gateway tier:
  - JWT verification, rate limits, lightweight REST.
  - Socket handshake and instance routing.
- Realtime worker tier (N nodes):
  - authoritative simulation per owned instance.
  - AOI + delta snapshots + instance-scoped events.
- Redis tier:
  - Socket.IO adapter/pub-sub.
  - instance ownership directory + heartbeats.
  - cross-node presence + ephemeral coordination state.
- Postgres tier:
  - durable tenant metadata (tenants, memberships, worlds, invites).
- LiveKit tier:
  - interior-only voice rooms (proximity + interior zones).

### 7.8.2 Instance ownership model

- Each world instance has exactly one active owner worker at a time.
- Owner worker keeps the hot runtime state in-memory for that instance.
- Redis keys track ownership and liveness:
  - `instance:owner:{worldId}` -> `{ nodeId, epoch, lastHeartbeatAt }` with TTL.
  - `instance:load:{nodeId}` -> occupancy and tick lag metrics.
- Ownership is acquired/renewed by heartbeat; expiry triggers reassignment.

### 7.8.3 Routing and handoff flow

- On `world:join` / `world:change`:
  - resolve target instance owner from Redis directory.
  - if owner is current node, join directly.
  - if owner is another node, perform controlled handoff (redirect payload + short-lived handoff token).
- Client reconnects to target worker and resumes in target instance.
- Authorization is revalidated on final join at the owner worker (never trust redirect alone).

### 7.8.4 Main plaza sharding

- Treat main plaza as multiple shards in production (`main_plaza:1..K`) while preserving one logical plaza UX.
- Assign users to a plaza shard using deterministic routing (consistent hash or least-loaded strategy).
- Keep plaza text chat logically global via a dedicated cross-shard pub/sub channel.
- Interior instances remain isolated per tenant interior world.

### 7.8.5 Redis responsibilities (authoritative boundaries)

- Redis is coordination/state distribution, not per-frame simulation storage.
- Store in Redis:
  - Socket.IO adapter channels.
  - presence indexes (`presence:world:{worldId}` sets/hashes).
  - ownership + heartbeat keys.
  - short-lived artifacts (prefetch/handoff tokens, rate-limit buckets).
- Do not store high-frequency mutable `PlayerState` as the source of truth in Redis.

### 7.8.6 Failure handling

- Worker crash/loss:
  - heartbeat expires -> ownership key invalidated -> new owner elected.
  - connected clients receive retry/rejoin signal and reconnect to new owner.
- Split-brain prevention:
  - monotonic `epoch` in ownership record; only highest valid epoch may emit authoritative snapshots.
- Graceful drain:
  - worker marks itself draining, rejects new joins, hands off active instances before shutdown.

### 7.8.7 Observability and autoscaling signals

- Required metrics per worker/instance:
  - tick duration and tick lag
  - outbound bytes/sec
  - AOI fanout size
  - snapshot payload size
  - socket count + active players per instance
- Autoscale triggers should consider:
  - sustained high tick lag
  - sustained high outbound bandwidth
  - sustained occupancy above per-instance target.

---

## 8. Client Refactor Plan

## 8.1 Tenant context

Add a `TenantContext` after auth:

- `homeTenantId`
- `role`
- `mainPlazaWorldId`
- `homeInteriorWorldId`
- `currentWorldId`
- `currentInstanceType` (`main_plaza|tenant_interior`)
- loading/error state

## 8.2 Bootstrap gate

Route behavior:

- authenticated but no membership -> show tenant bootstrap screen.
- authenticated + membership -> allow `/game` entry.

## 8.3 Socket + hooks

- `useSocket` becomes world-aware and supports `world:change`.
- `useChat` supports two modes:
  - main plaza: global text chat channel (current behavior).
  - tenant interior: instance-scoped text chat.
- presence selectors use world-local remote players only.

## 8.4 UX entry points

- Main plaza auto-entry on session start (acts as tenant selection map).
- User walks to a tenant house exterior door to trigger `world:change` into that tenant interior.
- Exiting an interior returns player to main plaza at the corresponding exterior door location.

## 8.5 Seamless world transitions (client LRU)

- Portal/entry-point proximity triggers `world:prefetch` in advance.
- Client keeps a tiny LRU cache of warm target worlds:
  - seed snapshot
  - critical entity state
  - asset hints/preloaded bundles
- Crossing the portal uses warm handoff when available:
  - instant/cross-fade transition with minimal loading interruption.
- If cache entry is stale/missing, fall back to normal `world:change` path without blocking gameplay.

---

## 9. API and Event Interfaces (v1)

## 9.1 REST

- `GET /tenant/me`
  - returns tenant, role, `mainPlazaWorldId`, `homeInteriorWorldId`, and current defaults.
- `POST /tenant/bootstrap`
  - `{ mode: "create_tenant", tenantName }` or `{ mode: "join_invite", inviteToken }`.
- `POST /tenants/:tenantId/invites` (admin)
- `PATCH /tenants/:tenantId/members/:userId/role` (admin)
- `DELETE /tenants/:tenantId/members/:userId` (admin)
- `PATCH /tenants/:tenantId/settings` (admin, includes `access_policy`).

## 9.2 Socket

- `world:prefetch` request/ack (optional but recommended for seamless transitions)
- `world:join` request/ack
- `world:change` request/ack
- existing movement/tag/teleport events continue, and server enforces active instance membership.
- `chat:message` behavior:
  - in `main_plaza`: publish to global plaza text channel.
  - in `tenant_interior`: publish only to that interior instance room.
- `teleport:request` behavior:
  - allowed only in `tenant_interior` (disabled in `main_plaza`).
  - allowed only when sender/target belong to the same tenant and same interior instance.
  - cross-tenant or cross-instance request is rejected.

---

## 10. Migration and Rollout

## 10.1 Data migration strategy

- Seed one shared main plaza world row (`world_type='main_plaza'`).
- For existing tenants, ensure one interior world exists per tenant.
- For existing users, assign/migrate into a default tenant and default interior world on first tenant bootstrap.
- Preserve current gameplay access during staged rollout via compatibility fallback until migration finishes.

## 10.2 Incremental rollout phases

1. DB schema + tenant REST bootstrap.
2. Socket partitioning for main plaza + interior world join/change.
3. Interaction scoping (chat/tag/teleport) and voice room namespacing.
4. Admin tooling and hardening.
5. Horizontal scaling rollout:
   - Redis adapter + instance ownership directory.
   - worker handoff path for cross-node `world:change`.
   - main plaza sharding with global plaza text channel.
   - failure-recovery drills and load validation.

---

## 11. Testing and Acceptance Criteria

### Functional

- All authenticated users can walk in the shared main plaza and see tenant house exteriors.
- Main plaza text chat is global and visible to all users currently in main plaza.
- Users inside tenant interiors never leak presence/snapshots/messages to other interiors.
- Public tenant interior entry succeeds; private tenant interior entry denies non-members.
- Admin can invite/promote/remove members in own tenant.
- Member cannot call admin endpoints.

### Realtime safety

- `world:change` cleans up old world state and emits correct new snapshot.
- Entering/exiting interiors transitions between main plaza and tenant interior without stale state carryover.
- Teleport/tag only operate within current instance.
- Teleport requests are accepted only for same-tenant sender/target pairs in the same interior instance.
- Teleport requests are rejected in `main_plaza`.
- Interior text chat is restricted to that interior instance and never leaks to other interiors or plaza.
- Disconnect cleanup only affects relevant world partition.
- Warm transition fast-path works when prefetch token is valid; cold fallback always works when warm cache misses.
- Prefetch cache eviction (LRU) never leaks stale/private data across users or sessions.

### Voice

- Main plaza has no proximity voice channel.
- Proximity voice only works inside tenant interior instances.
- Zone/privacy voice only works inside designated interior zone spaces.
- Users in different interior instances never share proximity/zone audio rooms.

### Security

- All tenant-sensitive endpoints validate role and tenant ownership.
- No trust in client-provided tenant/role without server resolution.
- Teleport authorization resolves sender/target tenant and instance server-side and blocks invalid requests.

### Scalability

- Realtime events are emitted to instance-scoped rooms, not global broadcasts.
- Cross-node `world:change` succeeds via ownership-based handoff without duplicate authoritative owners.
- Main plaza sharding supports distribution across multiple workers while maintaining global plaza text chat.
- Under load, tick lag and snapshot fanout remain within defined SLO targets.

---

## 12. Open Naming Decision (Non-Blocking)

Product naming (`world` vs `island` vs `house`) can remain a UI concern. Keep backend keys and APIs on neutral term `world` for consistency and to avoid repeated refactors.
