import nodemailer from 'nodemailer'

const SMTP_PROVIDER = 'smtp'

function toDeliveryResult({ attempted, sent, errorCode = null }) {
  return {
    attempted,
    sent,
    provider: SMTP_PROVIDER,
    errorCode,
  }
}

function getSmtpPort(raw) {
  const parsed = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(parsed)) return 587
  if (parsed < 1 || parsed > 65535) return 587
  return parsed
}

function getSmtpSecure({ port, value }) {
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.trim().toLowerCase()
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
  }
  // Gmail: 465 => SSL/TLS; 587 => STARTTLS.
  return port === 465
}

function getSmtpConfig() {
  const host = typeof process.env.SMTP_HOST === 'string'
    ? process.env.SMTP_HOST.trim()
    : ''
  const port = getSmtpPort(process.env.SMTP_PORT)
  const secure = getSmtpSecure({ port, value: process.env.SMTP_SECURE })
  const user = typeof process.env.SMTP_USER === 'string'
    ? process.env.SMTP_USER.trim()
    : ''
  const pass = typeof process.env.SMTP_PASS === 'string'
    ? process.env.SMTP_PASS.trim()
    : ''
  const fromEmail = typeof process.env.INVITE_FROM_EMAIL === 'string'
    ? process.env.INVITE_FROM_EMAIL.trim()
    : ''
  return {
    host,
    port,
    secure,
    user,
    pass,
    fromEmail,
  }
}

function resolveInviteBaseUrl() {
  const configured = typeof process.env.TENANT_INVITE_ACCEPT_URL === 'string'
    ? process.env.TENANT_INVITE_ACCEPT_URL.trim()
    : ''
  if (configured) return configured

  if (String(process.env.NODE_ENV ?? '').trim().toLowerCase() !== 'production') {
    return 'http://localhost:5173/invite/accept'
  }

  return null
}

function buildInviteUrl(baseUrl, inviteToken) {
  if (!baseUrl) return null
  try {
    const url = new URL(baseUrl)
    url.searchParams.set('inviteToken', inviteToken)
    return url.toString()
  } catch {
    return null
  }
}

function readSmtpErrorCode(error) {
  if (!error) return 'smtp_unknown_error'
  if (typeof error?.code === 'string' && error.code.trim()) {
    return `smtp_${error.code.trim().toLowerCase()}`
  }
  if (typeof error?.responseCode === 'number') {
    return `smtp_response_${error.responseCode}`
  }
  return 'smtp_unknown_error'
}

function buildInviteEmailText({ tenantName, roleKey, inviteUrl, inviteToken, expiresAt }) {
  const lines = [
    `You were invited to join ${tenantName}.`,
    `Role: ${roleKey}`,
    `Expires at: ${expiresAt}`,
  ]

  if (inviteUrl) {
    lines.push('Open this invite link to join:')
    lines.push(inviteUrl)
  } else {
    lines.push('Use this invite token on the dashboard:')
    lines.push(inviteToken)
  }

  return lines.join('\n')
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

// Build a safe HTML invite body so email clients can render links/tokens without risking HTML injection.
function buildInviteEmailHtml({ tenantName, roleKey, inviteUrl, inviteToken, expiresAt }) {
  const safeTenantName = escapeHtml(tenantName)
  const safeRoleKey = escapeHtml(roleKey)
  const safeExpiresAt = escapeHtml(expiresAt)

  if (inviteUrl) {
    const safeInviteUrl = escapeHtml(inviteUrl)
    return [
      `<p>You were invited to join <strong>${safeTenantName}</strong>.</p>`,
      `<p>Role: <strong>${safeRoleKey}</strong></p>`,
      `<p>Expires at: <strong>${safeExpiresAt}</strong></p>`,
      `<p>Open this invite link to join: <a href="${safeInviteUrl}">${safeInviteUrl}</a></p>`,
    ].join('')
  }

  const safeInviteToken = escapeHtml(inviteToken)
  return [
    `<p>You were invited to join <strong>${safeTenantName}</strong>.</p>`,
    `<p>Role: <strong>${safeRoleKey}</strong></p>`,
    `<p>Expires at: <strong>${safeExpiresAt}</strong></p>`,
    `<p>Use this invite token on the dashboard: <strong>${safeInviteToken}</strong></p>`,
  ].join('')
}

export function buildTenantInviteLink(inviteToken) {
  return buildInviteUrl(resolveInviteBaseUrl(), inviteToken)
}

export async function sendTenantInviteEmail({
  email,
  tenantName,
  roleKey,
  inviteUrl,
  inviteToken,
  expiresAt,
}) {
  if (!email) {
    return toDeliveryResult({ attempted: false, sent: false })
  }

  const {
    host,
    port,
    secure,
    user,
    pass,
    fromEmail,
  } = getSmtpConfig()

  if (!host || !user || !pass) {
    return toDeliveryResult({
      attempted: false,
      sent: false,
      errorCode: 'email_provider_not_configured',
    })
  }

  const from = fromEmail || user
  const text = buildInviteEmailText({
    tenantName,
    roleKey,
    inviteUrl,
    inviteToken,
    expiresAt,
  })
  const html = buildInviteEmailHtml({
    tenantName,
    roleKey,
    inviteUrl,
    inviteToken,
    expiresAt,
  })

  try {
    const transport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user,
        pass,
      },
    })

    await transport.sendMail({
      from,
      to: email,
      subject: `You're invited to join ${tenantName}`,
      text,
      html,
    })

    return toDeliveryResult({ attempted: true, sent: true })
  } catch (error) {
    const errorCode = readSmtpErrorCode(error)
    return toDeliveryResult({
      attempted: true,
      sent: false,
      errorCode,
    })
  }
}
