import { TenantServiceError } from "./errors.js";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  toClientTenantAccessConfig,
  toClientTenantInviteAccessConfig,
} from "./accessConfigMapper.js";
import {
  buildTenantInviteLink,
  sendTenantInviteEmail,
} from "./inviteEmailService.js";
import {
  observeInviteCreated,
  observeInviteEmailAttempted,
  observeInviteEmailFailed,
  observeInviteEmailSent,
} from "../observability/tenantObservability.js";
import {
  countActiveMembershipsByRoleId,
  createInvite,
  createTenantAccessConfig,
  createInteriorWorld,
  createMembership,
  createTenant,
  createMainPlazaWorldIfMissing,
  getActiveMembershipByUserId,
  getActiveMembershipForTenantUser,
  getContextByUserId,
  getInteriorWorldByTenantId,
  getPendingInviteByToken,
  getPendingInviteForPreview,
  getRoleById,
  getRoleByKey,
  getTenantAccessConfig,
  getTenantById,
  getWorldByKey as getWorldByKeyFromRepository,
  getWorldById as getWorldByIdFromRepository,
  listActiveMembershipsForTenant,
  listPermissionKeysByRoleId,
  redeemInvite,
  updateMembershipRole,
  updateMembershipStatus,
  updateTenantAccessConfig,
  updateTenantAccessPolicy,
} from "./tenantRepository.js";

const parsedTenantContextTtlMs = Number.parseInt(
  process.env.TENANT_CONTEXT_TTL_MS ?? "60000",
  10,
);
const TENANT_CONTEXT_TTL_MS =
  Number.isFinite(parsedTenantContextTtlMs) && parsedTenantContextTtlMs > 0
    ? parsedTenantContextTtlMs
    : 60000;
// Small per-user TTL cache to avoid repeated DB reads during reconnect bursts.
const tenantContextCache = new Map();
const TENANT_ACCESS_POLICY_VALUES = new Set(["public", "private"]);
const TENANT_ACCESS_CONFIG_FIELDS = {
  guestZoneEnforced: "guest_zone_enforced",
  guestCanChat: "guest_can_chat",
  guestCanTag: "guest_can_tag",
  guestCanTeleport: "guest_can_teleport",
  memberCanTag: "member_can_tag",
  memberCanTeleport: "member_can_teleport",
};
const INVITE_PASSWORD_HASH_PREFIX = "scrypt";
const ROLE_OWNER_KEY = "owner";
const ROLE_ADMIN_KEY = "admin";
const ROLE_MEMBER_KEY = "member";
const INVITABLE_ROLE_KEYS = new Set([ROLE_ADMIN_KEY, ROLE_MEMBER_KEY]);
const PERMISSION_TENANT_INVITE_CREATE = "tenant.invite.create";
const PERMISSION_TENANT_MEMBERS_MANAGE = "tenant.members.manage";
const PERMISSION_TENANT_SETTINGS_MANAGE = "tenant.settings.manage";
const PERMISSION_TENANT_INVITE_ACCESS_MANAGE = "tenant.invite.access.manage";
const PERMISSION_TENANT_INVITE_PASSWORD_MANAGE =
  "tenant.invite.password.manage";

function getCachedContext(userId) {
  const entry = tenantContextCache.get(userId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    tenantContextCache.delete(userId);
    return null;
  }
  return entry.context;
}

const TENANT_CONTEXT_CACHE_MAX = 10_000;

function setCachedContext(userId, context) {
  if (tenantContextCache.size >= TENANT_CONTEXT_CACHE_MAX) {
    // Evict the oldest entry (Maps preserve insertion order).
    tenantContextCache.delete(tenantContextCache.keys().next().value);
  }
  tenantContextCache.set(userId, {
    context,
    expiresAt: Date.now() + TENANT_CONTEXT_TTL_MS,
  });
}

function clearCachedContext(userId) {
  tenantContextCache.delete(userId);
}

function requireTenantId(value) {
  return requireNonEmptyText(value, "tenant_id", 120);
}

function requireUserId(value, fieldName = "user_id") {
  return requireNonEmptyText(value, fieldName, 120);
}

function normalizeAccessPolicy(value) {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!normalized) return null;
  if (!TENANT_ACCESS_POLICY_VALUES.has(normalized)) {
    throw new TenantServiceError("Invalid access policy", {
      status: 400,
      code: "access_policy_invalid",
      details: { allowed: [...TENANT_ACCESS_POLICY_VALUES] },
    });
  }
  return normalized;
}

function normalizeAccessConfigPatch(rawConfig) {
  if (rawConfig === undefined) return null;
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    throw new TenantServiceError("tenant_access_config must be an object", {
      status: 400,
      code: "tenant_access_config_invalid",
    });
  }

  const patch = {};
  for (const [clientField, dbField] of Object.entries(
    TENANT_ACCESS_CONFIG_FIELDS,
  )) {
    if (!(clientField in rawConfig)) continue;
    if (typeof rawConfig[clientField] !== "boolean") {
      throw new TenantServiceError(`${clientField} must be boolean`, {
        status: 400,
        code: "tenant_access_config_invalid",
        details: { field: clientField },
      });
    }
    patch[dbField] = rawConfig[clientField];
  }

  if (!Object.keys(patch).length) {
    throw new TenantServiceError(
      "tenant_access_config has no supported fields",
      {
        status: 400,
        code: "tenant_access_config_empty",
        details: { supportedFields: Object.keys(TENANT_ACCESS_CONFIG_FIELDS) },
      },
    );
  }

  return patch;
}

function normalizeInviteAccessEmail(rawEmail) {
  const email = String(rawEmail ?? "").trim().toLowerCase();
  if (!email) return null;
  if (!email.includes("@")) {
    throw new TenantServiceError("invite allowlist email is invalid", {
      status: 400,
      code: "invite_allowlist_email_invalid",
      details: { value: rawEmail },
    });
  }
  return email;
}

function normalizeInviteAccessDomain(rawDomain) {
  const normalized = String(rawDomain ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
  if (!normalized) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(normalized)) {
    throw new TenantServiceError("invite allowlist domain is invalid", {
      status: 400,
      code: "invite_allowlist_domain_invalid",
      details: { value: rawDomain },
    });
  }
  return normalized;
}

function normalizeInviteAccessList(rawList, fieldName, normalizeEntry) {
  if (!Array.isArray(rawList)) {
    throw new TenantServiceError(`${fieldName} must be an array`, {
      status: 400,
      code: "invite_access_config_invalid",
      details: { field: fieldName },
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const entry of rawList) {
    const normalized = normalizeEntry(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

function parseScryptInvitePasswordHash(hash) {
  if (typeof hash !== "string" || !hash) return null;
  const [prefix, saltHex, keyHex] = hash.split(":");
  if (
    prefix !== INVITE_PASSWORD_HASH_PREFIX ||
    !saltHex ||
    !keyHex ||
    !/^[a-f0-9]+$/i.test(saltHex) ||
    !/^[a-f0-9]+$/i.test(keyHex)
  ) {
    return null;
  }
  return {
    salt: Buffer.from(saltHex, "hex"),
    key: Buffer.from(keyHex, "hex"),
  };
}

function hashInviteJoinPassword(password) {
  const rawPassword = String(password ?? "");
  if (rawPassword.length < 8) {
    throw new TenantServiceError("Invite password must be at least 8 characters", {
      status: 400,
      code: "invite_password_too_short",
    });
  }
  if (rawPassword.length > 128) {
    throw new TenantServiceError("Invite password is too long", {
      status: 400,
      code: "invite_password_too_long",
    });
  }

  const salt = randomBytes(16);
  const derivedKey = scryptSync(rawPassword, salt, 64);
  return `${INVITE_PASSWORD_HASH_PREFIX}:${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

function verifyInviteJoinPassword(rawPassword, storedHash) {
  const parsed = parseScryptInvitePasswordHash(storedHash);
  if (!parsed) return false;

  const candidate = String(rawPassword ?? "");
  if (!candidate) return false;

  const derivedKey = scryptSync(candidate, parsed.salt, parsed.key.length);
  if (derivedKey.length !== parsed.key.length) return false;
  return timingSafeEqual(derivedKey, parsed.key);
}

function resolveInviteAccessConfigState(currentConfig, patch) {
  const currentRequire = !!currentConfig?.invite_require_password_for_unlisted;
  const currentHash =
    typeof currentConfig?.invite_password_hash === "string"
      ? currentConfig.invite_password_hash
      : null;

  const nextRequire =
    typeof patch?.invite_require_password_for_unlisted === "boolean"
      ? patch.invite_require_password_for_unlisted
      : currentRequire;
  const nextHash = Object.prototype.hasOwnProperty.call(
    patch ?? {},
    "invite_password_hash",
  )
    ? patch.invite_password_hash
    : currentHash;

  return { nextRequire, nextHash };
}

function normalizeInviteAccessConfigPatch(rawConfig) {
  if (rawConfig === undefined) return null;
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    throw new TenantServiceError("invite_access_config must be an object", {
      status: 400,
      code: "invite_access_config_invalid",
    });
  }

  const patch = {};

  if ("allowlistDomains" in rawConfig) {
    patch.invite_allowlist_domains = normalizeInviteAccessList(
      rawConfig.allowlistDomains,
      "allowlistDomains",
      normalizeInviteAccessDomain,
    );
  }

  if ("allowlistEmails" in rawConfig) {
    patch.invite_allowlist_emails = normalizeInviteAccessList(
      rawConfig.allowlistEmails,
      "allowlistEmails",
      normalizeInviteAccessEmail,
    );
  }

  if ("requirePasswordForUnlisted" in rawConfig) {
    if (typeof rawConfig.requirePasswordForUnlisted !== "boolean") {
      throw new TenantServiceError("requirePasswordForUnlisted must be boolean", {
        status: 400,
        code: "invite_access_config_invalid",
        details: { field: "requirePasswordForUnlisted" },
      });
    }
    patch.invite_require_password_for_unlisted =
      rawConfig.requirePasswordForUnlisted;
  }

  const hasPasswordInput = "inviteJoinPassword" in rawConfig;
  const shouldClearPassword = rawConfig.clearInviteJoinPassword === true;
  const hasClearPasswordInput = "clearInviteJoinPassword" in rawConfig;
  if (hasPasswordInput && shouldClearPassword) {
    throw new TenantServiceError(
      "inviteJoinPassword and clearInviteJoinPassword cannot be set together",
      {
        status: 400,
        code: "invite_access_config_invalid",
      },
    );
  }

  if (hasPasswordInput) {
    if (typeof rawConfig.inviteJoinPassword !== "string") {
      throw new TenantServiceError("inviteJoinPassword must be a string", {
        status: 400,
        code: "invite_access_config_invalid",
        details: { field: "inviteJoinPassword" },
      });
    }
    const nextPassword = rawConfig.inviteJoinPassword.trim();
    if (!nextPassword) {
      throw new TenantServiceError("inviteJoinPassword cannot be empty", {
        status: 400,
        code: "invite_password_required",
      });
    }
    patch.invite_password_hash = hashInviteJoinPassword(nextPassword);
  } else if (shouldClearPassword) {
    patch.invite_password_hash = null;
  } else if (
    hasClearPasswordInput &&
    typeof rawConfig.clearInviteJoinPassword !== "boolean"
  ) {
    throw new TenantServiceError("clearInviteJoinPassword must be boolean", {
      status: 400,
      code: "invite_access_config_invalid",
      details: { field: "clearInviteJoinPassword" },
    });
  }

  if (!Object.keys(patch).length) {
    throw new TenantServiceError(
      "invite_access_config has no supported fields",
      {
        status: 400,
        code: "invite_access_config_empty",
      },
    );
  }

  return patch;
}

function normalizeStoredInviteStringArray(value, normalizeEntry) {
  if (!Array.isArray(value)) return [];
  const normalized = [];
  for (const entry of value) {
    try {
      const next = normalizeEntry(entry);
      if (typeof next === "string" && next.length > 0) normalized.push(next);
    } catch {
      // Ignore malformed persisted entries so they do not block invite joins.
    }
  }
  return normalized;
}

function extractEmailDomain(email) {
  const atIndex = email.lastIndexOf("@");
  if (atIndex <= 0) return "";
  return email.slice(atIndex + 1).trim().toLowerCase();
}

function isUserWhitelistedForInvite({
  normalizedUserEmail,
  allowlistEmails,
  allowlistDomains,
}) {
  if (!normalizedUserEmail) return false;
  if (allowlistEmails.includes(normalizedUserEmail)) return true;
  const domain = extractEmailDomain(normalizedUserEmail);
  if (!domain) return false;
  return allowlistDomains.includes(domain);
}

function requireNonEmptyText(value, fieldName, maxLen = 128) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new TenantServiceError(`${fieldName} is required`, {
      status: 400,
      code: `${fieldName}_required`,
    });
  }
  if (text.length > maxLen) {
    throw new TenantServiceError(`${fieldName} is too long`, {
      status: 400,
      code: `${fieldName}_too_long`,
    });
  }
  return text;
}

async function requireRoleId(roleKey) {
  const role = await getRoleByKey(roleKey);
  if (role?.id) return role.id;

  throw new TenantServiceError("Required role is not configured", {
    status: 500,
    code: "role_seed_missing",
    details: { roleKey },
  });
}

async function requireRole(roleKey) {
  const normalizedRoleKey = requireNonEmptyText(
    roleKey,
    "role_key",
    64,
  ).toLowerCase();
  const role = await getRoleByKey(normalizedRoleKey);
  if (role?.id) return role;
  throw new TenantServiceError("Role not found", {
    status: 400,
    code: "role_not_found",
    details: { roleKey: normalizedRoleKey },
  });
}

function normalizeInvitableRoleKey(roleKey) {
  const normalizedRoleKey = requireNonEmptyText(roleKey, "role_key", 64).toLowerCase();
  if (INVITABLE_ROLE_KEYS.has(normalizedRoleKey)) return normalizedRoleKey;
  throw new TenantServiceError("role_key is invalid for invites", {
    status: 400,
    code: "invite_role_invalid",
    details: { allowed: [...INVITABLE_ROLE_KEYS] },
  });
}

function isOwnerRole(roleKey) {
  return String(roleKey ?? "").trim().toLowerCase() === ROLE_OWNER_KEY;
}

async function ensureTenantExists(tenantId) {
  const tenant = await getTenantById(tenantId);
  if (tenant) return tenant;
  throw new TenantServiceError("Tenant not found", {
    status: 404,
    code: "tenant_not_found",
    details: { tenantId },
  });
}

async function ensureTenantPermission({
  actorUserId,
  tenantId,
  permissionKey,
  errorCode,
}) {
  const allowed = await hasTenantPermission(
    actorUserId,
    tenantId,
    permissionKey,
  );
  if (allowed) return;
  throw new TenantServiceError("Forbidden", {
    status: 403,
    code: errorCode,
    details: { tenantId, permissionKey },
  });
}

async function ensureMemberManagementAccess({ actorUserId, tenantId }) {
  await ensureTenantExists(tenantId);
  await ensureTenantPermission({
    actorUserId,
    tenantId,
    permissionKey: PERMISSION_TENANT_MEMBERS_MANAGE,
    errorCode: "tenant_members_forbidden",
  });
}

async function getActiveActorMembershipOrThrow({ tenantId, actorUserId }) {
  const membership = await getActiveMembershipForTenantUser({
    tenantId,
    userId: actorUserId,
  });
  if (membership?.id) return membership;
  throw new TenantServiceError("Forbidden", {
    status: 403,
    code: "tenant_members_forbidden",
    details: { tenantId },
  });
}

function ensureActorCanManageTargetRole({
  actorRoleKey,
  targetRoleKey,
  nextRoleKey,
}) {
  if (isOwnerRole(actorRoleKey)) return;
  if (isOwnerRole(targetRoleKey) || isOwnerRole(nextRoleKey)) {
    throw new TenantServiceError("Owner role can only be managed by an owner", {
      status: 403,
      code: "owner_role_forbidden",
    });
  }
}

async function getActiveMembershipOrThrow({ tenantId, targetUserId }) {
  const membership = await getActiveMembershipForTenantUser({
    tenantId,
    userId: targetUserId,
  });
  if (membership?.id) return membership;

  throw new TenantServiceError("Active membership not found", {
    status: 404,
    code: "membership_not_found",
    details: { tenantId, userId: targetUserId },
  });
}

function clearMembershipContexts(actorUserId, targetUserId) {
  clearCachedContext(actorUserId);
  clearCachedContext(targetUserId);
}

function isDevAdminToolEnabled() {
  const env = String(process.env.NODE_ENV ?? "development")
    .trim()
    .toLowerCase();
  if (env === "production") return false;

  const raw = process.env.ENABLE_DEV_TENANT_ADMIN_TOOL;
  if (raw === undefined) return true;

  const normalized = String(raw).trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

async function assertNotLastOwnerDemotion({
  tenantId,
  membership,
  nextRoleId,
}) {
  const ownerRoleId = await requireRoleId(ROLE_OWNER_KEY);
  const isOwnerMembership = membership.role_id === ownerRoleId;
  const remainsOwner = nextRoleId === ownerRoleId;
  if (!isOwnerMembership || remainsOwner) return;

  const activeOwnerCount = await countActiveMembershipsByRoleId({
    tenantId,
    roleId: ownerRoleId,
  });
  if (activeOwnerCount > 1) return;

  throw new TenantServiceError("Cannot remove the last tenant owner", {
    status: 409,
    code: "last_owner_required",
    details: { tenantId },
  });
}

async function ensureInteriorWorldForTenant(tenant) {
  const existing = await getInteriorWorldByTenantId(tenant.id);
  if (existing) return existing;

  // Interior world is created lazily so old tenants can self-heal on first access.
  return createInteriorWorld({
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    tenantName: tenant.name,
  });
}

async function ensureContextHasInteriorWorld(context) {
  if (!context?.hasMembership) return context;
  if (context.homeInteriorWorldId) return context;

  const tenant = await getTenantById(context.homeTenantId);
  if (!tenant) {
    throw new TenantServiceError(
      "Home tenant not found for active membership",
      {
        status: 500,
        code: "home_tenant_missing",
        details: { tenantId: context.homeTenantId },
      },
    );
  }
  await ensureInteriorWorldForTenant(tenant);
  return getContextByUserId(context.userId);
}

export async function resolveTenantContext(userId) {
  const cached = getCachedContext(userId);
  if (cached) return cached;

  const context = await getContextByUserId(userId);
  const next = await ensureContextHasInteriorWorld(context);
  setCachedContext(userId, next);
  return next;
}

export async function resolveMainPlazaWorld() {
  return createMainPlazaWorldIfMissing();
}

export async function resolveTenantInteriorWorld(tenantId) {
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    throw new TenantServiceError("Tenant not found", {
      status: 404,
      code: "tenant_not_found",
      details: { tenantId },
    });
  }
  return ensureInteriorWorldForTenant(tenant);
}

export async function canAccessWorld(userId, worldId) {
  const world = await getWorldByIdFromRepository(worldId);
  if (!world || world.is_active === false) return false;
  if (world.world_type === "main_plaza") return true;
  if (world.world_type !== "tenant_interior" || !world.tenant_id) return false;

  const tenant = await getTenantById(world.tenant_id);
  if (!tenant) return false;
  // Public interiors allow visitors; private interiors require active membership.
  if (tenant.access_policy === "public") return true;

  const membership = await getActiveMembershipForTenantUser({
    tenantId: world.tenant_id,
    userId,
  });
  return !!membership;
}

export async function getWorldById(worldId) {
  return getWorldByIdFromRepository(worldId);
}

export async function getWorldByKey(worldKey) {
  return getWorldByKeyFromRepository(worldKey);
}


export async function listTenantMembers({ actorUserId, tenantId }) {
  const normalizedActorUserId = requireUserId(actorUserId, "actor_user_id");
  const normalizedTenantId = requireTenantId(tenantId);
  await ensureTenantPermission({
    actorUserId: normalizedActorUserId,
    tenantId: normalizedTenantId,
    permissionKey: PERMISSION_TENANT_MEMBERS_MANAGE,
    errorCode: "tenant_members_forbidden",
  });

  const memberships = await listActiveMembershipsForTenant(normalizedTenantId);
  return memberships.map((membership) => ({
    membershipId: membership.id,
    userId: membership.user_id,
    email: membership.email ?? null,
    displayName: membership.display_name ?? null,
    roleKey: membership.role_key ?? null,
  }));
}

export async function hasTenantPermission(userId, tenantId, permissionKey) {
  const membership = await getActiveMembershipForTenantUser({
    tenantId,
    userId,
  });
  if (!membership?.role_id) return false;

  const permissionKeys = await listPermissionKeysByRoleId(membership.role_id);
  return permissionKeys.includes(permissionKey);
}

async function ensureTenantAccessConfigRow({ tenantId, userId }) {
  const existing = await getTenantAccessConfig(tenantId);
  if (existing) return existing;
  return createTenantAccessConfig({
    tenantId,
    updatedBy: userId,
  });
}

export async function updateTenantSettings({
  actorUserId,
  tenantId,
  accessPolicy,
  tenantAccessConfig,
  inviteAccessConfig,
}) {
  const normalizedTenantId = requireTenantId(tenantId);
  const nextAccessPolicy = normalizeAccessPolicy(accessPolicy);
  const accessConfigPatch = normalizeAccessConfigPatch(tenantAccessConfig);
  const inviteAccessPatch = normalizeInviteAccessConfigPatch(inviteAccessConfig);

  if (!nextAccessPolicy && !accessConfigPatch && !inviteAccessPatch) {
    throw new TenantServiceError("No settings provided", {
      status: 400,
      code: "settings_empty",
    });
  }

  const tenant = await ensureTenantExists(normalizedTenantId);
  const hasTenantSettingsPatch = !!nextAccessPolicy || !!accessConfigPatch;
  const hasInviteAccessPatch = !!inviteAccessPatch;
  const hasInvitePasswordHashPatch =
    hasInviteAccessPatch &&
    Object.prototype.hasOwnProperty.call(inviteAccessPatch, "invite_password_hash");
  const hasInvitePasswordPolicyPatch =
    hasInviteAccessPatch &&
    Object.prototype.hasOwnProperty.call(
      inviteAccessPatch,
      "invite_require_password_for_unlisted",
    );
  const hasInviteAllowlistPatch =
    hasInviteAccessPatch &&
    (Object.prototype.hasOwnProperty.call(
      inviteAccessPatch,
      "invite_allowlist_domains",
    ) ||
      Object.prototype.hasOwnProperty.call(
        inviteAccessPatch,
        "invite_allowlist_emails",
      ));

  if (hasTenantSettingsPatch) {
    await ensureTenantPermission({
      actorUserId,
      tenantId: normalizedTenantId,
      permissionKey: PERMISSION_TENANT_SETTINGS_MANAGE,
      errorCode: "tenant_settings_forbidden",
    });
  }
  if (hasInviteAllowlistPatch) {
    await ensureTenantPermission({
      actorUserId,
      tenantId: normalizedTenantId,
      permissionKey: PERMISSION_TENANT_INVITE_ACCESS_MANAGE,
      errorCode: "tenant_invite_access_forbidden",
    });
  }
  if (hasInvitePasswordHashPatch || hasInvitePasswordPolicyPatch) {
    await ensureTenantPermission({
      actorUserId,
      tenantId: normalizedTenantId,
      permissionKey: PERMISSION_TENANT_INVITE_PASSWORD_MANAGE,
      errorCode: "tenant_invite_password_forbidden",
    });
  }

  if (nextAccessPolicy) {
    await updateTenantAccessPolicy({
      tenantId: normalizedTenantId,
      accessPolicy: nextAccessPolicy,
    });
  }

  let currentAccessConfig = await ensureTenantAccessConfigRow({
    tenantId: normalizedTenantId,
    userId: actorUserId,
  });
  const mergedAccessConfigPatch = {
    ...(accessConfigPatch ?? {}),
    ...(inviteAccessPatch ?? {}),
  };

  if (Object.keys(mergedAccessConfigPatch).length > 0) {
    const nextInviteAccessState = resolveInviteAccessConfigState(
      currentAccessConfig,
      mergedAccessConfigPatch,
    );
    if (
      nextInviteAccessState.nextRequire &&
      !nextInviteAccessState.nextHash
    ) {
      throw new TenantServiceError(
        "Invite password is required when password enforcement is enabled",
        {
          status: 400,
          code: "invite_password_required_for_policy",
        },
      );
    }

    currentAccessConfig = await updateTenantAccessConfig({
      tenantId: normalizedTenantId,
      updatedBy: actorUserId,
      config: mergedAccessConfigPatch,
    });
  }

  clearCachedContext(actorUserId);
  return {
    tenantId: normalizedTenantId,
    accessPolicy: nextAccessPolicy ?? tenant.access_policy,
    accessConfig: toClientTenantAccessConfig(currentAccessConfig),
    inviteAccessConfig: toClientTenantInviteAccessConfig(currentAccessConfig),
  };
}

function normalizeInviteEmail(value) {
  if (value === undefined || value === null || value === "") return null;
  const email = requireNonEmptyText(value, "email", 320).toLowerCase();
  if (!email.includes("@")) {
    throw new TenantServiceError("email is invalid", {
      status: 400,
      code: "email_invalid",
    });
  }
  return email;
}

function normalizeUserEmail(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function normalizeInviteExpiryHours(value) {
  if (value === undefined || value === null || value === "") return 168;
  if (!Number.isInteger(value)) {
    throw new TenantServiceError("expires_in_hours must be an integer", {
      status: 400,
      code: "expires_in_hours_invalid",
    });
  }
  if (value < 1 || value > 24 * 30) {
    throw new TenantServiceError("expires_in_hours must be between 1 and 720", {
      status: 400,
      code: "expires_in_hours_out_of_range",
    });
  }
  return value;
}

export async function previewInvite(rawToken) {
  const token = requireNonEmptyText(rawToken, "invite_token", 512);
  const invite = await getPendingInviteForPreview(token);
  if (!invite) return null;
  const [tenant, role] = await Promise.all([
    invite.tenant_id ? getTenantById(invite.tenant_id) : null,
    invite.invited_role_id ? getRoleById(invite.invited_role_id) : null,
  ]);
  return {
    tenantName: tenant?.name ?? null,
    roleKey: role?.key ?? invite.role ?? ROLE_MEMBER_KEY,
    expiresAt: invite.expires_at ?? null,
  };
}

export async function createTenantInvite({
  actorUserId,
  tenantId,
  roleKey,
  inviteEmail,
  expiresInHours,
}) {
  const normalizedTenantId = requireTenantId(tenantId);
  const tenant = await ensureTenantExists(normalizedTenantId);
  await ensureTenantPermission({
    actorUserId,
    tenantId: normalizedTenantId,
    permissionKey: PERMISSION_TENANT_INVITE_CREATE,
    errorCode: "tenant_invite_forbidden",
  });

  const normalizedInviteEmail = normalizeInviteEmail(inviteEmail);
  const inviteType = normalizedInviteEmail ? "personalized" : "shared";
  const requestedRoleKey = normalizeInvitableRoleKey(roleKey ?? ROLE_MEMBER_KEY);
  const effectiveRoleKey =
    inviteType === "shared" ? ROLE_MEMBER_KEY : requestedRoleKey;
  const role = await requireRole(effectiveRoleKey);
  const validForHours = normalizeInviteExpiryHours(expiresInHours);
  const inviteToken = randomBytes(24).toString("base64url");
  const expiresAt = new Date(
    Date.now() + validForHours * 60 * 60 * 1000,
  ).toISOString();

  await createInvite({
    tenantId: normalizedTenantId,
    invitedRoleId: role.id,
    inviteEmail: normalizedInviteEmail,
    expiresAt,
    invitedBy: actorUserId,
    rawToken: inviteToken,
    inviteType,
  });
  observeInviteCreated();

  const inviteUrl = buildTenantInviteLink(inviteToken);
  const delivery = await sendTenantInviteEmail({
    email: normalizedInviteEmail,
    tenantName: tenant.name,
    roleKey: role.key,
    inviteUrl,
    inviteToken,
    expiresAt,
  });

  if (delivery.attempted) observeInviteEmailAttempted();
  if (delivery.sent) observeInviteEmailSent();
  if (normalizedInviteEmail && !delivery.sent) {
    observeInviteEmailFailed(delivery.errorCode ?? "unknown");
  }

  return {
    tenantId: normalizedTenantId,
    inviteToken,
    inviteUrl,
    inviteType,
    roleKey: role.key,
    inviteEmail: normalizedInviteEmail,
    expiresAt,
    delivery,
  };
}

export async function updateTenantMemberRole({
  actorUserId,
  tenantId,
  targetUserId,
  roleKey,
}) {
  const normalizedTenantId = requireTenantId(tenantId);
  const normalizedTargetUserId = requireUserId(targetUserId, "target_user_id");
  await ensureMemberManagementAccess({
    actorUserId,
    tenantId: normalizedTenantId,
  });

  const nextRole = await requireRole(roleKey);
  const actorMembership = await getActiveActorMembershipOrThrow({
    tenantId: normalizedTenantId,
    actorUserId,
  });
  const membership = await getActiveMembershipOrThrow({
    tenantId: normalizedTenantId,
    targetUserId: normalizedTargetUserId,
  });
  ensureActorCanManageTargetRole({
    actorRoleKey: actorMembership.role,
    targetRoleKey: membership.role,
    nextRoleKey: nextRole.key,
  });

  if (membership.role_id !== nextRole.id) {
    await assertNotLastOwnerDemotion({
      tenantId: normalizedTenantId,
      membership,
      nextRoleId: nextRole.id,
    });
    await updateMembershipRole({
      membershipId: membership.id,
      roleId: nextRole.id,
    });
  }

  clearMembershipContexts(actorUserId, normalizedTargetUserId);

  return {
    tenantId: normalizedTenantId,
    userId: normalizedTargetUserId,
    roleKey: nextRole.key,
  };
}

export async function removeTenantMember({
  actorUserId,
  tenantId,
  targetUserId,
}) {
  const normalizedTenantId = requireTenantId(tenantId);
  const normalizedTargetUserId = requireUserId(targetUserId, "target_user_id");
  await ensureMemberManagementAccess({
    actorUserId,
    tenantId: normalizedTenantId,
  });

  const actorMembership = await getActiveActorMembershipOrThrow({
    tenantId: normalizedTenantId,
    actorUserId,
  });
  const membership = await getActiveMembershipOrThrow({
    tenantId: normalizedTenantId,
    targetUserId: normalizedTargetUserId,
  });
  ensureActorCanManageTargetRole({
    actorRoleKey: actorMembership.role,
    targetRoleKey: membership.role,
    nextRoleKey: null,
  });

  await assertNotLastOwnerDemotion({
    tenantId: normalizedTenantId,
    membership,
    nextRoleId: null,
  });

  await updateMembershipStatus({
    membershipId: membership.id,
    status: "disabled",
  });

  clearMembershipContexts(actorUserId, normalizedTargetUserId);

  return {
    tenantId: normalizedTenantId,
    userId: normalizedTargetUserId,
    status: "disabled",
  };
}

export async function grantSelfAdminForDev({ userId }) {
  if (!isDevAdminToolEnabled()) {
    throw new TenantServiceError("Dev admin tool is disabled", {
      status: 404,
      code: "dev_tool_disabled",
    });
  }

  const adminRoleId = await requireRoleId(ROLE_ADMIN_KEY);
  const memberRoleId = await requireRoleId(ROLE_MEMBER_KEY);
  const existingMembership = await getActiveMembershipByUserId(userId);

  if (!existingMembership) {
    return createTenantDuringOnboarding({
      userId,
      tenantName: `Dev Tenant ${String(userId).slice(0, 8)}`,
    });
  }

  const membership = await getActiveMembershipForTenantUser({
    tenantId: existingMembership.tenant_id,
    userId,
  });
  if (!membership?.id) {
    throw new TenantServiceError("Active membership not found", {
      status: 404,
      code: "membership_not_found",
      details: { userId, tenantId: existingMembership.tenant_id },
    });
  }

  const nextRoleId =
    membership.role_id === adminRoleId ? memberRoleId : adminRoleId;

  await updateMembershipRole({
    membershipId: membership.id,
    roleId: nextRoleId,
  });
  clearCachedContext(userId);
  return resolveTenantContext(userId);
}

export async function createTenantDuringOnboarding({ userId, tenantName }) {
  const normalizedTenantName = requireNonEmptyText(
    tenantName,
    "tenant_name",
    120,
  );

  const existingMembership = await getActiveMembershipByUserId(userId);
  if (existingMembership) {
    return resolveTenantContext(userId);
  }

  const tenant = await createTenant({
    name: normalizedTenantName,
    createdBy: userId,
    accessPolicy: "public",
  });

  await createMembership({
    tenantId: tenant.id,
    userId,
    roleId: await requireRoleId(ROLE_OWNER_KEY),
    status: "active",
  });

  await createTenantAccessConfig({
    tenantId: tenant.id,
    updatedBy: userId,
  });

  await ensureInteriorWorldForTenant(tenant);
  // Membership/world changed; invalidate stale context before returning updated state.
  clearCachedContext(userId);
  return resolveTenantContext(userId);
}

export async function joinTenantFromInvite({
  userId,
  userEmail,
  inviteToken,
  invitePassword,
}) {
  const token = requireNonEmptyText(inviteToken, "invite_token", 512);
  const invite = await getPendingInviteByToken(token);

  if (!invite) {
    throw new TenantServiceError("Invite is invalid or expired", {
      status: 400,
      code: "invite_invalid_or_expired",
    });
  }

  const inviteEmail = normalizeUserEmail(invite.email_optional);
  const normalizedUserEmail = normalizeUserEmail(userEmail);
  if (inviteEmail) {
    if (!normalizedUserEmail || normalizedUserEmail !== inviteEmail) {
      throw new TenantServiceError("Invite is restricted to a different email", {
        status: 403,
        code: "invite_email_mismatch",
      });
    }
  }

  if (invite.invite_type === "shared") {
    const inviteAccessConfig = await getTenantAccessConfig(invite.tenant_id);
    const allowlistEmails = normalizeStoredInviteStringArray(
      inviteAccessConfig?.invite_allowlist_emails,
      normalizeInviteAccessEmail,
    );
    const allowlistDomains = normalizeStoredInviteStringArray(
      inviteAccessConfig?.invite_allowlist_domains,
      normalizeInviteAccessDomain,
    );
    const isWhitelisted = isUserWhitelistedForInvite({
      normalizedUserEmail,
      allowlistEmails,
      allowlistDomains,
    });
    const requiresPassword =
      !!inviteAccessConfig?.invite_require_password_for_unlisted &&
      !isWhitelisted;

    if (requiresPassword) {
      const storedHash = inviteAccessConfig?.invite_password_hash ?? null;
      if (!storedHash) {
        throw new TenantServiceError(
          "Invite password policy is misconfigured",
          {
            status: 403,
            code: "invite_password_not_configured",
          },
        );
      }

      const normalizedInvitePassword =
        typeof invitePassword === "string" ? invitePassword : "";
      if (!normalizedInvitePassword) {
        throw new TenantServiceError(
          "Invite password is required for this email domain",
          {
            status: 403,
            code: "invite_password_required",
          },
        );
      }

      if (!verifyInviteJoinPassword(normalizedInvitePassword, storedHash)) {
        throw new TenantServiceError("Invite password is incorrect", {
          status: 403,
          code: "invite_password_invalid",
        });
      }
    }
  }

  const existingMembership = await getActiveMembershipByUserId(userId);
  if (existingMembership && existingMembership.tenant_id !== invite.tenant_id) {
    throw new TenantServiceError(
      "User already belongs to a different home tenant",
      {
        status: 409,
        code: "already_has_home_tenant",
        details: {
          existingTenantId: existingMembership.tenant_id,
          inviteTenantId: invite.tenant_id,
        },
      },
    );
  }

  if (!existingMembership) {
    const invitedRole = invite.invited_role_id
      ? await getRoleById(invite.invited_role_id)
      : null;
    const roleId = invitedRole?.id
      ? invitedRole.id
      : await requireRoleId(ROLE_MEMBER_KEY);

    await createMembership({
      tenantId: invite.tenant_id,
      userId,
      roleId,
      status: "active",
    });
  }

  if (invite.invite_type === "personalized") {
    await redeemInvite({ inviteId: invite.id, userId });
  }
  // Invite redemption can change membership context.
  clearCachedContext(userId);
  return resolveTenantContext(userId);
}
