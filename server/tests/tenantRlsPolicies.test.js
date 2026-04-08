import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { supabaseRestRequest } from '../tenant/supabaseRest.js'

function hasRequiredEnv() {
  return !!(
    process.env.SUPABASE_URL
    && process.env.SUPABASE_SERVICE_ROLE_KEY
    && process.env.SUPABASE_ANON_KEY
    && process.env.TENANT_RLS_TEST_USER_TOKEN
  )
}

function decodeUserIdFromJwt(token) {
  const parts = String(token).split('.')
  if (parts.length < 2) throw new Error('Invalid TENANT_RLS_TEST_USER_TOKEN format')
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  if (!payload?.sub) throw new Error('TENANT_RLS_TEST_USER_TOKEN is missing sub claim')
  return payload.sub
}

function uniqueSuffix() {
  return `${Date.now()}${Math.floor(Math.random() * 10_000)}`
}

function buildRestUrl(path, query) {
  const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/${path}`)
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null) continue
    url.searchParams.set(key, String(value))
  }
  return url
}

function parseJsonSafely(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function userRestRequest({ path, query }) {
  const response = await fetch(buildRestUrl(path, query), {
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${process.env.TENANT_RLS_TEST_USER_TOKEN}`,
      Accept: 'application/json',
    },
  })
  const text = await response.text()
  const payload = parseJsonSafely(text)
  assert.equal(response.ok, true, `Expected 2xx for ${path}, got ${response.status} ${text}`)
  return payload
}

async function findMainPlazaWorldId() {
  const rows = await supabaseRestRequest({
    path: 'worlds',
    query: {
      select: 'id',
      world_type: 'eq.main_plaza',
      limit: 1,
    },
  })
  const first = Array.isArray(rows) ? rows[0] : null
  if (!first?.id) throw new Error('main_plaza world row is required for RLS test')
  return first.id
}

async function getRoleIdByKey(roleKey) {
  const rows = await supabaseRestRequest({
    path: 'roles',
    query: {
      select: 'id',
      key: `eq.${roleKey}`,
      limit: 1,
    },
  })
  const first = Array.isArray(rows) ? rows[0] : null
  if (!first?.id) throw new Error(`Role ${roleKey} is required for RLS test setup`)
  return first.id
}

async function ensureActiveMembershipTenantId(userId) {
  const rows = await supabaseRestRequest({
    path: 'tenant_memberships',
    query: {
      select: 'tenant_id',
      user_id: `eq.${userId}`,
      status: 'eq.active',
      limit: 1,
    },
  })
  const existing = Array.isArray(rows) ? rows[0] : null
  if (existing?.tenant_id) return existing.tenant_id

  const suffix = uniqueSuffix()
  const createdTenantRows = await supabaseRestRequest({
    path: 'tenants',
    method: 'POST',
    prefer: 'return=representation',
    body: {
      name: `RLS Tenant ${suffix}`,
      slug: `rls-tenant-${suffix}`,
      access_policy: 'private',
      created_by: userId,
    },
  })
  const tenant = Array.isArray(createdTenantRows) ? createdTenantRows[0] : null
  if (!tenant?.id) throw new Error('Failed to create tenant for RLS test setup')

  await supabaseRestRequest({
    path: 'tenant_memberships',
    method: 'POST',
    prefer: 'return=representation',
    body: {
      tenant_id: tenant.id,
      user_id: userId,
      role_id: await getRoleIdByKey('member'),
      status: 'active',
    },
  })
  return tenant.id
}

async function ensureInteriorWorldId(tenantId, keyPrefix) {
  const existingRows = await supabaseRestRequest({
    path: 'worlds',
    query: {
      select: 'id',
      tenant_id: `eq.${tenantId}`,
      world_type: 'eq.tenant_interior',
      limit: 1,
    },
  })
  const existing = Array.isArray(existingRows) ? existingRows[0] : null
  if (existing?.id) return existing.id

  const suffix = uniqueSuffix()
  const createdRows = await supabaseRestRequest({
    path: 'worlds',
    method: 'POST',
    prefer: 'return=representation',
    body: {
      tenant_id: tenantId,
      world_type: 'tenant_interior',
      key: `${keyPrefix}-${suffix}`,
      display_name: `Interior ${suffix}`,
      map_key: 'interior_default',
      is_active: true,
    },
  })
  const created = Array.isArray(createdRows) ? createdRows[0] : null
  if (!created?.id) throw new Error('Failed to create interior world for RLS test setup')
  return created.id
}

async function createForeignTenantAndWorld(userId) {
  const suffix = uniqueSuffix()
  const tenantRows = await supabaseRestRequest({
    path: 'tenants',
    method: 'POST',
    prefer: 'return=representation',
    body: {
      name: `RLS Foreign ${suffix}`,
      slug: `rls-foreign-${suffix}`,
      access_policy: 'private',
      created_by: userId,
    },
  })
  const tenant = Array.isArray(tenantRows) ? tenantRows[0] : null
  if (!tenant?.id) throw new Error('Failed to create foreign tenant for RLS test setup')

  const worldRows = await supabaseRestRequest({
    path: 'worlds',
    method: 'POST',
    prefer: 'return=representation',
    body: {
      tenant_id: tenant.id,
      world_type: 'tenant_interior',
      key: `rls-foreign-world-${suffix}`,
      display_name: `Foreign Interior ${suffix}`,
      map_key: 'interior_default',
      is_active: true,
    },
  })
  const world = Array.isArray(worldRows) ? worldRows[0] : null
  if (!world?.id) throw new Error('Failed to create foreign world for RLS test setup')
  return { foreignTenantId: tenant.id, foreignWorldId: world.id }
}

async function seedForeignInvite({ foreignTenantId, userId }) {
  const suffix = uniqueSuffix()
  await supabaseRestRequest({
    path: 'tenant_invites',
    method: 'POST',
    prefer: 'return=representation',
    body: {
      tenant_id: foreignTenantId,
      token_hash: createHash('sha256').update(`rls-invite-${suffix}`).digest('hex'),
      invited_role_id: await getRoleIdByKey('member'),
      email_optional: null,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      status: 'pending',
      invited_by: userId,
    },
  })
}

test('RLS limits authenticated users to allowed tenant rows', { skip: !hasRequiredEnv() }, async () => {
  const userToken = process.env.TENANT_RLS_TEST_USER_TOKEN
  const userId = decodeUserIdFromJwt(userToken)

  const mainPlazaWorldId = await findMainPlazaWorldId()
  const ownTenantId = await ensureActiveMembershipTenantId(userId)
  const ownWorldId = await ensureInteriorWorldId(ownTenantId, 'rls-own-world')
  const { foreignTenantId, foreignWorldId } = await createForeignTenantAndWorld(userId)
  await seedForeignInvite({ foreignTenantId, userId })

  const visibleTenants = await userRestRequest({
    path: 'tenants',
    query: {
      select: 'id',
      id: `in.(${ownTenantId},${foreignTenantId})`,
    },
  })
  const visibleTenantIds = new Set((visibleTenants || []).map(row => row.id))
  assert.equal(visibleTenantIds.has(ownTenantId), true)
  assert.equal(visibleTenantIds.has(foreignTenantId), false)

  const visibleWorlds = await userRestRequest({
    path: 'worlds',
    query: {
      select: 'id',
      id: `in.(${mainPlazaWorldId},${ownWorldId},${foreignWorldId})`,
    },
  })
  const visibleWorldIds = new Set((visibleWorlds || []).map(row => row.id))
  assert.equal(visibleWorldIds.has(mainPlazaWorldId), true)
  assert.equal(visibleWorldIds.has(ownWorldId), true)
  assert.equal(visibleWorldIds.has(foreignWorldId), false)

  const visibleInvites = await userRestRequest({
    path: 'tenant_invites',
    query: {
      select: 'id',
      tenant_id: `eq.${foreignTenantId}`,
    },
  })
  assert.equal((visibleInvites || []).length, 0)
})
