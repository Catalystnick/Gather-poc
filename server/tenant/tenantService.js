import { TenantServiceError } from './errors.js'
import { toClientTenantAccessConfig } from './accessConfigMapper.js'
import {
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
  getRoleById,
  getRoleByKey,
  getTenantAccessConfig,
  getTenantById,
  getWorldByKey as getWorldByKeyFromRepository,
  getWorldById as getWorldByIdFromRepository,
  listPermissionKeysByRoleId,
  redeemInvite,
  updateTenantAccessConfig,
  updateTenantAccessPolicy,
} from './tenantRepository.js'

const parsedTenantContextTtlMs = Number.parseInt(process.env.TENANT_CONTEXT_TTL_MS ?? '60000', 10)
const TENANT_CONTEXT_TTL_MS = Number.isFinite(parsedTenantContextTtlMs)
  && parsedTenantContextTtlMs > 0
  ? parsedTenantContextTtlMs
  : 60000
// Small per-user TTL cache to avoid repeated DB reads during reconnect bursts.
const tenantContextCache = new Map()
const TENANT_ACCESS_POLICY_VALUES = new Set(['public', 'private'])
const TENANT_ACCESS_CONFIG_FIELDS = {
  guestZoneEnforced: 'guest_zone_enforced',
  guestCanChat: 'guest_can_chat',
  guestCanTag: 'guest_can_tag',
  guestCanTeleport: 'guest_can_teleport',
  memberCanTag: 'member_can_tag',
  memberCanTeleport: 'member_can_teleport',
}

function getCachedContext(userId) {
  const entry = tenantContextCache.get(userId)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    tenantContextCache.delete(userId)
    return null
  }
  return entry.context
}

function setCachedContext(userId, context) {
  tenantContextCache.set(userId, {
    context,
    expiresAt: Date.now() + TENANT_CONTEXT_TTL_MS,
  })
}

function clearCachedContext(userId) {
  tenantContextCache.delete(userId)
}

function requireTenantId(value) {
  return requireNonEmptyText(value, 'tenant_id', 120)
}

function normalizeAccessPolicy(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!normalized) return null
  if (!TENANT_ACCESS_POLICY_VALUES.has(normalized)) {
    throw new TenantServiceError('Invalid access policy', {
      status: 400,
      code: 'access_policy_invalid',
      details: { allowed: [...TENANT_ACCESS_POLICY_VALUES] },
    })
  }
  return normalized
}

function normalizeAccessConfigPatch(rawConfig) {
  if (rawConfig === undefined) return null
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new TenantServiceError('tenant_access_config must be an object', {
      status: 400,
      code: 'tenant_access_config_invalid',
    })
  }

  const patch = {}
  for (const [clientField, dbField] of Object.entries(TENANT_ACCESS_CONFIG_FIELDS)) {
    if (!(clientField in rawConfig)) continue
    if (typeof rawConfig[clientField] !== 'boolean') {
      throw new TenantServiceError(`${clientField} must be boolean`, {
        status: 400,
        code: 'tenant_access_config_invalid',
        details: { field: clientField },
      })
    }
    patch[dbField] = rawConfig[clientField]
  }

  if (!Object.keys(patch).length) {
    throw new TenantServiceError('tenant_access_config has no supported fields', {
      status: 400,
      code: 'tenant_access_config_empty',
      details: { supportedFields: Object.keys(TENANT_ACCESS_CONFIG_FIELDS) },
    })
  }

  return patch
}

function requireNonEmptyText(value, fieldName, maxLen = 128) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) {
    throw new TenantServiceError(`${fieldName} is required`, {
      status: 400,
      code: `${fieldName}_required`,
    })
  }
  if (text.length > maxLen) {
    throw new TenantServiceError(`${fieldName} is too long`, {
      status: 400,
      code: `${fieldName}_too_long`,
    })
  }
  return text
}

async function requireRoleId(roleKey) {
  const role = await getRoleByKey(roleKey)
  if (role?.id) return role.id

  throw new TenantServiceError('Required role is not configured', {
    status: 500,
    code: 'role_seed_missing',
    details: { roleKey },
  })
}

async function ensureInteriorWorldForTenant(tenant) {
  const existing = await getInteriorWorldByTenantId(tenant.id)
  if (existing) return existing

  // Interior world is created lazily so old tenants can self-heal on first access.
  return createInteriorWorld({
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    tenantName: tenant.name,
  })
}

async function ensureContextHasInteriorWorld(context) {
  if (!context?.hasMembership) return context
  if (context.homeInteriorWorldId) return context

  const tenant = await getTenantById(context.homeTenantId)
  if (!tenant) {
    throw new TenantServiceError('Home tenant not found for active membership', {
      status: 500,
      code: 'home_tenant_missing',
      details: { tenantId: context.homeTenantId },
    })
  }
  await ensureInteriorWorldForTenant(tenant)
  return getContextByUserId(context.userId)
}

export async function resolveTenantContext(userId) {
  const cached = getCachedContext(userId)
  if (cached) return cached

  const context = await getContextByUserId(userId)
  const next = await ensureContextHasInteriorWorld(context)
  setCachedContext(userId, next)
  return next
}

export async function resolveMainPlazaWorld() {
  return createMainPlazaWorldIfMissing()
}

export async function resolveTenantInteriorWorld(tenantId) {
  const tenant = await getTenantById(tenantId)
  if (!tenant) {
    throw new TenantServiceError('Tenant not found', {
      status: 404,
      code: 'tenant_not_found',
      details: { tenantId },
    })
  }
  return ensureInteriorWorldForTenant(tenant)
}

export async function canAccessWorld(userId, worldId) {
  const world = await getWorldByIdFromRepository(worldId)
  if (!world || world.is_active === false) return false
  if (world.world_type === 'main_plaza') return true
  if (world.world_type !== 'tenant_interior' || !world.tenant_id) return false

  const tenant = await getTenantById(world.tenant_id)
  if (!tenant) return false
  // Public interiors allow visitors; private interiors require active membership.
  if (tenant.access_policy === 'public') return true

  const membership = await getActiveMembershipForTenantUser({
    tenantId: world.tenant_id,
    userId,
  })
  return !!membership
}

export async function getWorldById(worldId) {
  return getWorldByIdFromRepository(worldId)
}

export async function getWorldByKey(worldKey) {
  return getWorldByKeyFromRepository(worldKey)
}

export async function isTenantAdmin(userId, tenantId) {
  const membership = await getActiveMembershipForTenantUser({ tenantId, userId })
  if (!membership?.role_id) return false

  const permissionKeys = await listPermissionKeysByRoleId(membership.role_id)
  return permissionKeys.includes('tenant.members.manage')
}

export async function hasTenantPermission(userId, tenantId, permissionKey) {
  const membership = await getActiveMembershipForTenantUser({ tenantId, userId })
  if (!membership?.role_id) return false

  const permissionKeys = await listPermissionKeysByRoleId(membership.role_id)
  return permissionKeys.includes(permissionKey)
}

async function ensureTenantAccessConfigRow({ tenantId, userId }) {
  const existing = await getTenantAccessConfig(tenantId)
  if (existing) return existing
  return createTenantAccessConfig({
    tenantId,
    updatedBy: userId,
  })
}

export async function updateTenantSettings({ actorUserId, tenantId, accessPolicy, tenantAccessConfig }) {
  const normalizedTenantId = requireTenantId(tenantId)
  const nextAccessPolicy = normalizeAccessPolicy(accessPolicy)
  const accessConfigPatch = normalizeAccessConfigPatch(tenantAccessConfig)

  if (!nextAccessPolicy && !accessConfigPatch) {
    throw new TenantServiceError('No settings provided', {
      status: 400,
      code: 'settings_empty',
    })
  }

  const tenant = await getTenantById(normalizedTenantId)
  if (!tenant) {
    throw new TenantServiceError('Tenant not found', {
      status: 404,
      code: 'tenant_not_found',
      details: { tenantId: normalizedTenantId },
    })
  }

  const allowed = await hasTenantPermission(
    actorUserId,
    normalizedTenantId,
    'tenant.settings.manage',
  )
  if (!allowed) {
    throw new TenantServiceError('Forbidden', {
      status: 403,
      code: 'tenant_settings_forbidden',
      details: { tenantId: normalizedTenantId },
    })
  }

  if (nextAccessPolicy) {
    await updateTenantAccessPolicy({
      tenantId: normalizedTenantId,
      accessPolicy: nextAccessPolicy,
    })
  }

  let currentAccessConfig = await ensureTenantAccessConfigRow({
    tenantId: normalizedTenantId,
    userId: actorUserId,
  })
  if (accessConfigPatch) {
    currentAccessConfig = await updateTenantAccessConfig({
      tenantId: normalizedTenantId,
      updatedBy: actorUserId,
      config: accessConfigPatch,
    })
  }

  clearCachedContext(actorUserId)
  return {
    tenantId: normalizedTenantId,
    accessPolicy: nextAccessPolicy ?? tenant.access_policy,
    accessConfig: toClientTenantAccessConfig(currentAccessConfig),
  }
}

export async function bootstrapCreateTenant({ userId, tenantName }) {
  const normalizedTenantName = requireNonEmptyText(tenantName, 'tenant_name', 120)

  const existingMembership = await getActiveMembershipByUserId(userId)
  if (existingMembership) {
    return resolveTenantContext(userId)
  }

  const tenant = await createTenant({
    name: normalizedTenantName,
    createdBy: userId,
    accessPolicy: 'public',
  })

  await createMembership({
    tenantId: tenant.id,
    userId,
    roleId: await requireRoleId('admin'),
    status: 'active',
  })

  await createTenantAccessConfig({
    tenantId: tenant.id,
    updatedBy: userId,
  })

  await ensureInteriorWorldForTenant(tenant)
  // Membership/world changed; invalidate stale context before returning updated state.
  clearCachedContext(userId)
  return resolveTenantContext(userId)
}

export async function bootstrapJoinInvite({ userId, inviteToken }) {
  const token = requireNonEmptyText(inviteToken, 'invite_token', 512)
  const invite = await getPendingInviteByToken(token)

  if (!invite) {
    throw new TenantServiceError('Invite is invalid or expired', {
      status: 400,
      code: 'invite_invalid_or_expired',
    })
  }

  const existingMembership = await getActiveMembershipByUserId(userId)
  if (existingMembership && existingMembership.tenant_id !== invite.tenant_id) {
    throw new TenantServiceError('User already belongs to a different home tenant', {
      status: 409,
      code: 'already_has_home_tenant',
      details: {
        existingTenantId: existingMembership.tenant_id,
        inviteTenantId: invite.tenant_id,
      },
    })
  }

  if (!existingMembership) {
    const invitedRole = invite.invited_role_id
      ? await getRoleById(invite.invited_role_id)
      : null
    const roleId = invitedRole?.id
      ? invitedRole.id
      : await requireRoleId('member')

    await createMembership({
      tenantId: invite.tenant_id,
      userId,
      roleId,
      status: 'active',
    })
  }

  await redeemInvite({ inviteId: invite.id, userId })
  // Invite redemption can change membership context.
  clearCachedContext(userId)
  return resolveTenantContext(userId)
}
