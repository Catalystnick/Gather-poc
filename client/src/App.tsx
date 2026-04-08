import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import ProtectedRoute from './components/auth/ProtectedRoute'

const LoginPage         = lazy(() => import('./pages/LoginPage'))
const SignupPage        = lazy(() => import('./pages/SignupPage'))
const VerifyPendingPage = lazy(() => import('./pages/VerifyPendingPage'))
const AuthCallbackPage  = lazy(() => import('./pages/AuthCallbackPage'))
const GameRoute         = lazy(() => import('./pages/GameRoute'))
const DashboardRoute    = lazy(() => import('./pages/DashboardRoute'))

// Lightweight fallback — shown only during the initial chunk fetch.
// Auth pages are tiny; the game chunk (Three.js + LiveKit + WASM) is large
// but only fetched after the user is authenticated.
/** Lightweight fallback shown while lazy page chunks are loading. */
function PageLoader() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0a0a0a', color: '#fff', fontFamily: 'sans-serif' }}>
      Loading...
    </div>
  )
}

/** Application router shell with auth provider and protected game route. */
export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/login"          element={<LoginPage />} />
            <Route path="/signup"         element={<SignupPage />} />
            <Route path="/verify-pending" element={<VerifyPendingPage />} />
            <Route path="/auth/callback"  element={<AuthCallbackPage />} />
            <Route element={<ProtectedRoute />}>
              <Route path="/dashboard"      element={<DashboardRoute />} />
              <Route path="/game/:worldKey?" element={<GameRoute />} />
            </Route>
            <Route path="*"               element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  )
}
