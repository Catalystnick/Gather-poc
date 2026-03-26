import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

export default function SignupPage() {
  const { signUpWithEmail, signInWithGoogle, isAuthenticated } = useAuth()
  const navigate = useNavigate()

  const [email, setEmail]             = useState('')
  const [password, setPassword]       = useState('')
  const [confirm, setConfirm]         = useState('')
  const [error, setError]             = useState<string | null>(null)
  const [isSubmitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (isAuthenticated) navigate('/game', { replace: true })
  }, [isAuthenticated, navigate])

  const handleEmailSignup = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    // Client-side check — avoids a round-trip for a trivial mismatch
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    setSubmitting(true)
    const err = await signUpWithEmail(email, password)
    setSubmitting(false)

    if (err) {
      setError(err.message)
    } else {
      // session is null until email is verified — go to holding page
      navigate('/verify-pending', { state: { email } })
    }
  }, [email, password, confirm, signUpWithEmail, navigate])

  const handleGoogle = useCallback(async () => {
    setError(null)
    setSubmitting(true)
    await signInWithGoogle()
  }, [signInWithGoogle])

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Create account</h1>

        <button onClick={handleGoogle} disabled={isSubmitting} style={styles.googleBtn}>
          Continue with Google
        </button>

        <div style={styles.divider}><span>or</span></div>

        <form onSubmit={handleEmailSignup} style={styles.form}>
          <input
            style={styles.input}
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
          <input
            style={styles.input}
            type="password"
            placeholder="Password (min 8 characters)"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            autoComplete="new-password"
          />
          <input
            style={styles.input}
            type="password"
            placeholder="Confirm password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            required
            autoComplete="new-password"
          />
          {error && <p style={styles.error}>{error}</p>}
          <button type="submit" disabled={isSubmitting} style={styles.submitBtn}>
            {isSubmitting ? 'Creating account…' : 'Sign up'}
          </button>
        </form>

        <p style={styles.footer}>
          Already have an account? <Link to="/login" style={styles.link}>Sign in</Link>
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
  footer:    { textAlign: 'center', color: '#888', fontFamily: 'sans-serif', fontSize: '0.82rem', margin: 0 },
  link:      { color: '#4f6ef7', textDecoration: 'none' },
}
