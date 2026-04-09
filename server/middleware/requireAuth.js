import { createRemoteJWKSet, jwtVerify } from "jose";

const SUPABASE_URL = process.env.SUPABASE_URL;
if (!SUPABASE_URL) throw new Error("[auth] SUPABASE_URL is not set");

// JWKS is fetched once and cached automatically by jose.
// Supabase rotates keys gracefully so the cache stays valid across key rotations.
const JWKS = createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`));

/** Verify Supabase JWT and enforce authenticated role claims. */
export async function verifySupabaseToken(token) {
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: `${SUPABASE_URL}/auth/v1`,
    audience: 'authenticated',
  });
  // `role: "authenticated"` is the canonical Supabase signal for a verified user.
  // email_confirmed_at is not included in newer JWTs (esp. OAuth providers).
  if (payload.role !== "authenticated") throw new Error("Not authenticated");
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
