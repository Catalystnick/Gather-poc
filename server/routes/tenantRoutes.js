import express from 'express'
import rateLimit from 'express-rate-limit'
import { requireAuth } from '../middleware/requireAuth.js'
import { TenantServiceError } from '../tenant/errors.js'
import {
  createTenantDuringOnboarding,
  createTenantInvite,
  grantSelfAdminForDev,
  joinTenantFromInvite,
  listTenantMembers,
  previewInvite,
  removeTenantMember,
  resolveTenantContext,
  updateTenantMemberRole,
  updateTenantSettings,
} from '../tenant/tenantService.js'

// Separate limiter for the unauthenticated preview endpoint — stricter than authenticated routes.
const invitePreviewLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Too many requests, please try again later.' },
})

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


// Public — no auth required. Returns just enough for the invite acceptance UI.
// Must be defined before /:tenantId routes to avoid param capture.
tenantRouter.get('/invites/preview', invitePreviewLimiter, async (req, res) => {
  const inviteToken = typeof req.query.inviteToken === 'string' ? req.query.inviteToken.trim() : ''
  if (!inviteToken) {
    return res.status(400).json({ error: 'invite_token_required', message: 'inviteToken query param is required' })
  }
  try {
    const preview = await previewInvite(inviteToken)
    if (!preview) {
      return res.status(404).json({ error: 'invite_not_found', message: 'Invite is invalid or expired' })
    }
    return res.json(preview)
  } catch (error) {
    return sendTenantError(res, error)
  }
})

async function handleTenantOnboarding(req, res) {
  const mode = req.body?.mode
  try {
    // Onboarding supports only the two tenant entry paths.
    if (mode === 'create_tenant') {
      const context = await createTenantDuringOnboarding({
        userId: req.user.sub,
        tenantName: req.body?.tenantName,
      })
      return res.json(context)
    }

    if (mode === 'join_invite') {
      const context = await joinTenantFromInvite({
        userId: req.user.sub,
        userEmail: req.user.email,
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
}

tenantRouter.post('/onboarding', requireAuth, handleTenantOnboarding)

tenantRouter.post('/dev/grant-admin-self', requireAuth, async (req, res) => {
  try {
    const context = await grantSelfAdminForDev({
      userId: req.user.sub,
    })
    return res.json(context)
  } catch (error) {
    return sendTenantError(res, error)
  }
})

tenantRouter.patch(
  '/:tenantId/settings',
  requireAuth,
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

tenantRouter.get(
  '/:tenantId/members',
  requireAuth,
  async (req, res) => {
    try {
      const members = await listTenantMembers({
        actorUserId: req.user.sub,
        tenantId: req.params.tenantId,
      })
      return res.json({ members })
    } catch (error) {
      return sendTenantError(res, error)
    }
  }
)

export default tenantRouter
