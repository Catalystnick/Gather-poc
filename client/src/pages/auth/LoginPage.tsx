import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { buildPathWithNext, clearPendingNextPath, readNextPathFromSearch, readPendingNextPath } from '../../utils/nextPath'

/** Email/password + Google sign-in entry page. */
export default function LoginPage() {
  const { signInWithPassword, signInWithGoogle, isAuthenticated, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const nextPath = readNextPathFromSearch(location.search, readPendingNextPath('/game'))

  const [email, setEmail]           = useState('')
  const [password, setPassword]     = useState('')
  const [error, setError]           = useState<string | null>(null)
  const [isSubmitting, setSubmitting] = useState(false)
  const [unverified, setUnverified] = useState(false)

  // Redirect if already authenticated (e.g. returning with an active session)
  useEffect(() => {
    if (!isAuthenticated) return
    clearPendingNextPath()
    navigate(nextPath, { replace: true })
  }, [isAuthenticated, navigate, nextPath])

  const handleEmailLogin = useCallback(async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setUnverified(false)
    setSubmitting(true)
    const signInError = await signInWithPassword(email, password)
    setSubmitting(false)
    if (signInError) {
      if (signInError.message.toLowerCase().includes('email not confirmed')) {
        setUnverified(true)
      } else {
        setError(signInError.message)
      }
    }
  }, [email, password, signInWithPassword])

  const handleGoogle = useCallback(async () => {
    setError(null)
    setSubmitting(true)
    await signInWithGoogle(nextPath)
    // Page will redirect — no need to setSubmitting(false)
  }, [nextPath, signInWithGoogle])

  if (authLoading) {
    return (
      <div style={styles.page}>
        <div style={styles.card}><p style={{ margin: 0, color: '#aaa', fontFamily: 'sans-serif', fontSize: '0.9rem' }}>Loading…</p></div>
      </div>
    )
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Gather</h1>

        <button onClick={handleGoogle} disabled={isSubmitting} style={styles.googleBtn}>
          Continue with Google
        </button>

        <div style={styles.divider}><span>or</span></div>

        <form onSubmit={handleEmailLogin} style={styles.form}>
          <input
            style={styles.input}
            type="email"
            placeholder="Email"
            value={email}
            onChange={event => setEmail(event.target.value)}
            required
            autoComplete="email"
          />
          <input
            style={styles.input}
            type="password"
            placeholder="Password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            required
            autoComplete="current-password"
          />
          {error && <p style={styles.error}>{error}</p>}
          {unverified && (
            <p style={styles.warning}>
              Email not verified.{' '}
              <Link to={buildPathWithNext('/verify-pending', nextPath)} style={styles.link}>Resend verification</Link>
            </p>
          )}
          <button type="submit" disabled={isSubmitting} style={styles.submitBtn}>
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p style={styles.footer}>
          No account? <Link to={buildPathWithNext('/signup', nextPath)} style={styles.link}>Sign up</Link>
        </p>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page:      { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#0a0a0a' },
  card:      { width: 360, padding: '2rem', background: '#161616', borderRadius: 12, display: 'flex', flexDirection: 'column', gap: '1rem' },
  title:     { margin: 0, color: '#fff', fontSize: '1.5rem', textAlign: 'center', fontFamily: 'sans-serif' },
  googleBtn: { padding: '0.65rem', borderRadius: 8, border: '1px solid #333', background: '#222', color: '#fff', cursor: 'pointer', fontFamily: 'sans-serif', fontSize: '0.9rem' },
  divider:   { textAlign: 'center', color: '#555', fontFamily: 'sans-serif', fontSize: '0.8rem' },
  form:      { display: 'flex', flexDirection: 'column', gap: '0.6rem' },
  input:     { padding: '0.65rem 0.75rem', borderRadius: 8, border: '1px solid #333', background: '#222', color: '#fff', fontFamily: 'sans-serif', fontSize: '0.9rem', outline: 'none' },
  submitBtn: { padding: '0.65rem', borderRadius: 8, border: 'none', background: '#4f6ef7', color: '#fff', cursor: 'pointer', fontFamily: 'sans-serif', fontSize: '0.9rem', marginTop: '0.25rem' },
  error:     { margin: 0, color: '#f87171', fontFamily: 'sans-serif', fontSize: '0.82rem' },
  warning:   { margin: 0, color: '#fbbf24', fontFamily: 'sans-serif', fontSize: '0.82rem' },
  footer:    { textAlign: 'center', color: '#888', fontFamily: 'sans-serif', fontSize: '0.82rem', margin: 0 },
  link:      { color: '#4f6ef7', textDecoration: 'none' },
}
