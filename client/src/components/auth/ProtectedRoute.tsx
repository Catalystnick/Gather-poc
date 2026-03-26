import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'

export default function ProtectedRoute() {
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0a0a0a', color: '#fff', fontFamily: 'sans-serif' }}>
        Loading...
      </div>
    )
  }

  if (!isAuthenticated) {
    // replace: avoids pushing a protected route onto history — back button won't return here
    return <Navigate to="/login" replace />
  }

  return <Outlet />
}
