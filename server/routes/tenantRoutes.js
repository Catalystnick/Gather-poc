import express from 'express'
import { requireAuth } from '../middleware/requireAuth.js'
import { requireTenantPermission } from '../middleware/requireTenantPermission.js'
import { TenantServiceError } from '../tenant/errors.js'
import {
  bootstrapCreateTenant,
  bootstrapJoinInvite,
  createTenantInvite,
  grantSelfAdminForDev,
  removeTenantMember,
  resolveTenantContext,
  updateTenantMemberRole,
  updateTenantSettings,
} from '../tenant/tenantService.js'

const tenantRouter = express.Router()

function sendTenantError(res, error) {
  if (error instanceof TenantServiceError) {
    // Known service errors are returned as-is for predictable client handling.
    return res.status(error.status).json({
      error: error.code,
      message: error.message,
      details: error.details ?? undefined,
    })
  }
  console.error('[tenant] unexpected error:', error)
  return res.status(500).json({
    error: 'internal_error',
    message: 'Unexpected tenant service failure',
  })
}

tenantRouter.get('/me', requireAuth, async (req, res) => {
  try {
    const context = await resolveTenantContext(req.user.sub)
    return res.json(context)
  } catch (error) {
    return sendTenantError(res, error)
  }
})

tenantRouter.post('/bootstrap', requireAuth, async (req, res) => {
  const mode = req.body?.mode
  try {
    // Bootstrap supports only the two onboarding entry paths.
    if (mode === 'create_tenant') {
      const context = await bootstrapCreateTenant({
        userId: req.user.sub,
        tenantName: req.body?.tenantName,
      })
      return res.json(context)
    }

    if (mode === 'join_invite') {
      const context = await bootstrapJoinInvite({
        userId: req.user.sub,
        inviteToken: req.body?.inviteToken,
      })
      return res.json(context)
    }

    return res.status(400).json({
      error: 'invalid_mode',
      message: 'mode must be create_tenant or join_invite',
    })
  } catch (error) {
    return sendTenantError(res, error)
  }
})

tenantRouter.post('/dev/grant-admin-self', requireAuth, async (req, res) => {
  try {
    const context = await grantSelfAdminForDev({
      userId: req.user.sub,
      tenantName: req.body?.tenantName,
    })
    return res.json(context)
  } catch (error) {
    return sendTenantError(res, error)
  }
})

tenantRouter.patch(
  '/:tenantId/settings',
  requireAuth,
  requireTenantPermission('tenant.settings.manage'),
  async (req, res) => {
  try {
    const settings = await updateTenantSettings({
      actorUserId: req.user.sub,
      tenantId: req.params.tenantId,
      accessPolicy: req.body?.accessPolicy,
      tenantAccessConfig: req.body?.tenantAccessConfig,
    })
    return res.json(settings)
  } catch (error) {
    return sendTenantError(res, error)
  }
})

tenantRouter.post(
  '/:tenantId/invites',
  requireAuth,
  requireTenantPermission('tenant.invite.create'),
  async (req, res) => {
    try {
      const invite = await createTenantInvite({
        actorUserId: req.user.sub,
        tenantId: req.params.tenantId,
        roleKey: req.body?.roleKey,
        emailOptional: req.body?.emailOptional,
        expiresInHours: req.body?.expiresInHours,
      })
      return res.status(201).json(invite)
    } catch (error) {
      return sendTenantError(res, error)
    }
  }
)

tenantRouter.patch(
  '/:tenantId/members/:userId/role',
  requireAuth,
  requireTenantPermission('tenant.members.manage'),
  async (req, res) => {
    try {
      const membership = await updateTenantMemberRole({
        actorUserId: req.user.sub,
        tenantId: req.params.tenantId,
        targetUserId: req.params.userId,
        roleKey: req.body?.roleKey,
      })
      return res.json(membership)
    } catch (error) {
      return sendTenantError(res, error)
    }
  }
)

tenantRouter.delete(
  '/:tenantId/members/:userId',
  requireAuth,
  requireTenantPermission('tenant.members.manage'),
  async (req, res) => {
    try {
      const membership = await removeTenantMember({
        actorUserId: req.user.sub,
        tenantId: req.params.tenantId,
        targetUserId: req.params.userId,
      })
      return res.json(membership)
    } catch (error) {
      return sendTenantError(res, error)
    }
  }
)

export default tenantRouter
