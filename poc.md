# PoC — Minimum Viable Demo

Goal: build a working Gather-style collaborative space in phases. Each phase is independently testable. Two browser windows on the same machine act as two separate players throughout.

---

# Phases

| Phase | Description | Status |
|---|---|---|
| 1 | Basic Multiplayer Room | In progress |
| 2 | Chat + Voice | In progress |

---

# Stack

| Layer | Tool | Docs | Notes |
|---|---|---|---|
| Frontend | React | [react.dev](https://react.dev) | |
| Build tool | Vite | [vitejs.dev](https://vitejs.dev) | |
| 3D rendering | React Three Fiber | [docs.pmnd.rs/react-three-fiber](https://docs.pmnd.rs/react-three-fiber) | |
| 3D base | Three.js | [threejs.org/docs](https://threejs.org/docs) | |
| 3D helpers | Drei (@react-three/drei) | [drei.docs.pmnd.rs](https://drei.docs.pmnd.rs) | Capsule, Grid, Text, Html, KeyboardControls, Environment, OrbitControls |
| Real-time sync | Socket.IO | [socket.io/docs](https://socket.io/docs) | World presence layer |
| Voice (PoC) | WebRTC (native browser API) | [developer.mozilla.org/en-US/docs/Web/API/WebRTC_API](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API) | P2P proximity voice, signaled over Socket.IO |
| Backend | Node.js | [nodejs.org/docs](https://nodejs.org/docs) | |
| Backend framework | Express | [expressjs.com](https://expressjs.com) | |

---

# Project Structure (full)

```
/poc
  /client
    src/
      components/
        AvatarSelect.tsx      — name entry, shape + colour picker, localStorage save
        AvatarMesh.tsx        — shared shape/colour mesh, used by Local + Remote player
        World.tsx             — R3F canvas, floor, lighting, scene root
        LocalPlayer.tsx       — keyboard movement, emits position
        RemotePlayer.tsx      — other players, lerped movement, name label
        ChatBubble.tsx        — in-world bubble above avatar (Phase 2)
        ChatPanel.tsx         — 2D chat log overlay (Phase 2)
        VoiceControls.tsx     — mute/unmute HUD button (Phase 2)
      hooks/
        useSocket.ts          — connection, player state, position sync
        useChat.ts            — chat message state + send (Phase 2)
        useProximityVoice.ts  — WebRTC peer management, proximity detection, volume falloff (Phase 2)
      App.tsx                 — switches between AvatarSelect and World
      main.tsx
  /server
    index.js                  — Express + Socket.IO (presence + signaling relay)
  package.json                — root, runs client + server via concurrently
```

---

# Phase 1 – Basic Multiplayer Room

## Goal
Players enter a display name, join a shared 3D space, move around with WASD, and see each other in real time.

## Scope

**In:**
- Avatar selection screen — display name, shape picker, colour picker — serves as login
- Avatar preference persisted to localStorage
- 3D space with floor, lighting, perspective camera
- WASD keyboard movement
- Real-time position sync via Socket.IO (~20Hz)
- Other players rendered with their chosen shape and colour, with floating name labels
- Two browser windows = two separate players

**Out (deferred to later phases):**
- Physics, collision detection
- Audio of any kind
- Persistence / database
- Minigames

---

## Avatar Selection Flow

The avatar selection screen acts as the login step — no password, no account. Socket does not connect until the player clicks Join.

```
Browser opens
  → Check localStorage for saved avatar
  → AvatarSelect screen shown (pre-populated if saved data exists)
  → User sets display name, picks shape (Capsule / Box / Sphere), picks colour
  → Clicks Join
  → Selection saved to localStorage
  → Socket connects, emits player:join { name, avatar }
  → Server registers player, sends room snapshot
  → Client renders World
```

### Avatar Data Structure

```ts
interface Avatar {
  shape: 'capsule' | 'box' | 'sphere'
  color: string  // hex e.g. '#e74c3c'
}

interface Player {
  id: string
  name: string
  avatar: Avatar
  position: { x: number; y: number; z: number }
}
```

### Colour Palette

Fixed set of 8 colours — no free-form colour picker for simplicity:

`#e74c3c` `#e67e22` `#f1c40f` `#2ecc71` `#1abc9c` `#3498db` `#9b59b6` `#ecf0f1`

### Shape Options

| Value | Drei component | Notes |
|---|---|---|
| `capsule` | `<Capsule>` | Default, humanoid feel |
| `box` | `<Box>` | Blocky / robot feel |
| `sphere` | `<Sphere>` | Round / ghost feel |

### localStorage

Key: `gather_poc_avatar`
Value: `{ name, avatar: { shape, color } }`

On next visit the selection screen pre-fills from localStorage. Player can change and re-join at any time.

---

## Socket Events — Phase 1

| Direction | Event | Payload | When |
|---|---|---|---|
| client → server | `player:join` | `{ name, avatar: { shape, color } }` | Join clicked |
| client → server | `player:move` | `{ x, y, z }` | While moving, ~20Hz |
| server → client | `room:state` | `{ players: Player[] }` | On join — full snapshot |
| server → client | `player:joined` | `{ id, name, avatar, position }` | When another player joins |
| server → client | `player:updated` | `{ id, position }` | When a player moves |
| server → client | `player:left` | `{ id }` | When a player disconnects |

---

## Server Logic — Phase 1

In-memory room state, no database:

```js
const players = {}
// { [socketId]: { id, name, avatar: { shape, color }, x, y, z } }
```

| Event | Action |
|---|---|
| `player:join` | Register player (name + avatar + spawn position) in state, send `room:state` to new client, broadcast `player:joined` to others |
| `player:move` | Update position in state, broadcast `player:updated` to all other clients |
| `disconnect` | Remove from state, broadcast `player:left` to remaining clients |

---

## Client Components — Phase 1

### App.tsx
- Holds `player` state: `{ name, avatar } | null`
- On mount: reads `gather_poc_avatar` from localStorage, pre-populates selection screen
- Renders `<AvatarSelect>` until player is set
- Once player is set, renders `<World>` — socket initialises at this point

### AvatarSelect.tsx
- Centered card layout
- Display name text input
- Shape picker: 3 buttons showing a small inline R3F canvas preview of each shape
- Colour picker: 8 colour swatches, selected state shown with a ring
- Join button — disabled until name is non-empty
- On submit: saves to localStorage, sets player state in App

### World.tsx
- R3F `<Canvas>` with perspective camera
- `<Grid>` (Drei) — floor
- `<Environment>` (Drei) — lighting preset, no manual lights needed
- `<OrbitControls>` (Drei) — free camera for dev
- `<KeyboardControls>` (Drei) — wraps scene, maps WASD to named actions
- Renders `<LocalPlayer>` + `<RemotePlayer>` for each entry in `remotePlayers`

### LocalPlayer.tsx
- Renders the correct Drei mesh based on `avatar.shape` (`<Capsule>`, `<Box>`, or `<Sphere>`)
- Applies `avatar.color` as the mesh material colour
- `useKeyboardControls` (Drei) reads WASD state each frame
- `useFrame` — moves position, throttles `emitMove` to ~20Hz

### RemotePlayer.tsx
- Props: `{ id, name, avatar, position }`
- Renders correct shape mesh with correct colour from `avatar`
- `<Text>` (Drei) — floating name label above mesh
- `useFrame` — lerps mesh toward received position for smooth movement

### AvatarMesh.tsx
- Shared by `LocalPlayer` and `RemotePlayer`
- Props: `{ shape, color }`
- Returns the correct Drei geometry with a `<meshStandardMaterial>` set to `color`

### useSocket.ts
- Accepts `{ name, avatar }`, connects to `http://localhost:3001` on mount
- Emits `player:join` on connect with name + avatar
- Handles `room:state`, `player:joined`, `player:updated`, `player:left`
- Maintains `remotePlayers: Map<id, Player>` in state
- Exposes `emitMove(position)` for LocalPlayer

---

## Phase 1 Done Checklist

- [ ] Server starts on port 3001
- [ ] Avatar selection screen renders on first load
- [ ] Shape picker shows all 3 options with correct geometry previews(Will be updated to  sprites later)
- [ ] Colour swatches render correctly, selected state is visible
- [ ] Join button is disabled until a name is entered
- [ ] Submitting connects socket and enters the world with chosen avatar
- [ ] Avatar selection is saved to localStorage — refreshing pre-fills the form
- [ ] Local player renders with the correct shape and colour
- [ ] Second browser window: different name + avatar, appears as a separate player
- [ ] Both players see each other with correct shapes and colours
- [ ] Both players see each other's name labels
- [ ] Both players see each other move in real time
- [ ] Closing a tab removes that player from the other's view

---

# Phase 2 – Chat + Voice

## Goal
Players can send text messages visible as in-world chat bubbles. Everyone in the space is on a single shared voice call — enter the world, unmute, talk.

---

## Chat

### How it works
- Player types a message → emitted to server → broadcast to all clients
- Message appears as a bubble above the sender's avatar, fades after 5 seconds
- A 2D chat panel in the corner shows persistent message history

### Socket Events — Chat

| Direction | Event | Payload | When |
|---|---|---|---|
| client → server | `chat:message` | `{ text }` | Player sends a message |
| server → client | `chat:message` | `{ id, name, text, timestamp }` | Broadcast to all clients |

### Server Logic — Chat
- On `chat:message`: attach sender name + timestamp from server, broadcast to all connected clients including sender

### ChatBubble.tsx
- Rendered in world space above each avatar using Drei `<Html>`
- Anchored to the avatar's position, always faces camera
- Shows the most recent message only
- Fades out after 5 seconds via CSS opacity transition

### ChatPanel.tsx
- Fixed 2D overlay, bottom-left corner
- Scrollable log of all messages with sender name + timestamp
- Text input + send button at the bottom, Enter key to send
- On send: calls `sendMessage(text)` from `useChat`, clears input

### useChat.ts
- Listens for `chat:message` socket events
- Maintains `messages[]` for the chat panel log
- Maintains `bubbles: Map<playerId, { text, expiry }>` for in-world bubbles
- Exposes `sendMessage(text)`

---

## Voice

### Approach
P2P WebRTC proximity voice. No external service — the existing Socket.IO server handles signaling only. When two players come within range of each other a direct audio connection forms between their browsers. Volume scales with distance so audio naturally fades as players move apart. Works cleanly for small groups (up to ~8 players).

### Proximity Logic

```
VOICE_RANGE = 8 units   (tune as needed)

each frame:
  for each remote player:
    distance = vector3 distance between local and remote position
    if distance < VOICE_RANGE and no peer connection → initiate handshake
    if distance >= VOICE_RANGE and peer connection exists → close it
    if connected → set gain = 1 - (distance / VOICE_RANGE)
```

Volume is a Web Audio API `GainNode` sitting between the incoming stream and the audio output — no stream changes needed, just gain value updated each frame.

### WebRTC Handshake Flow

```
Player A enters range of Player B
  → A creates RTCPeerConnection
  → A gets local media stream (mic)
  → A creates offer → sends via Socket.IO: rtc:offer { to: B.id, offer }
  → Server relays to B
  → B creates RTCPeerConnection, adds local stream
  → B creates answer → sends via Socket.IO: rtc:answer { to: A.id, answer }
  → Server relays to A
  → Both exchange ICE candidates via rtc:ice-candidate
  → Direct P2P audio stream established
  → A and B hear each other, volume based on distance

Player A moves out of range
  → A closes RTCPeerConnection for B
  → Sends rtc:hangup { to: B.id }
  → B closes their side
```

### Socket Events — Signaling

| Direction | Event | Payload | Notes |
|---|---|---|---|
| client → server | `rtc:offer` | `{ to, offer }` | Server relays to target |
| client → server | `rtc:answer` | `{ to, answer }` | Server relays to target |
| client → server | `rtc:ice-candidate` | `{ to, candidate }` | Server relays to target |
| client → server | `rtc:hangup` | `{ to }` | Server relays to target |
| server → client | `rtc:offer` | `{ from, offer }` | Received offer from peer |
| server → client | `rtc:answer` | `{ from, answer }` | Received answer from peer |
| server → client | `rtc:ice-candidate` | `{ from, candidate }` | ICE candidate from peer |
| server → client | `rtc:hangup` | `{ from }` | Peer closed connection |

### Server Logic — Signaling

The server is a pure relay — no WebRTC logic, just forwarding to the right socket:

```js
socket.on('rtc:offer', ({ to, offer }) =>
  io.to(to).emit('rtc:offer', { from: socket.id, offer }))

socket.on('rtc:answer', ({ to, answer }) =>
  io.to(to).emit('rtc:answer', { from: socket.id, answer }))

socket.on('rtc:ice-candidate', ({ to, candidate }) =>
  io.to(to).emit('rtc:ice-candidate', { from: socket.id, candidate }))

socket.on('rtc:hangup', ({ to }) =>
  io.to(to).emit('rtc:hangup', { from: socket.id }))
```

No additional dependencies. No `.env` vars needed.

### useProximityVoice.ts

Core hook. Runs alongside the position sync loop.

- On mount: requests mic permission, stores local `MediaStream`
- Maintains `peers: Map<playerId, { connection: RTCPeerConnection, gainNode: GainNode }>`
- Each frame (throttled to ~10Hz): compares local position to each remote player's position
  - Below threshold and no peer → call `initiatePeer(playerId)`
  - Above threshold and peer exists → call `closePeer(playerId)`
  - Peer exists → update `gainNode.gain.value`
- Listens to signaling socket events and handles incoming offers from players who entered range first
- On unmount or player disconnect: closes all open peer connections

### VoiceControls.tsx
- Fixed 2D overlay, bottom-center
- Single mute/unmute toggle button
- Muting sets local `MediaStream` tracks `enabled = false` — does not close peer connections
- Shows current state: muted / live

### Speaking Indicator
- Web Audio API `AnalyserNode` on each incoming remote stream
- Poll RMS amplitude ~4Hz — if above threshold, mark that player as speaking
- When speaking: render a pulsing ring around the remote player's mesh in `RemotePlayer.tsx`

### STUN Server
For local testing (two browser windows, same machine) STUN is not needed — both peers are on loopback. For testing across devices on the same LAN, include a public STUN server:

```ts
const pc = new RTCPeerConnection({
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
})
```

No TURN needed for PoC — local network NAT traversal is handled by STUN.

---

## Phase 2 Done Checklist

- [ ] Player sends a message → bubble appears above their avatar
- [ ] Bubble fades after 5 seconds
- [ ] Chat panel shows full message history with names
- [ ] Second browser window receives messages in real time
- [ ] Browser requests mic permission on world entry
- [ ] Two players in range → WebRTC handshake completes, audio flows
- [ ] Audio volume decreases as players move apart
- [ ] Players moving out of range → peer connection closes, audio stops
- [ ] Mute/unmute button silences local mic without dropping connections
- [ ] Speaking indicator pulses on the avatar of whoever is talking
- [ ] Two separate connections work independently (A↔B and A↔C simultaneously)

---

# Running Locally

```bash
cd poc
npm install
npm run dev

# Open http://localhost:5173 in two browser windows
# Enter different names → two players in the same space
```

Server runs on port 3001. Client on port 5173. Both started by `npm run dev` via concurrently.

---

# Testing Across Devices

## Same LAN (same WiFi or office network)

No extra tools needed. Find the host machine's local IP:

```bash
# Mac / Linux
ipconfig getifaddr en0

# Windows
ipconfig    # look for IPv4 Address under your active adapter
```

Point the client at that IP instead of localhost:

```ts
// useSocket.ts
const socket = io('http://192.168.x.x:3001')
```

The other person opens `http://192.168.x.x:5173` in their browser. WebRTC P2P works across LAN without STUN — both machines can reach each other directly.

---

## Different networks (remote colleague)

Two problems to solve: the server must be reachable, and the frontend must be reachable. Solve both by serving the built client from Express so everything goes through a single port, then tunnel that port with ngrok.

**Step 1 — Serve client from Express**

```js
// server/index.js
import path from 'path'
app.use(express.static(path.join(__dirname, '../client/dist')))
```

**Step 2 — Build the client**

```bash
cd client && npm run build
```

**Step 3 — Tunnel with ngrok**

```bash
# Install ngrok (once)
brew install ngrok        # Mac
# or download from ngrok.com

# Start tunnel
ngrok http 3001
# → https://abc123.ngrok-free.app
```

Share the ngrok URL. The other person opens it in their browser — client and server both come through the same tunnel. No port forwarding, no router config.

**Step 4 — Update the socket URL for remote use**

Use an env variable so you don't hardcode the ngrok URL:

```ts
// useSocket.ts
const socket = io(import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3001')
```

```bash
# client/.env.local
VITE_SERVER_URL=https://abc123.ngrok-free.app
```

**Step 5 — STUN is required across different networks**

Two machines on different networks sit behind separate NATs. The STUN server tells each peer its public IP so they can find each other. Confirm this is in the peer config:

```ts
const pc = new RTCPeerConnection({
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
})
```

---

## Scenario summary

| Scenario | Server URL | Extra tools | STUN needed |
|---|---|---|---|
| Two browser windows, one machine | `localhost:3001` | None | No |
| Two machines, same LAN | `192.168.x.x:3001` | None | No |
| Two machines, different networks | ngrok URL | ngrok | Yes |
