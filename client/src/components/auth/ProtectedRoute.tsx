import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { buildPathWithNext } from '../../utils/nextPath'

/** Guard routes that require an authenticated session. */
export default function ProtectedRoute() {
  const { isAuthenticated, isLoading } = useAuth()
  const location = useLocation()

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0a0a0a', color: '#fff', fontFamily: 'sans-serif' }}>
        Loading...
      </div>
    )
  }

  if (!isAuthenticated) {
    // replace: avoids pushing a protected route onto history — back button won't return here
    const nextPath = `${location.pathname}${location.search}`
    return <Navigate to={buildPathWithNext('/login', nextPath)} replace />
  }

  return <Outlet />
}
