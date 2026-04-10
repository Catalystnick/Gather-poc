import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { buildPathWithNext } from '../../utils/nextPath'

type Preview = { tenantName: string | null; roleKey: string; expiresAt: string | null }
type PreviewStatus = 'loading' | 'ready' | 'invalid'
type JoinStatus = 'idle' | 'joining' | 'done' | 'error'

async function fetchInvitePreview(inviteToken: string): Promise<Preview | null> {
  const res = await fetch(`/tenant/invites/preview?inviteToken=${encodeURIComponent(inviteToken)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error('Failed to load invite')
  return res.json()
}

async function postJoinInvite(accessToken: string, inviteToken: string): Promise<void> {
  const res = await fetch('/tenant/onboarding', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ mode: 'join_invite', inviteToken }),
  })
  if (!res.ok) {
    const payload = await res.json().catch(() => null)
    throw new Error(typeof payload?.message === 'string' ? payload.message : 'Failed to join organization')
  }
}

/** Public invite acceptance page — no auth required to view, auto-joins once authenticated. */
export default function InviteAcceptPage() {
  const { isAuthenticated, isLoading: authLoading, session, signInWithGoogle } = useAuth()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  const inviteToken = searchParams.get('inviteToken')?.trim() ?? ''
  const selfPath = inviteToken ? `/invite/accept?inviteToken=${encodeURIComponent(inviteToken)}` : '/invite/accept'

  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>('loading')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [joinStatus, setJoinStatus] = useState<JoinStatus>('idle')
  const [joinError, setJoinError] = useState<string | null>(null)
  const joinAttemptedRef = useRef(false)

  // Load public invite preview (no auth needed).
  useEffect(() => {
    if (!inviteToken) {
      setPreviewStatus('invalid')
      return
    }
    let cancelled = false
    fetchInvitePreview(inviteToken)
      .then(data => {
        if (cancelled) return
        if (!data) { setPreviewStatus('invalid'); return }
        setPreview(data)
        setPreviewStatus('ready')
      })
      .catch(() => { if (!cancelled) setPreviewStatus('invalid') })
    return () => { cancelled = true }
  }, [inviteToken])

  // Auto-join once the user is authenticated and the preview confirmed valid.
  useEffect(() => {
    if (authLoading || !isAuthenticated || previewStatus !== 'ready' || joinAttemptedRef.current) return
    const accessToken = session?.access_token ?? ''
    if (!accessToken) return

    joinAttemptedRef.current = true
    setJoinStatus('joining')

    postJoinInvite(accessToken, inviteToken)
      .then(() => {
        setJoinStatus('done')
        navigate('/dashboard', { replace: true })
      })
      .catch(err => {
        setJoinError(err instanceof Error ? err.message : 'Failed to join organization')
        setJoinStatus('error')
      })
  }, [authLoading, isAuthenticated, previewStatus, session, inviteToken, navigate])

  const orgLabel = preview?.tenantName ?? 'an organization'
  const roleLabel = preview?.roleKey === 'admin' ? 'Admin' : 'Member'

  // While auth state is resolving, show nothing to avoid flashing the sign-in UI.
  if (authLoading) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <p style={styles.muted}>Loading…</p>
        </div>
      </div>
    )
  }

  if (previewStatus === 'loading') {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <p style={styles.muted}>Checking invite…</p>
        </div>
      </div>
    )
  }

  if (previewStatus === 'invalid') {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.title}>Invalid Invite</h1>
          <p style={styles.muted}>This invite link is invalid or has expired.</p>
          <p style={styles.footer}>
            <Link to="/login" style={styles.link}>Go to sign in</Link>
          </p>
        </div>
      </div>
    )
  }

  if (joinStatus === 'joining' || joinStatus === 'done') {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <p style={styles.muted}>Joining {orgLabel}…</p>
        </div>
      </div>
    )
  }

  if (joinStatus === 'error') {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.title}>Could not join</h1>
          <p style={styles.error}>{joinError}</p>
          <div style={styles.authLinks}>
            <button
              style={styles.googleBtn}
              onClick={() => { joinAttemptedRef.current = false; setJoinStatus('idle'); setJoinError(null) }}
            >
              Try again
            </button>
            <Link to="/dashboard" style={styles.link}>Go to dashboard</Link>
          </div>
        </div>
      </div>
    )
  }

  // Authenticated but join hasn't started yet (brief state before the effect fires).
  if (isAuthenticated) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <p style={styles.muted}>Joining {orgLabel}…</p>
        </div>
      </div>
    )
  }

  // Not authenticated — show invite details and auth options.
  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>You're invited</h1>
        <p style={styles.body}>
          Join <strong style={styles.orgName}>{orgLabel}</strong> as a <strong>{roleLabel}</strong>.
        </p>
        <p style={styles.muted}>Sign in or create an account to accept.</p>

        <button style={styles.googleBtn} onClick={() => signInWithGoogle(selfPath)}>
          Continue with Google
        </button>

        <div style={styles.divider}><span>or</span></div>

        <div style={styles.authLinks}>
          <Link to={buildPathWithNext('/signup', selfPath)} style={styles.primaryLink}>
            Create an account
          </Link>
          <Link to={buildPathWithNext('/login', selfPath)} style={styles.link}>
            Sign in
          </Link>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page:        { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#0a0a0a' },
  card:        { width: 360, padding: '2rem', background: '#161616', borderRadius: 12, display: 'flex', flexDirection: 'column', gap: '1rem' },
  title:       { margin: 0, color: '#fff', fontSize: '1.4rem', fontFamily: 'sans-serif' },
  body:        { margin: 0, color: '#d1d5db', fontFamily: 'sans-serif', fontSize: '0.95rem' },
  orgName:     { color: '#fff' },
  muted:       { margin: 0, color: '#888', fontFamily: 'sans-serif', fontSize: '0.9rem' },
  error:       { margin: 0, color: '#f87171', fontFamily: 'sans-serif', fontSize: '0.88rem' },
  googleBtn:   { padding: '0.65rem', borderRadius: 8, border: '1px solid #333', background: '#222', color: '#fff', cursor: 'pointer', fontFamily: 'sans-serif', fontSize: '0.9rem' },
  divider:     { textAlign: 'center', color: '#555', fontFamily: 'sans-serif', fontSize: '0.8rem' },
  authLinks:   { display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'center' },
  primaryLink: { padding: '0.6rem 1.2rem', borderRadius: 8, background: '#4f6ef7', color: '#fff', textDecoration: 'none', fontFamily: 'sans-serif', fontSize: '0.9rem' },
  link:        { color: '#4f6ef7', fontFamily: 'sans-serif', fontSize: '0.88rem', textDecoration: 'none' },
  footer:      { margin: 0, textAlign: 'center', color: '#888', fontFamily: 'sans-serif', fontSize: '0.82rem' },
}
