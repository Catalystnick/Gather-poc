import { createHash } from "node:crypto";
import { supabaseRestRequest } from "./supabaseRest.js";

function firstRow(rows) {
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

function slugifyName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function normalizeSlug(raw) {
  return slugifyName(raw) || "tenant";
}

function inviteTokenHash(token) {
  // Raw invite tokens are never stored directly.
  return createHash("sha256").update(String(token)).digest("hex");
}

export async function getMainPlazaWorld() {
  // `main_plaza` is a singleton world row shared by all authenticated users.
  const rows = await supabaseRestRequest({
    path: "worlds",
    query: {
      select: "id,key,world_type,tenant_id,display_name,map_key,is_active",
      world_type: "eq.main_plaza",
      limit: 1,
    },
  });
  return firstRow(rows);
}

export async function createMainPlazaWorldIfMissing() {
  // Fast path: most calls should hit the already-seeded singleton row.
  const existing = await getMainPlazaWorld();
  if (existing) return existing;

  try {
    // Self-heal path: create the required main plaza row if seed data is missing.
    const rows = await supabaseRestRequest({
      path: "worlds",
      method: "POST",
      prefer: "return=representation",
      body: {
        tenant_id: null,
        world_type: "main_plaza",
        key: "main_plaza",
        display_name: "Main Plaza",
        map_key: "main_plaza",
        is_active: true,
      },
    });
    return firstRow(rows);
  } catch {
    // If another request created it first (unique constraint), re-read and return it.
    return getMainPlazaWorld();
  }
}

export async function getActiveMembershipByUserId(userId) {
  const rows = await supabaseRestRequest({
    path: "tenant_memberships",
    query: {
      select: "tenant_id,role",
      user_id: `eq.${userId}`,
      status: "eq.active",
      limit: 1,
    },
  });
  return firstRow(rows);
}

export async function getTenantById(tenantId) {
  const rows = await supabaseRestRequest({
    path: "tenants",
    query: {
      select: "id,name,slug,access_policy",
      id: `eq.${tenantId}`,
      limit: 1,
    },
  });
  return firstRow(rows);
}

export async function getWorldById(worldId) {
  const rows = await supabaseRestRequest({
    path: "worlds",
    query: {
      select: "id,key,world_type,tenant_id,display_name,map_key,is_active",
      id: `eq.${worldId}`,
      limit: 1,
    },
  });
  return firstRow(rows);
}

export async function getTenantBySlug(slug) {
  const rows = await supabaseRestRequest({
    path: "tenants",
    query: {
      select: "id",
      slug: `eq.${slug}`,
      limit: 1,
    },
  });
  return firstRow(rows);
}

export async function createTenant({ name, createdBy, accessPolicy = "public" }) {
  const baseSlug = normalizeSlug(name);
  let candidate = baseSlug;
  let suffix = 1;

  // Keep slug generation deterministic and simple.
  while (await getTenantBySlug(candidate)) {
    suffix += 1;
    candidate = `${baseSlug}-${suffix}`;
    if (candidate.length > 60) candidate = candidate.slice(0, 60);
  }

  const rows = await supabaseRestRequest({
    path: "tenants",
    method: "POST",
    prefer: "return=representation",
    body: {
      name: String(name).trim(),
      slug: candidate,
      access_policy: accessPolicy,
      created_by: createdBy,
    },
  });
  return firstRow(rows);
}

export async function createMembership({ tenantId, userId, role = "member", status = "active" }) {
  const rows = await supabaseRestRequest({
    path: "tenant_memberships",
    method: "POST",
    prefer: "return=representation",
    body: {
      tenant_id: tenantId,
      user_id: userId,
      role,
      status,
    },
  });
  return firstRow(rows);
}

export async function getInteriorWorldByTenantId(tenantId) {
  const rows = await supabaseRestRequest({
    path: "worlds",
    query: {
      select: "id,key,world_type,tenant_id,display_name,map_key,is_active",
      tenant_id: `eq.${tenantId}`,
      world_type: "eq.tenant_interior",
      limit: 1,
    },
  });
  return firstRow(rows);
}

export async function getActiveMembershipForTenantUser({ tenantId, userId }) {
  const rows = await supabaseRestRequest({
    path: "tenant_memberships",
    query: {
      select: "id",
      tenant_id: `eq.${tenantId}`,
      user_id: `eq.${userId}`,
      status: "eq.active",
      limit: 1,
    },
  });
  return firstRow(rows);
}

export async function getActiveAdminMembershipForTenantUser({ tenantId, userId }) {
  const rows = await supabaseRestRequest({
    path: "tenant_memberships",
    query: {
      select: "id",
      tenant_id: `eq.${tenantId}`,
      user_id: `eq.${userId}`,
      role: "eq.admin",
      status: "eq.active",
      limit: 1,
    },
  });
  return firstRow(rows);
}

export async function createInteriorWorld({ tenantId, tenantSlug, tenantName }) {
  const stablePart = tenantSlug || String(tenantId).slice(0, 8);
  const worldKey = `tenant_${stablePart}_interior`;
  const rows = await supabaseRestRequest({
    path: "worlds",
    method: "POST",
    prefer: "return=representation",
    body: {
      tenant_id: tenantId,
      world_type: "tenant_interior",
      key: worldKey,
      display_name: `${tenantName} Interior`,
      map_key: "interior_default",
      is_active: true,
    },
  });
  return firstRow(rows);
}

export async function getPendingInviteByToken(rawToken) {
  const tokenHash = inviteTokenHash(rawToken);
  const nowIso = new Date().toISOString();
  const rows = await supabaseRestRequest({
    path: "tenant_invites",
    query: {
      select: "id,tenant_id,role",
      token_hash: `eq.${tokenHash}`,
      status: "eq.pending",
      expires_at: `gt.${nowIso}`,
      limit: 1,
    },
  });
  return firstRow(rows);
}

export async function redeemInvite({ inviteId, userId }) {
  const rows = await supabaseRestRequest({
    path: "tenant_invites",
    method: "PATCH",
    query: {
      id: `eq.${inviteId}`,
    },
    prefer: "return=representation",
    body: {
      status: "redeemed",
      redeemed_by: userId,
      redeemed_at: new Date().toISOString(),
    },
  });
  return firstRow(rows);
}

export async function getContextByUserId(userId) {
  // Main plaza world is required for all authenticated users, with or without membership.
  const [mainPlazaWorld, membership] = await Promise.all([createMainPlazaWorldIfMissing(), getActiveMembershipByUserId(userId)]);

  if (!membership) {
    return {
      userId,
      mainPlazaWorldId: mainPlazaWorld?.id ?? null,
      homeTenantId: null,
      role: null,
      homeInteriorWorldId: null,
      hasMembership: false,
    };
  }

  const [tenant, interiorWorld] = await Promise.all([getTenantById(membership.tenant_id), getInteriorWorldByTenantId(membership.tenant_id)]);

  return {
    userId,
    mainPlazaWorldId: mainPlazaWorld?.id ?? null,
    homeTenantId: membership.tenant_id,
    role: membership.role,
    homeInteriorWorldId: interiorWorld?.id ?? null,
    hasMembership: true,
    tenant: tenant
      ? {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          accessPolicy: tenant.access_policy,
        }
      : null,
  };
}
