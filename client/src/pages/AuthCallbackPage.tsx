import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

// Landing page for OAuth redirects.
// Supabase returns here with #access_token= in the hash (implicit flow).
// The SDK reads the hash on init and fires SIGNED_IN via onAuthStateChange.
// This page just waits for that event then forwards to /game.
export default function AuthCallbackPage() {
  const { isAuthenticated, isLoading } = useAuth()
  const navigate = useNavigate()
  const [timedOut, setTimedOut] = useState(false)

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/game', { replace: true })
    }
  }, [isAuthenticated, navigate])

  // Bail out if something went wrong and session never arrives
  useEffect(() => {
    const id = setTimeout(() => {
      if (!isAuthenticated) setTimedOut(true)
    }, 8000)
    return () => clearTimeout(id)
  }, [isAuthenticated])

  if (timedOut) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <p style={styles.error}>Sign-in failed. <a href="/login" style={styles.link}>Try again</a></p>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <p style={styles.text}>{isLoading ? 'Signing you in…' : 'Redirecting…'}</p>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page:  { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#0a0a0a' },
  card:  { padding: '2rem', background: '#161616', borderRadius: 12 },
  text:  { margin: 0, color: '#aaa', fontFamily: 'sans-serif', fontSize: '0.9rem' },
  error: { margin: 0, color: '#f87171', fontFamily: 'sans-serif', fontSize: '0.9rem' },
  link:  { color: '#4f6ef7' },
}
