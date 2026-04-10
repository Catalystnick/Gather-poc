import { createRemoteJWKSet, jwtVerify } from "jose";

const SUPABASE_URL = process.env.SUPABASE_URL;
if (!SUPABASE_URL) throw new Error("[auth] SUPABASE_URL is not set");
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const parsedActiveUserCacheTtlMs = Number.parseInt(
  process.env.AUTH_ACTIVE_USER_CACHE_TTL_MS ?? "0",
  10,
);
const ACTIVE_USER_CACHE_TTL_MS =
  Number.isFinite(parsedActiveUserCacheTtlMs) && parsedActiveUserCacheTtlMs >= 0
    ? parsedActiveUserCacheTtlMs
    : 0;
const ACTIVE_USER_CACHE_MAX = 10_000;
const activeUserCache = new Map();
let hasWarnedMissingServiceRoleKey = false;

// JWKS is fetched once and cached automatically by jose.
// Supabase rotates keys gracefully so the cache stays valid across key rotations.
const JWKS = createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`));

async function readJson(response) {
  return response.json().catch(() => null);
}

function hasRecentActiveUserCheck(userId) {
  if (!ACTIVE_USER_CACHE_TTL_MS) return false;
  const expiresAt = activeUserCache.get(userId);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    activeUserCache.delete(userId);
    return false;
  }
  return true;
}

function rememberActiveUserCheck(userId) {
  if (!ACTIVE_USER_CACHE_TTL_MS) return;
  if (activeUserCache.size >= ACTIVE_USER_CACHE_MAX) {
    activeUserCache.delete(activeUserCache.keys().next().value);
  }
  activeUserCache.set(userId, Date.now() + ACTIVE_USER_CACHE_TTL_MS);
}

function shouldSkipActiveUserCheck() {
  if (SUPABASE_SERVICE_ROLE_KEY) return false;
  if (!hasWarnedMissingServiceRoleKey) {
    hasWarnedMissingServiceRoleKey = true;
    console.warn(
      "[auth] skipping active-user check because SUPABASE_SERVICE_ROLE_KEY is not set",
    );
  }
  return true;
}

function getPayloadUserId(payload) {
  const topLevelId =
    payload && typeof payload.id === "string" ? payload.id : "";
  if (topLevelId) return topLevelId;
  const nestedId =
    payload?.user && typeof payload.user.id === "string" ? payload.user.id : "";
  return nestedId;
}

async function fetchAuthUserById(userId) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: "GET",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json",
    },
  });

  if (response.status === 404) return false;
  if (!response.ok) {
    const payload = await readJson(response);
    console.warn("[auth] active-user check failed", {
      status: response.status,
      payload,
    });
    throw new Error("Unable to verify user account status");
  }

  const payload = await readJson(response);
  const foundUserId = getPayloadUserId(payload);
  return foundUserId === userId;
}

async function ensureActiveAuthUser(userId) {
  if (!userId) throw new Error("Invalid token subject");
  if (hasRecentActiveUserCheck(userId)) return;
  if (shouldSkipActiveUserCheck()) return;

  const isActive = await fetchAuthUserById(userId);
  if (!isActive) {
    activeUserCache.delete(userId);
    throw new Error("User account no longer exists");
  }
  rememberActiveUserCheck(userId);
}

/** Verify Supabase JWT and enforce authenticated role claims. */
export async function verifySupabaseToken(token) {
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: `${SUPABASE_URL}/auth/v1`,
    audience: 'authenticated',
  });
  // `role: "authenticated"` is the canonical Supabase signal for a verified user.
  // email_confirmed_at is not included in newer JWTs (esp. OAuth providers).
  if (payload.role !== "authenticated") throw new Error("Not authenticated");
  await ensureActiveAuthUser(payload.sub);
  console.log("[auth] token verified | sub:", payload.sub, "| email:", payload.email);
  return payload;
}

// HTTP middleware — protects Express routes.
// Expects: Authorization: Bearer <supabase-access-token>
export async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split("Bearer ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = await verifySupabaseToken(token);
    next();
  } catch (err) {
    return res.status(401).json({ error: err.message || "Invalid or expired token" });
  }
}

// Socket.IO middleware — rejects unauthenticated handshakes before connection is created.
// Token passed as: io(url, { auth: { token: accessToken } })
export async function requireAuthSocket(socket, next) {
  const token = socket.handshake.auth?.token;
  console.log("[auth:socket] handshake | token present:", !!token, "| token length:", token?.length);
  if (!token) {
    console.warn("[auth:socket] rejected — no token");
    return next(new Error("Unauthorized"));
  }
  try {
    const payload = await verifySupabaseToken(token);
    socket.userId = payload.sub;
    console.log("[auth:socket] accepted | userId:", socket.userId);
    next();
  } catch (err) {
    console.warn("[auth:socket] rejected —", err.message);
    next(new Error(err.message || "Invalid or expired token"));
  }
}
