# Gather PoC — Claude Instructions

## Project Overview

A multiplayer virtual space with proximity-based voice chat, top-down 3D rendering, and real-time player presence. Currently a PoC — keep solutions simple and avoid over-engineering.

## Tech Stack

### Client (`/client`)

- React 18 + Vite + TypeScript (strict mode)
- Three.js via React Three Fiber (R3F) + Drei
- Socket.IO client — presence and chat
- LiveKit client — WebRTC proximity voice
- Krisp noise cancellation (`@livekit/krisp-noise-filter`)
- No external state library — hooks + VoiceContext only

### Server (`/server`)

- Node.js + Express (ES modules, single file `index.js`)
- Socket.IO — real-time player sync
- LiveKit server SDK — JWT token signing
- In-memory player state (`players{}`) — no database yet

## Planned Additions (not yet implemented)

- **Supabase Auth** — email/password sign up & sign in. No custom SQL needed for basic auth — just enable Email Auth in the dashboard and use the Supabase JS client. A minimal `public.users` table (id, email, created_at) can be added later for profile data.
- **Redis** — real-time player position tracking per world (`world:{worldId}:player:{playerId}`). Ephemeral, fast, with pub/sub for broadcasting position deltas.
- **Multiple worlds** — currently single room `"gather-world"`, hardcoded in server token route.

## Key Conventions

- Client components live in `src/components/{scene,player,hud,ui}/`
- Hooks live in `src/hooks/` — `useSocket`, `useLiveKitVoice`, `useChat`
- Voice state is shared via `VoiceContext` — access with `useVoice()`, don't prop-drill
- Avatar data persisted in `localStorage` (`gather_poc_avatar`)
- Audio settings persisted in `localStorage` with a version key for migrations
- Server validates all incoming socket data (position bounds, name length, speed checks)
- Chat rate-limited server-side to 500ms min interval per player
- LiveKit token endpoint rate-limited to 10 req/60s per IP

## Architecture Docs

- [docs/system-overview.html](docs/system-overview.html) — keep this up to date when making significant changes to the architecture

# AI Engineering Rules — Three.js Application

## 1. Architecture First (MANDATORY)

- Separate:
  - Rendering (Three.js)
  - Game/App logic
  - State management
- Never mix UI logic with scene logic
- Use a modular structure:
  - /core (engine setup)
  - /systems (render loop, physics, input)
  - /entities (objects in scene)
  - /components (reusable logic)
  - /utils

---

## 2. Scene Management

- Never create objects directly inside render loop
- All objects must:
  - Be initialized once
  - Be updated via systems

- Use a centralized scene manager:
  - scene
  - camera
  - renderer
  - clock

---

## 3. Render Loop Rules

- There must be ONLY ONE render loop
- Use requestAnimationFrame
- All updates must go through a controlled update pipeline:

update(delta):

- input system
- physics system
- animation system
- rendering

- Never perform heavy computations inside render loop

---

## 4. Performance (CRITICAL)

- Minimize draw calls
- Reuse geometries and materials
- Use InstancedMesh when rendering many objects
- Avoid unnecessary re-renders

- Mandatory optimizations:
  - Frustum culling
  - Object pooling for dynamic objects
  - Texture compression where possible

---

## 5. Memory Management (CRITICAL)

- Always dispose:
  - geometry.dispose()
  - material.dispose()
  - texture.dispose()

- Remove unused objects from scene
- Avoid memory leaks from event listeners

---

## 6. State Management

- No global mutable state
- Scene state must be predictable
- Use a central store (Zustand/Redux/etc.)

- Rendering layer must NOT own business state

---

## 7. Asset Management

- All assets must be:
  - Loaded via a loader system
  - Cached
  - Preloaded when possible

- Never load assets inside render loop

---

## 8. Input Handling

- Centralize input handling (keyboard/mouse/touch)
- Do not attach multiple listeners across components
- Normalize inputs across devices

---

## 9. Code Quality

- Use TypeScript (strict)
- Max function length: 100 lines
- No duplicate logic
- Extract reusable math/util functions

---

## 10. Naming Conventions

- Meshes: playerMesh, enemyMesh
- Systems: movementSystem, renderSystem
- Avoid vague names like "obj", "thing"

---

## 11. Debugging & Dev Tools

- Include debug mode:
  - FPS counter
  - AxesHelper / GridHelper (dev only)
- Logs must be meaningful

---

## 12. Documentation (MANDATORY)

Every change MUST:

- Update /docs/architecture.md if structure changes
- Document:
  - New systems
  - Scene structure
  - Data flow

- Add usage examples for:
  - New entities
  - New systems

--For any libraries and tool we use,

- ensure official documentation is always looked up when planning a solution.

If documentation is missing → task is incomplete

---

## 13. PR Standards

- Small, focused changes
- Must include:
  - What changed
  - Why
  - Performance impact

---

## 14. Refactoring Rule

- If touching inefficient code:
  - Optimize it
  - Do not introduce regressions

---

## 15. Three.js Best Practices (STRICT)

- Do NOT:
  - Create new materials every frame
  - Create new geometries every frame
  - Allocate objects inside loops unnecessarily

- ALWAYS:
  - Reuse objects
  - Use BufferGeometry
  - Batch updates where possible

---

## 16. Animation Rules

- Use delta time for all animations
- No frame-dependent movement
- Animations must be deterministic

---

## 17. Camera Rules

- Camera must be controlled via a system
- No ad-hoc camera mutations across files

---

## 18. Lighting Rules

- Use minimal lights
- Prefer baked lighting where possible
- Avoid excessive dynamic shadows

---

## 19. Extensibility

- New features must:
  - Plug into existing systems
  - Not break architecture

---

## 20. Self-Review (MANDATORY)

Before finalizing:

- Check for memory leaks
- Check for unnecessary allocations
- Check render loop impact
- Ensure documentation is updated

Reject solution if:

- Multiple render loops exist
- Memory is not disposed
- Logic is inside render loop
