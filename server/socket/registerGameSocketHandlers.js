import { normalizeInput } from "../world/movementMath.js";
import { handleTagSend, handleTeleportRequest, handleTeleportRespond } from "../chat/commandRouter.js";

//Temp for testing, zone values will come from Tiled map data
const TEMP_PORTAL_WORLD_BY_ZONE = {
  dev: "interior_world_dev",
  design: "interior_world_design",
  game: "interior_world_game",
};
const TEMP_PORTAL_WORLD_IDS = new Set(Object.values(TEMP_PORTAL_WORLD_BY_ZONE));

function worldRoom(worldId) {
  return `world:${worldId}`;
}

function looksLikeReservedCommand(text) {
  const lower = text.toLowerCase();
  return lower === "@tag" || lower.startsWith("@tag ") || lower === "/teleport" || lower.startsWith("/teleport ");
}

function sanitizeTokenName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_\-]/g, "");
}

function tokenForPlayerName(name) {
  const safe = sanitizeTokenName(name);
  return `@${safe || "user"}`;
}

function normalizeWorldId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function mapPortalZoneToWorldId(rawZone) {
  const key = typeof rawZone === "string" ? rawZone.trim().toLowerCase() : "";
  if (!key) return "";
  return TEMP_PORTAL_WORLD_BY_ZONE[key] ?? "";
}

function inferInstanceType(worldId, tenantContext) {
  if (worldId === tenantContext?.mainPlazaWorldId || worldId === "main_plaza") return "main_plaza";
  return "tenant_interior";
}

function normalizeChatMentions(rawMentions, players) {
  if (!Array.isArray(rawMentions)) return [];
  const mentions = [];
  const seenUserIds = new Set();

  for (const rawMention of rawMentions) {
    if (!rawMention || typeof rawMention !== "object") continue;
    const userId = typeof rawMention.userId === "string" ? rawMention.userId.trim() : "";
    if (!userId || seenUserIds.has(userId)) continue;

    const mentionedPlayer = players.get(userId);
    if (!mentionedPlayer) continue;

    mentions.push({
      userId,
      token: tokenForPlayerName(mentionedPlayer.name),
    });
    seenUserIds.add(userId);
    if (mentions.length >= 16) break;
  }

  return mentions;
}

function createPlayerState({ socket, trimmedName, avatar, spawn, world, zoneKey }) {
  return {
    id: socket.userId,
    name: trimmedName,
    avatar,
    x: world.x,
    y: world.y,
    vx: 0,
    vy: 0,
    col: spawn.col,
    row: spawn.row,
    facing: "down",
    moving: false,
    zoneKey,
    muted: false,
    inputState: {
      seq: 0,
      inputX: 0,
      inputY: 0,
      facing: "down",
      moving: false,
      clientTimeMs: Date.now(),
    },
    lastProcessedInputSeq: 0,
  };
}

function getSocketWorldPlayers(runtime, socketWorldIndex, socketId) {
  const worldId = socketWorldIndex.get(socketId);
  if (!worldId) return null;
  const players = runtime.getWorldPlayers(worldId);
  if (!players) return null;
  return { worldId, players };
}

function emitRoomState(socket, runtime, worldId) {
  const worldPlayers = runtime.getWorldPlayers(worldId);
  if (!worldPlayers) {
    socket.emit("room:state", []);
    return;
  }
  const others = [...worldPlayers.values()].filter((playerEntry) => playerEntry.id !== socket.userId).map(runtime.serializePlayerState);
  socket.emit("room:state", others);
}

function moveSocketBetweenWorlds({ io, socket, runtime, socketWorldIndex, nextWorldId, nextPlayerState }) {
  const previousWorldId = socketWorldIndex.get(socket.id) ?? null;
  const changedWorld = !!previousWorldId && previousWorldId !== nextWorldId;

  if (changedWorld) {
    runtime.removePlayer(previousWorldId, socket.userId);
    socket.leave(worldRoom(previousWorldId));
    io.to(worldRoom(previousWorldId)).emit("player:left", { id: socket.userId });
    runtime.emitWorldSnapshotForWorld(io, previousWorldId);
  }

  runtime.setPlayer(nextWorldId, socket.userId, nextPlayerState);
  socketWorldIndex.set(socket.id, nextWorldId);
  socket.join(worldRoom(nextWorldId));

  if (!previousWorldId || changedWorld) {
    socket.to(worldRoom(nextWorldId)).emit("player:joined", runtime.serializePlayerState(nextPlayerState));
  }

  emitRoomState(socket, runtime, nextWorldId);
  runtime.emitWorldSnapshotForWorld(io, nextWorldId);

  return {
    previousWorldId,
    changedWorld,
  };
}

function removeSocketFromWorld({ io, socket, runtime, socketWorldIndex }) {
  const worldId = socketWorldIndex.get(socket.id);
  if (!worldId) return null;

  const removedPlayer = runtime.removePlayer(worldId, socket.userId);
  socketWorldIndex.delete(socket.id);
  if (!removedPlayer) return { worldId };

  io.to(worldRoom(worldId)).emit("player:left", { id: socket.userId });
  runtime.emitWorldSnapshotForWorld(io, worldId);
  return { worldId };
}

async function resolveSocketTenantContext({ socket, resolveTenantContext, enableTenantSocketContext }) {
  if (!enableTenantSocketContext) return null;
  try {
    const context = await resolveTenantContext(socket.userId);
    socket.data.tenantContext = context;
    return context;
  } catch (error) {
    console.error("[tenant] socket context lookup failed for user:", socket.userId, error);
    return null;
  }
}

async function authorizeWorldAccess({ socket, worldId, canAccessWorld, enableTenantSocketContext }) {
  if (TEMP_PORTAL_WORLD_IDS.has(worldId)) return true;
  if (!enableTenantSocketContext) return true;
  try {
    return await canAccessWorld(socket.userId, worldId);
  } catch (error) {
    console.error("[tenant] world access check failed for user:", socket.userId, "world:", worldId, error);
    return false;
  }
}

function resolveJoinWorldId(payload, tenantContext) {
  const requestedWorldId = normalizeWorldId(payload?.worldId);
  if (requestedWorldId) return requestedWorldId;
  if (tenantContext?.mainPlazaWorldId) return tenantContext.mainPlazaWorldId;
  return "main_plaza";
}

function resolveChangeWorldId(payload) {
  const requestedWorldId = normalizeWorldId(payload?.targetWorldId);
  if (requestedWorldId) return requestedWorldId;
  const fromPortalKey = mapPortalZoneToWorldId(payload?.portalKey);
  if (fromPortalKey) return fromPortalKey;
  const fromZoneKey = mapPortalZoneToWorldId(payload?.zoneKey);
  if (fromZoneKey) return fromZoneKey;
  return "";
}

export function registerGameSocketHandlers({ io, runtime, teleportRequests, chatRateLimiter, resolveTenantContext, canAccessWorld, enableTenantSocketContext }) {
  const socketWorldIndex = new Map();

  async function joinWorld({ socket, payload, ack }) {
    const tenantContext = await resolveSocketTenantContext({
      socket,
      resolveTenantContext,
      enableTenantSocketContext,
    });
    if (enableTenantSocketContext && !tenantContext) {
      if (typeof ack === "function") ack({ error: "tenant_context_unavailable" });
      return;
    }

    const targetWorldId = resolveJoinWorldId(payload, tenantContext);
    const hasAccess = await authorizeWorldAccess({
      socket,
      worldId: targetWorldId,
      canAccessWorld,
      enableTenantSocketContext,
    });
    if (!hasAccess) {
      if (typeof ack === "function") ack({ error: "world_access_denied" });
      return;
    }

    const { name, avatar } = payload && typeof payload === "object" ? payload : {};
    const trimmedName = typeof name === "string" ? name.trim() : "";
    if (!trimmedName || trimmedName.length > 24 || !runtime.isValidAvatar(avatar)) {
      if (typeof ack === "function") ack({ error: "invalid_payload" });
      return;
    }

    const spawn = runtime.randomSpawn();
    const world = runtime.tileCenter(spawn.col, spawn.row);
    const zoneKey = runtime.detectZoneKey(world.x, world.y);
    const playerState = createPlayerState({
      socket,
      trimmedName,
      avatar,
      spawn,
      world,
      zoneKey,
    });

    moveSocketBetweenWorlds({
      io,
      socket,
      runtime,
      socketWorldIndex,
      nextWorldId: targetWorldId,
      nextPlayerState: playerState,
    });

    if (typeof ack === "function") {
      ack({
        col: spawn.col,
        row: spawn.row,
        x: world.x,
        y: world.y,
        worldId: targetWorldId,
        instanceType: inferInstanceType(targetWorldId, tenantContext),
        loading: { completed: true },
      });
    }
  }

  async function changeWorld({ socket, payload, ack }) {
    const tenantContext = await resolveSocketTenantContext({
      socket,
      resolveTenantContext,
      enableTenantSocketContext,
    });
    if (enableTenantSocketContext && !tenantContext) {
      if (typeof ack === "function") ack({ error: "tenant_context_unavailable" });
      return;
    }

    const currentWorld = socketWorldIndex.get(socket.id);
    if (!currentWorld) {
      if (typeof ack === "function") ack({ error: "world_not_joined" });
      return;
    }

    const targetWorldId = resolveChangeWorldId(payload);
    if (!targetWorldId) {
      if (typeof ack === "function") ack({ error: "target_world_required" });
      return;
    }

    if (targetWorldId === currentWorld) {
      if (typeof ack === "function") {
        ack({
          worldId: currentWorld,
          fromWorldId: currentWorld,
          unchanged: true,
          loading: { completed: true },
        });
      }
      return;
    }

    const hasAccess = await authorizeWorldAccess({
      socket,
      worldId: targetWorldId,
      canAccessWorld,
      enableTenantSocketContext,
    });
    if (!hasAccess) {
      if (typeof ack === "function") ack({ error: "world_access_denied" });
      return;
    }

    const currentWorldPlayers = runtime.getWorldPlayers(currentWorld);
    const currentPlayer = currentWorldPlayers?.get(socket.userId) ?? null;
    if (!currentPlayer) {
      if (typeof ack === "function") ack({ error: "player_not_joined" });
      return;
    }

    const spawn = runtime.randomSpawn();
    const world = runtime.tileCenter(spawn.col, spawn.row);
    const zoneKey = runtime.detectZoneKey(world.x, world.y);
    const nextPlayerState = {
      ...currentPlayer,
      x: world.x,
      y: world.y,
      vx: 0,
      vy: 0,
      col: spawn.col,
      row: spawn.row,
      moving: false,
      zoneKey,
      inputState: {
        seq: Number.isInteger(currentPlayer.lastProcessedInputSeq) ? currentPlayer.lastProcessedInputSeq : 0,
        inputX: 0,
        inputY: 0,
        facing: currentPlayer.facing,
        moving: false,
        clientTimeMs: Date.now(),
      },
    };

    const transition = moveSocketBetweenWorlds({
      io,
      socket,
      runtime,
      socketWorldIndex,
      nextWorldId: targetWorldId,
      nextPlayerState,
    });

    socket.emit("world:changed", {
      worldId: targetWorldId,
      fromWorldId: transition.previousWorldId,
      instanceType: inferInstanceType(targetWorldId, tenantContext),
    });

    if (typeof ack === "function") {
      ack({
        col: spawn.col,
        row: spawn.row,
        x: world.x,
        y: world.y,
        worldId: targetWorldId,
        fromWorldId: transition.previousWorldId,
        instanceType: inferInstanceType(targetWorldId, tenantContext),
        loading: { completed: true },
      });
    }
  }

  io.on("connection", (socket) => {
    console.log(`[connect] ${socket.userId}`);
    socket.join(`user:${socket.userId}`);

    socket.on("world:join", async (payload, ack) => {
      await joinWorld({ socket, payload, ack });
    });

    // Backward-compat alias while clients move to world:join.
    socket.on("player:join", async (payload, ack) => {
      await joinWorld({ socket, payload, ack });
    });

    socket.on("world:change", async (payload, ack) => {
      await changeWorld({ socket, payload, ack });
    });

    socket.on("player:input", (payload) => {
      const worldContext = getSocketWorldPlayers(runtime, socketWorldIndex, socket.id);
      if (!worldContext || !payload || typeof payload !== "object") return;

      const player = worldContext.players.get(socket.userId);
      if (!player) return;

      const seq = Number.isInteger(payload.seq) ? payload.seq : null;
      const inputX = Number.isFinite(payload.inputX) ? payload.inputX : null;
      const inputY = Number.isFinite(payload.inputY) ? payload.inputY : null;
      const moving = typeof payload.moving === "boolean" ? payload.moving : null;
      const facing = runtime.isValidDirection(payload.facing) ? payload.facing : null;
      const clientTimeMs = Number.isFinite(payload.clientTimeMs) ? payload.clientTimeMs : Date.now();
      if (seq === null || inputX === null || inputY === null || moving === null || facing === null) {
        return;
      }

      const lastInputSeq = Number.isInteger(player.inputState?.seq) ? player.inputState.seq : -1;
      if (seq < lastInputSeq) return;

      const normalized = normalizeInput(inputX, inputY, moving);
      player.inputState = {
        seq,
        inputX: normalized.inputX,
        inputY: normalized.inputY,
        facing,
        moving: normalized.moving,
        clientTimeMs,
      };
    });

    socket.on("player:voice", ({ muted }) => {
      const worldContext = getSocketWorldPlayers(runtime, socketWorldIndex, socket.id);
      if (!worldContext || typeof muted !== "boolean") return;

      const player = worldContext.players.get(socket.userId);
      if (!player) return;
      player.muted = muted;
      socket.to(worldRoom(worldContext.worldId)).emit("player:voice", { id: socket.userId, muted });
    });

    socket.on("chat:message", (payload) => {
      const worldContext = getSocketWorldPlayers(runtime, socketWorldIndex, socket.id);
      if (!worldContext || !payload || typeof payload !== "object") return;

      const player = worldContext.players.get(socket.userId);
      if (!player) return;

      const rawBody = typeof payload.body === "string" ? payload.body : typeof payload.text === "string" ? payload.text : "";
      const body = rawBody.trim();
      if (!body || body.length > 500) return;
      if (looksLikeReservedCommand(body)) return;

      const mentions = normalizeChatMentions(payload.mentions, worldContext.players);

      const now = Date.now();
      const rateCheck = chatRateLimiter.canSend(socket.userId, now);
      if (!rateCheck.allowed) {
        socket.emit("chat:rate_limited", { retryAfterMs: rateCheck.retryAfterMs });
        return;
      }

      io.to(worldRoom(worldContext.worldId)).emit("chat:message", {
        id: socket.userId,
        name: player.name,
        text: body,
        body,
        mentions,
        timestamp: now,
      });
    });

    socket.on("tag:send", (payload, ack) => {
      const worldContext = getSocketWorldPlayers(runtime, socketWorldIndex, socket.id);
      if (!worldContext) {
        if (typeof ack === "function") ack({ ok: false, error: "world_not_joined" });
        return;
      }
      const result = handleTagSend({
        socket,
        io,
        players: worldContext.players,
        payload,
      });
      if (typeof ack === "function") ack(result);
    });

    socket.on("teleport:request", (payload, ack) => {
      const worldContext = getSocketWorldPlayers(runtime, socketWorldIndex, socket.id);
      if (!worldContext) {
        if (typeof ack === "function") ack({ ok: false, error: "world_not_joined" });
        return;
      }
      const result = handleTeleportRequest({
        socket,
        io,
        players: worldContext.players,
        payload,
        teleportRequests,
      });
      if (typeof ack === "function") ack(result);
    });

    socket.on("teleport:respond", (payload, ack) => {
      const worldContext = getSocketWorldPlayers(runtime, socketWorldIndex, socket.id);
      if (!worldContext) {
        if (typeof ack === "function") ack({ ok: false, error: "world_not_joined" });
        return;
      }
      const result = handleTeleportRespond({
        socket,
        io,
        players: worldContext.players,
        payload,
        teleportRequests,
        isValidTile: runtime.isValidTile,
        tileCenter: runtime.tileCenter,
        detectZoneKey: runtime.detectZoneKey,
      });
      if (result.ok && result.status === "accepted") runtime.emitWorldSnapshotForWorld(io, worldContext.worldId);
      if (typeof ack === "function") ack(result);
    });

    socket.on("disconnect", () => {
      const clearedTeleportRequests = teleportRequests.clearForUser(socket.userId);
      for (const request of clearedTeleportRequests) {
        if (request.senderId === socket.userId) {
          io.to(`user:${request.targetId}`).emit("teleport:request_cleared", {
            requestId: request.id,
            reason: "sender_disconnected",
          });
        } else if (request.targetId === socket.userId) {
          io.to(`user:${request.senderId}`).emit("teleport:result", {
            requestId: request.id,
            status: "failed",
            reason: "target_offline",
            targetUserId: request.targetId,
          });
        }
      }

      chatRateLimiter.clear(socket.userId);
      removeSocketFromWorld({
        io,
        socket,
        runtime,
        socketWorldIndex,
      });
    });
  });
}
