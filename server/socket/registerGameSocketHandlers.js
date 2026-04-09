import { normalizeInput } from "../world/movementMath.js";
import { handleTagSend, handleTeleportRequest, handleTeleportRespond } from "../chat/commandRouter.js";

//TODO: Temp for testing, zone values will come from Tiled map data
const TEMP_PORTAL_WORLD_BY_ZONE = {
  dev: "interior_world_dev",
  design: "interior_world_design",
  game: "interior_world_game",
};

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

function normalizeWorldKey(value) {
  return typeof value === "string" ? value.trim() : "";
}

function mapPortalZoneToWorldKey(rawZone) {
  const key = typeof rawZone === "string" ? rawZone.trim().toLowerCase() : "";
  if (!key) return "";
  return TEMP_PORTAL_WORLD_BY_ZONE[key] ?? "";
}

function inferInstanceType(world) {
  if (world?.world_type === "main_plaza") return "main_plaza";
  return "tenant_interior";
}

function isMainPlazaWorld(worldId, tenantContext) {
  if (!worldId) return false;
  if (worldId === "main_plaza") return true;
  return !!tenantContext?.mainPlazaWorldId && worldId === tenantContext.mainPlazaWorldId;
}

function normalizeTargetUserIds(rawTargetUserIds) {
  if (!Array.isArray(rawTargetUserIds)) return [];
  const uniqueTargetIds = new Set();
  for (const value of rawTargetUserIds) {
    if (typeof value !== "string") continue;
    const targetId = value.trim();
    if (!targetId) continue;
    uniqueTargetIds.add(targetId);
  }
  return [...uniqueTargetIds];
}

function isActiveInteriorMemberForWorld(tenantContext, worldId) {
  if (!tenantContext?.hasMembership || !tenantContext.homeTenantId || !tenantContext.homeInteriorWorldId) {
    return false;
  }

  return tenantContext.homeInteriorWorldId === worldId;
}

function resolveTeleportScope({ worldId, tenantContext }) {
  if (isMainPlazaWorld(worldId, tenantContext)) {
    return { ok: false, error: "teleport:not_allowed_in_plaza" };
  }

  if (!isActiveInteriorMemberForWorld(tenantContext, worldId)) {
    return { ok: false, error: "teleport:not_allowed_cross_tenant" };
  }

  return {
    ok: true,
    tenantId: tenantContext.homeTenantId,
  };
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

function normalizePositiveInteger(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.floor(Number(value));
  if (rounded <= 0) return fallback;
  return rounded;
}

function parseCheckpointToken(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.token !== "string") return "";
  return payload.token.trim();
}

async function verifySocketTokenForUser({ socket, token, verifySocketToken }) {
  if (!token) return false;
  if (typeof verifySocketToken !== "function") return false;
  try {
    const payload = await verifySocketToken(token);
    return payload?.sub === socket.userId;
  } catch (error) {
    return false;
  }
}

function createSocketAuthCheckpoint({ socket, verifySocketToken, authCheckpointMs, authCheckpointTimeoutMs }) {
  if (typeof verifySocketToken !== "function") return () => {};

  const intervalMs = normalizePositiveInteger(authCheckpointMs, 0);
  if (!intervalMs) return () => {};

  const timeoutMs = normalizePositiveInteger(authCheckpointTimeoutMs, 10_000);
  let authCheckInFlight = false;

  const timerId = setInterval(() => {
    if (authCheckInFlight || !socket.connected) return;
    authCheckInFlight = true;
    socket.timeout(timeoutMs).emit("auth:checkpoint", { requestedAt: Date.now() }, async (err, payload) => {
      authCheckInFlight = false;
      if (err) {
        socket.disconnect(true);
        return;
      }

      const token = parseCheckpointToken(payload);
      const isValid = await verifySocketTokenForUser({ socket, token, verifySocketToken });
      if (!isValid) socket.disconnect(true);
    });
  }, intervalMs);

  return () => {
    clearInterval(timerId);
  };
}

async function resolveSocketTenantContext({ socket, resolveTenantContext }) {
  try {
    const context = await resolveTenantContext(socket.userId);
    socket.data.tenantContext = context;
    return context;
  } catch (error) {
    console.error("[tenant] socket context lookup failed for user:", socket.userId, error);
    return null;
  }
}

async function authorizeWorldAccess({ socket, worldId, canAccessWorld }) {
  try {
    return await canAccessWorld(socket.userId, worldId);
  } catch (error) {
    console.error("[tenant] world access check failed for user:", socket.userId, "world:", worldId, error);
    return false;
  }
}

async function resolveTargetTenantContext({ targetId, resolveTenantContext }) {
  try {
    return await resolveTenantContext(targetId);
  } catch (error) {
    console.error("[tenant] target context lookup failed for user:", targetId, error);
    return null;
  }
}

async function filterTeleportTargets({ worldId, senderUserId, senderTenantContext, targetUserIds, worldPlayers, resolveTenantContext }) {
  const requestedTargetIds = normalizeTargetUserIds(targetUserIds);

  const onlineTargetIds = requestedTargetIds.filter((targetId) => targetId !== senderUserId && worldPlayers.has(targetId));
  const targetContexts = await Promise.all(onlineTargetIds.map((targetId) => resolveTargetTenantContext({ targetId, resolveTenantContext })));

  const blockedTargetIds = new Set();
  const rejected = [];

  for (let i = 0; i < onlineTargetIds.length; i += 1) {
    const targetId = onlineTargetIds[i];
    const targetContext = targetContexts[i];
    const sameTenant = targetContext?.homeTenantId === senderTenantContext.homeTenantId;
    const targetCanTeleportInWorld = isActiveInteriorMemberForWorld(targetContext, worldId);

    if (!sameTenant || !targetCanTeleportInWorld) {
      blockedTargetIds.add(targetId);
      rejected.push({ userId: targetId, reason: "not_allowed_cross_tenant" });
      continue;
    }
  }

  const allowedTargetIds = requestedTargetIds.filter((targetId) => !blockedTargetIds.has(targetId));
  return { allowedTargetIds, rejected };
}

async function findWorldByIdentifier({ worldId, worldKey, getWorldById, getWorldByKey }) {
  if (worldId) return getWorldById(worldId);
  if (worldKey) return getWorldByKey(worldKey);
  return null;
}

async function resolveJoinWorld({ payload, tenantContext, getWorldById, getWorldByKey }) {
  const requestedWorldId = normalizeWorldId(payload?.worldId);
  const requestedWorldKey = normalizeWorldKey(payload?.worldKey);

  const explicitWorld = await findWorldByIdentifier({
    worldId: requestedWorldId,
    worldKey: requestedWorldKey,
    getWorldById,
    getWorldByKey,
  });
  if (explicitWorld) return explicitWorld;
  if (requestedWorldId || requestedWorldKey) return null;

  const fallbackMainPlazaId = normalizeWorldId(tenantContext?.mainPlazaWorldId);
  const mainPlazaById = await findWorldByIdentifier({
    worldId: fallbackMainPlazaId,
    worldKey: "",
    getWorldById,
    getWorldByKey,
  });
  if (mainPlazaById) return mainPlazaById;

  return findWorldByIdentifier({
    worldId: "",
    worldKey: "main_plaza",
    getWorldById,
    getWorldByKey,
  });
}

async function resolveChangeWorld({ payload, getWorldById, getWorldByKey }) {
  const requestedWorldId = normalizeWorldId(payload?.targetWorldId);
  const requestedWorldKey = normalizeWorldKey(payload?.targetWorldKey);

  const explicitWorld = await findWorldByIdentifier({
    worldId: requestedWorldId,
    worldKey: requestedWorldKey,
    getWorldById,
    getWorldByKey,
  });
  if (explicitWorld) return explicitWorld;
  if (requestedWorldId || requestedWorldKey) return null;

  const fromPortalKey = mapPortalZoneToWorldKey(payload?.portalKey);
  const fromZoneKey = mapPortalZoneToWorldKey(payload?.zoneKey);
  const derivedWorldKey = fromPortalKey || fromZoneKey;
  if (!derivedWorldKey) return null;

  return findWorldByIdentifier({
    worldId: "",
    worldKey: derivedWorldKey,
    getWorldById,
    getWorldByKey,
  });
}

export function registerGameSocketHandlers({
  io,
  runtime,
  teleportRequests,
  chatRateLimiter,
  resolveTenantContext,
  canAccessWorld,
  getWorldById,
  getWorldByKey,
  verifySocketToken,
  authCheckpointMs,
  authCheckpointTimeoutMs,
}) {
  const socketWorldIndex = new Map();

  async function joinWorld({ socket, payload, ack }) {
    const tenantContext = await resolveSocketTenantContext({
      socket,
      resolveTenantContext,
    });
    if (!tenantContext) {
      if (typeof ack === "function") ack({ error: "tenant_context_unavailable" });
      return;
    }

    const targetWorld = await resolveJoinWorld({
      payload,
      tenantContext,
      getWorldById,
      getWorldByKey,
    });
    if (!targetWorld?.id) {
      if (typeof ack === "function") ack({ error: "world_not_found" });
      return;
    }

    const hasAccess = await authorizeWorldAccess({
      socket,
      worldId: targetWorld.id,
      canAccessWorld,
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
      nextWorldId: targetWorld.id,
      nextPlayerState: playerState,
    });

    if (typeof ack === "function") {
      ack({
        col: spawn.col,
        row: spawn.row,
        x: world.x,
        y: world.y,
        worldId: targetWorld.id,
        worldKey: targetWorld.key ?? null,
        instanceType: inferInstanceType(targetWorld),
        loading: { completed: true },
      });
    }
  }

  async function changeWorld({ socket, payload, ack }) {
    const tenantContext = await resolveSocketTenantContext({
      socket,
      resolveTenantContext,
    });
    if (!tenantContext) {
      if (typeof ack === "function") ack({ error: "tenant_context_unavailable" });
      return;
    }

    const currentWorld = socketWorldIndex.get(socket.id);
    if (!currentWorld) {
      if (typeof ack === "function") ack({ error: "world_not_joined" });
      return;
    }

    const requestedTargetWorldId = normalizeWorldId(payload?.targetWorldId);
    const requestedTargetWorldKey = normalizeWorldKey(payload?.targetWorldKey);
    const targetWorld = await resolveChangeWorld({
      payload,
      getWorldById,
      getWorldByKey,
    });
    if (!targetWorld?.id) {
      const errorCode = requestedTargetWorldId || requestedTargetWorldKey ? "world_not_found" : "target_world_required";
      if (typeof ack === "function") ack({ error: errorCode });
      return;
    }

    if (targetWorld.id === currentWorld) {
      const currentWorldRow = await getWorldById(currentWorld);
      if (typeof ack === "function") {
        ack({
          worldId: currentWorld,
          worldKey: currentWorldRow?.key ?? null,
          fromWorldId: currentWorld,
          unchanged: true,
          loading: { completed: true },
        });
      }
      return;
    }

    const hasAccess = await authorizeWorldAccess({
      socket,
      worldId: targetWorld.id,
      canAccessWorld,
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
      nextWorldId: targetWorld.id,
      nextPlayerState,
    });

    socket.emit("world:changed", {
      worldId: targetWorld.id,
      worldKey: targetWorld.key ?? null,
      fromWorldId: transition.previousWorldId,
      instanceType: inferInstanceType(targetWorld),
    });

    if (typeof ack === "function") {
      ack({
        col: spawn.col,
        row: spawn.row,
        x: world.x,
        y: world.y,
        worldId: targetWorld.id,
        worldKey: targetWorld.key ?? null,
        fromWorldId: transition.previousWorldId,
        instanceType: inferInstanceType(targetWorld),
        loading: { completed: true },
      });
    }
  }

  function registerWorldHandlers(socket) {
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
  }

  function registerAuthHandlers(socket) {
    socket.on("auth:refresh", async (payload, ack) => {
      const token = parseCheckpointToken(payload);
      const isValid = await verifySocketTokenForUser({ socket, token, verifySocketToken });
      if (!isValid) {
        if (typeof ack === "function") ack({ ok: false, error: "invalid_token" });
        socket.disconnect(true);
        return;
      }
      if (typeof ack === "function") ack({ ok: true });
    });
  }

  function registerRuntimeHandlers(socket) {
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
  }

  function registerVoiceAndChatHandlers(socket) {
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
  }

  function registerTagAndTeleportHandlers(socket) {
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

    socket.on("teleport:request", async (payload, ack) => {
      const worldContext = getSocketWorldPlayers(runtime, socketWorldIndex, socket.id);
      if (!worldContext) {
        if (typeof ack === "function") ack({ ok: false, error: "world_not_joined" });
        return;
      }

      const senderTenantContext = await resolveSocketTenantContext({
        socket,
        resolveTenantContext,
      });
      if (!senderTenantContext) {
        if (typeof ack === "function") ack({ ok: false, error: "tenant_context_unavailable" });
        return;
      }

      const teleportScope = resolveTeleportScope({
        worldId: worldContext.worldId,
        tenantContext: senderTenantContext,
      });
      if (!teleportScope.ok) {
        if (typeof ack === "function") ack({ ok: false, error: teleportScope.error });
        return;
      }

      const targetFilter = await filterTeleportTargets({
        worldId: worldContext.worldId,
        senderUserId: socket.userId,
        senderTenantContext,
        targetUserIds: payload?.targetUserIds,
        worldPlayers: worldContext.players,
        resolveTenantContext,
      });

      if (!targetFilter.allowedTargetIds.length && targetFilter.rejected.length) {
        if (typeof ack === "function") {
          ack({
            ok: false,
            error: "teleport:not_allowed_cross_tenant",
            rejected: targetFilter.rejected,
          });
        }
        return;
      }

      const result = handleTeleportRequest({
        socket,
        io,
        players: worldContext.players,
        payload: {
          ...payload,
          targetUserIds: targetFilter.allowedTargetIds,
        },
        teleportRequests,
        teleportContext: {
          worldId: worldContext.worldId,
          tenantId: teleportScope.tenantId,
        },
      });

      if (targetFilter.rejected.length) {
        const mergedRejected = [...(result.rejected ?? []), ...targetFilter.rejected];
        if (typeof ack === "function") ack({ ...result, rejected: mergedRejected });
        return;
      }

      if (typeof ack === "function") ack(result);
    });

    socket.on("teleport:respond", async (payload, ack) => {
      const worldContext = getSocketWorldPlayers(runtime, socketWorldIndex, socket.id);
      if (!worldContext) {
        if (typeof ack === "function") ack({ ok: false, error: "world_not_joined" });
        return;
      }

      const responderTenantContext = await resolveSocketTenantContext({
        socket,
        resolveTenantContext,
      });
      if (!responderTenantContext) {
        if (typeof ack === "function") ack({ ok: false, error: "tenant_context_unavailable" });
        return;
      }

      const teleportScope = resolveTeleportScope({
        worldId: worldContext.worldId,
        tenantContext: responderTenantContext,
      });
      if (!teleportScope.ok) {
        if (typeof ack === "function") ack({ ok: false, error: teleportScope.error });
        return;
      }

      const result = handleTeleportRespond({
        socket,
        io,
        players: worldContext.players,
        payload,
        teleportRequests,
        teleportContext: {
          worldId: worldContext.worldId,
          tenantId: teleportScope.tenantId,
        },
        isValidTile: runtime.isValidTile,
        tileCenter: runtime.tileCenter,
        detectZoneKey: runtime.detectZoneKey,
      });
      if (result.ok && result.status === "accepted") runtime.emitWorldSnapshotForWorld(io, worldContext.worldId);
      if (typeof ack === "function") ack(result);
    });
  }

  function registerDisconnectHandler(socket, stopAuthCheckpoint) {
    socket.on("disconnect", () => {
      stopAuthCheckpoint();
      const worldId = socketWorldIndex.get(socket.id) ?? null;
      const clearedTeleportRequests = worldId ? teleportRequests.clearForUserInWorld({ worldId, userId: socket.userId }) : [];
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
  }

  io.on("connection", (socket) => {
    console.log(`[connect] ${socket.userId}`);
    socket.join(`user:${socket.userId}`);
    const stopAuthCheckpoint = createSocketAuthCheckpoint({
      socket,
      verifySocketToken,
      authCheckpointMs,
      authCheckpointTimeoutMs,
    });

    registerWorldHandlers(socket);
    registerAuthHandlers(socket);
    registerRuntimeHandlers(socket);
    registerVoiceAndChatHandlers(socket);
    registerTagAndTeleportHandlers(socket);
    registerDisconnectHandler(socket, stopAuthCheckpoint);
  });
}
