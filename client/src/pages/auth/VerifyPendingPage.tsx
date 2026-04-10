import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { buildPathWithNext, clearPendingNextPath, readNextPathFromSearch, readPendingNextPath } from '../../utils/nextPath'

const RESEND_COOLDOWN = 60 // seconds

/** Post-signup holding page for email verification + resend flow. */
export default function VerifyPendingPage() {
  const { isAuthenticated, resendVerification, user } = useAuth()
  const navigate  = useNavigate()
  const location  = useLocation()
  const nextPath = readNextPathFromSearch(location.search, readPendingNextPath('/game'))

  // Email from signup navigation state, or from the user object if session exists
  const email = (location.state as { email?: string } | null)?.email ?? user?.email ?? ''

  const [cooldown, setCooldown]   = useState(0)
  const [message, setMessage]     = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)

  // Redirect as soon as auth state flips (user clicked link in another tab or same window)
  useEffect(() => {
    if (!isAuthenticated) return
    clearPendingNextPath()
    navigate(nextPath, { replace: true })
  }, [isAuthenticated, navigate, nextPath])

  // Count down the resend cooldown
  useEffect(() => {
    if (cooldown <= 0) return
    const timeoutId = setTimeout(() => setCooldown(prevCooldown => prevCooldown - 1), 1000)
    return () => clearTimeout(timeoutId)
  }, [cooldown])

  const handleResend = useCallback(async () => {
    if (!email || cooldown > 0 || isSending) return
    setMessage(null)
    setIsSending(true)
    const resendError = await resendVerification(email)
    setIsSending(false)
    if (resendError) {
      setMessage(resendError.message)
    } else {
      setMessage('Verification email sent.')
      setCooldown(RESEND_COOLDOWN)
    }
  }, [email, cooldown, isSending, resendVerification])

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Check your inbox</h1>
        <p style={styles.body}>
          We sent a verification link to <strong style={{ color: '#fff' }}>{email}</strong>.
          Click it to activate your account and enter Gather.
        </p>

        {message && <p style={styles.message}>{message}</p>}

        <button
          onClick={handleResend}
          disabled={cooldown > 0 || isSending || !email}
          style={styles.resendBtn}
        >
          {isSending
            ? 'Sending…'
            : cooldown > 0
              ? `Resend in ${cooldown}s`
              : 'Resend email'}
        </button>

        <p style={styles.footer}>
          Wrong email?{' '}
          <Link to={buildPathWithNext('/signup', nextPath)} style={styles.link}>Start over</Link>
        </p>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page:      { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#0a0a0a' },
  card:      { width: 380, padding: '2rem', background: '#161616', borderRadius: 12, display: 'flex', flexDirection: 'column', gap: '1rem' },
  title:     { margin: 0, color: '#fff', fontSize: '1.5rem', fontFamily: 'sans-serif' },
  body:      { margin: 0, color: '#aaa', fontFamily: 'sans-serif', fontSize: '0.9rem', lineHeight: 1.5 },
  message:   { margin: 0, color: '#86efac', fontFamily: 'sans-serif', fontSize: '0.82rem' },
  resendBtn: { padding: '0.65rem', borderRadius: 8, border: '1px solid #333', background: '#222', color: '#fff', cursor: 'pointer', fontFamily: 'sans-serif', fontSize: '0.9rem' },
  footer:    { textAlign: 'center', color: '#888', fontFamily: 'sans-serif', fontSize: '0.82rem', margin: 0 },
  link:      { color: '#4f6ef7', textDecoration: 'none' },
}
