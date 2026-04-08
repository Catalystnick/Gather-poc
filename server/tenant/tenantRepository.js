import { createHash } from "node:crypto";
import { supabaseRestRequest } from "./supabaseRest.js";
import { toClientTenantAccessConfig } from "./accessConfigMapper.js";

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

async function resolveRoleKey(roleId) {
  if (!roleId) return null;
  const role = await getRoleById(roleId);
  return role?.key ?? null;
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
      select: "tenant_id,role_id",
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

export async function updateTenantAccessPolicy({ tenantId, accessPolicy }) {
  const rows = await supabaseRestRequest({
    path: "tenants",
    method: "PATCH",
    query: {
      id: `eq.${tenantId}`,
    },
    prefer: "return=representation",
    body: {
      access_policy: accessPolicy,
    },
  });
  return firstRow(rows);
}

export async function getTenantAccessConfig(tenantId) {
  const rows = await supabaseRestRequest({
    path: "tenant_access_configs",
    query: {
      select: "tenant_id,guest_zone_enforced,guest_can_chat,guest_can_tag,guest_can_teleport,member_can_tag,member_can_teleport,updated_by,updated_at",
      tenant_id: `eq.${tenantId}`,
      limit: 1,
    },
  });
  return firstRow(rows);
}

export async function createTenantAccessConfig({ tenantId, updatedBy, config }) {
  const rows = await supabaseRestRequest({
    path: "tenant_access_configs",
    method: "POST",
    prefer: "return=representation",
    body: {
      tenant_id: tenantId,
      updated_by: updatedBy,
      ...(config ?? {}),
    },
  });
  return firstRow(rows);
}

export async function updateTenantAccessConfig({ tenantId, updatedBy, config }) {
  const rows = await supabaseRestRequest({
    path: "tenant_access_configs",
    method: "PATCH",
    query: {
      tenant_id: `eq.${tenantId}`,
    },
    prefer: "return=representation",
    body: {
      updated_by: updatedBy,
      ...config,
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

export async function getWorldByKey(worldKey) {
  const rows = await supabaseRestRequest({
    path: "worlds",
    query: {
      select: "id,key,world_type,tenant_id,display_name,map_key,is_active",
      key: `eq.${worldKey}`,
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

export async function getRoleById(roleId) {
  const rows = await supabaseRestRequest({
    path: "roles",
    query: {
      select: "id,key,name",
      id: `eq.${roleId}`,
      limit: 1,
    },
  });
  return firstRow(rows);
}

export async function getRoleByKey(roleKey) {
  const rows = await supabaseRestRequest({
    path: "roles",
    query: {
      select: "id,key,name",
      key: `eq.${roleKey}`,
      limit: 1,
    },
  });
  return firstRow(rows);
}

export async function listPermissionKeysByRoleId(roleId) {
  const rolePermissionRows = await supabaseRestRequest({
    path: "role_permissions",
    query: {
      select: "permission_id",
      role_id: `eq.${roleId}`,
    },
  });

  const permissionIds = (Array.isArray(rolePermissionRows) ? rolePermissionRows : [])
    .map((row) => row.permission_id)
    .filter(Boolean);
  if (!permissionIds.length) return [];

  const rows = await supabaseRestRequest({
    path: "permissions",
    query: {
      select: "key",
      id: `in.(${permissionIds.join(",")})`,
    },
  });

  return (Array.isArray(rows) ? rows : [])
    .map((row) => row.key)
    .filter((key) => typeof key === "string");
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

export async function createMembership({ tenantId, userId, roleId, status = "active" }) {
  const roleKey = await resolveRoleKey(roleId);
  const rows = await supabaseRestRequest({
    path: "tenant_memberships",
    method: "POST",
    prefer: "return=representation",
    body: {
      tenant_id: tenantId,
      user_id: userId,
      role_id: roleId,
      role: roleKey,
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
      select: "id,tenant_id,user_id,role,role_id,status",
      tenant_id: `eq.${tenantId}`,
      user_id: `eq.${userId}`,
      status: "eq.active",
      limit: 1,
    },
  });
  return firstRow(rows);
}

export async function countActiveMembershipsByRoleId({ tenantId, roleId }) {
  const rows = await supabaseRestRequest({
    path: "tenant_memberships",
    query: {
      select: "id",
      tenant_id: `eq.${tenantId}`,
      role_id: `eq.${roleId}`,
      status: "eq.active",
    },
  });
  return Array.isArray(rows) ? rows.length : 0;
}

export async function updateMembershipRole({ membershipId, roleId }) {
  const roleKey = await resolveRoleKey(roleId);
  const rows = await supabaseRestRequest({
    path: "tenant_memberships",
    method: "PATCH",
    query: {
      id: `eq.${membershipId}`,
    },
    prefer: "return=representation",
    body: {
      role_id: roleId,
      role: roleKey,
    },
  });
  return firstRow(rows);
}

export async function updateMembershipStatus({ membershipId, status }) {
  const rows = await supabaseRestRequest({
    path: "tenant_memberships",
    method: "PATCH",
    query: {
      id: `eq.${membershipId}`,
    },
    prefer: "return=representation",
    body: {
      status,
    },
  });
  return firstRow(rows);
}

export async function createInvite({
  tenantId,
  invitedRoleId,
  emailOptional,
  expiresAt,
  invitedBy,
  rawToken,
}) {
  const invitedRoleKey = await resolveRoleKey(invitedRoleId);
  const rows = await supabaseRestRequest({
    path: "tenant_invites",
    method: "POST",
    prefer: "return=representation",
    body: {
      tenant_id: tenantId,
      token_hash: inviteTokenHash(rawToken),
      role: invitedRoleKey,
      invited_role_id: invitedRoleId,
      email_optional: emailOptional ?? null,
      expires_at: expiresAt,
      invited_by: invitedBy,
      status: "pending",
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
      select: "id,tenant_id,invited_role_id",
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
      roleKey: null,
      permissions: [],
      homeInteriorWorldId: null,
      hasMembership: false,
    };
  }

  const [tenant, interiorWorld, role, accessConfig] = await Promise.all([
    getTenantById(membership.tenant_id),
    getInteriorWorldByTenantId(membership.tenant_id),
    membership.role_id ? getRoleById(membership.role_id) : null,
    getTenantAccessConfig(membership.tenant_id),
  ]);
  const permissions = role?.id
    ? await listPermissionKeysByRoleId(role.id)
    : [];
  const roleKey = role?.key ?? null;

  return {
    userId,
    mainPlazaWorldId: mainPlazaWorld?.id ?? null,
    homeTenantId: membership.tenant_id,
    role: roleKey,
    roleKey,
    permissions,
    homeInteriorWorldId: interiorWorld?.id ?? null,
    hasMembership: true,
    tenant: tenant
      ? {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          accessPolicy: tenant.access_policy,
          accessConfig: toClientTenantAccessConfig(accessConfig),
        }
      : null,
  };
}
