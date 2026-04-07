import { TenantServiceError } from './errors.js'
import {
  createInteriorWorld,
  createMembership,
  createTenant,
  createMainPlazaWorldIfMissing,
  getActiveAdminMembershipForTenantUser,
  getActiveMembershipByUserId,
  getActiveMembershipForTenantUser,
  getContextByUserId,
  getInteriorWorldByTenantId,
  getPendingInviteByToken,
  getTenantById,
  getWorldById,
  redeemInvite,
} from './tenantRepository.js'

const parsedTenantContextTtlMs = Number.parseInt(process.env.TENANT_CONTEXT_TTL_MS ?? '60000', 10)
const TENANT_CONTEXT_TTL_MS = Number.isFinite(parsedTenantContextTtlMs)
  && parsedTenantContextTtlMs > 0
  ? parsedTenantContextTtlMs
  : 60000
// Small per-user TTL cache to avoid repeated DB reads during reconnect bursts.
const tenantContextCache = new Map()

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
  const world = await getWorldById(worldId)
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

export async function isTenantAdmin(userId, tenantId) {
  const membership = await getActiveAdminMembershipForTenantUser({ tenantId, userId })
  return !!membership
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
    role: 'admin',
    status: 'active',
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
    await createMembership({
      tenantId: invite.tenant_id,
      userId,
      role: invite.role,
      status: 'active',
    })
  }

  await redeemInvite({ inviteId: invite.id, userId })
  // Invite redemption can change membership context.
  clearCachedContext(userId)
  return resolveTenantContext(userId)
}
