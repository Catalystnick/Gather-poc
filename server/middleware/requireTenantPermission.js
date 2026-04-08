import { hasTenantPermission } from '../tenant/tenantService.js'

export function requireTenantPermission(permissionKey, options = {}) {
  const tenantIdParam = options.tenantIdParam ?? 'tenantId'

  return async function tenantPermissionMiddleware(req, res, next) {
    const userId = req.user?.sub
    const tenantId = req.params?.[tenantIdParam]

    if (!userId) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Missing authenticated user context',
      })
    }
    if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) {
      return res.status(400).json({
        error: 'tenant_id_required',
        message: 'tenantId route parameter is required',
      })
    }

    try {
      const allowed = await hasTenantPermission(userId, tenantId.trim(), permissionKey)
      if (!allowed) {
        return res.status(403).json({
          error: 'forbidden',
          message: `Missing required permission: ${permissionKey}`,
        })
      }
      return next()
    } catch (error) {
      console.error('[tenant] permission middleware failed:', error)
      return res.status(500).json({
        error: 'internal_error',
        message: 'Unexpected tenant permission check failure',
      })
    }
  }
}
