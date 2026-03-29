import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { AuthError, Session, User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

interface AuthContextValue {
  user: User | null
  session: Session | null
  isLoading: boolean
  isAuthenticated: boolean
  signInWithPassword: (email: string, password: string) => Promise<AuthError | null>
  signUpWithEmail: (email: string, password: string) => Promise<AuthError | null>
  signInWithGoogle: () => Promise<void>
  signOut: () => Promise<void>
  resendVerification: (email: string) => Promise<AuthError | null>
}

const AuthContext = createContext<AuthContextValue | null>(null)

/** Resolve a safe OAuth callback URL that matches the current runtime origin. */
function getAuthRedirectUrl(): string {
  const runtimeBase = window.location.origin
  const envBase = (import.meta.env.VITE_APP_URL as string | undefined)?.trim()
  const normalizedRuntimeBase = runtimeBase.replace(/\/$/, '')

  if (!envBase) return `${normalizedRuntimeBase}/auth/callback`

  try {
    const normalizedEnvBase = new URL(envBase).toString().replace(/\/$/, '')
    const runtimeOrigin = new URL(normalizedRuntimeBase).origin
    const envOrigin = new URL(normalizedEnvBase).origin

    if (envOrigin !== runtimeOrigin) {
      console.warn('[auth] ignoring VITE_APP_URL due to origin mismatch:', normalizedEnvBase, '!=', runtimeOrigin)
      return `${normalizedRuntimeBase}/auth/callback`
    }

    return `${normalizedEnvBase}/auth/callback`
  } catch {
    console.warn('[auth] ignoring invalid VITE_APP_URL:', envBase)
    return `${normalizedRuntimeBase}/auth/callback`
  }
}

/** Provide auth/session state and auth actions to the React tree. */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Track first event to set isLoading false exactly once
  const initialised = useRef(false)

  useEffect(() => {
    // Callback must be synchronous — docs warn that async callbacks + awaiting
    // other Supabase methods inside can cause a dead-lock.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      console.log('[auth] event:', event, '| user:', session?.user?.email ?? null, '| provider:', session?.user?.app_metadata?.provider ?? null)
      if (event === 'TOKEN_REFRESHED') console.log('[auth] token refreshed, expires_at:', session?.expires_at)
      if (event === 'SIGNED_OUT') console.log('[auth] session cleared from storage')
      setSession(session)
      setUser(session?.user ?? null)
      if (!initialised.current) {
        initialised.current = true
        setIsLoading(false)
        console.log('[auth] initialised | isAuthenticated:', session !== null)
      }
    })

    // Separately check if there's an error in the URL from a failed OAuth attempt
    const params = new URLSearchParams(window.location.search)
    const oauthError = params.get('error')
    const oauthErrorDesc = params.get('error_description')
    if (oauthError) {
      console.error('[auth] OAuth error in URL:', oauthError, '|', oauthErrorDesc)
    }

    return () => subscription.unsubscribe()
  }, [])

  /** Sign in using email/password credentials. */
  const signInWithPassword = useCallback(async (email: string, password: string) => {
    console.log('[auth] signInWithPassword →', email)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) console.warn('[auth] signInWithPassword error:', error.message)
    return error
  }, [])

  /** Register a new account and trigger verification email flow. */
  const signUpWithEmail = useCallback(async (email: string, password: string) => {
    console.log('[auth] signUpWithEmail →', email)
    const { error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: getAuthRedirectUrl() } })
    if (error) console.warn('[auth] signUpWithEmail error:', error.message)
    return error
  }, [])

  /** Start Google OAuth login via Supabase redirect flow. */
  const signInWithGoogle = useCallback(async () => {
    const redirectTo = getAuthRedirectUrl()
    console.log('[auth] signInWithGoogle → redirectTo:', redirectTo)
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo },
    })
  }, [])

  /** Sign out the current user session. */
  const signOut = useCallback(async () => {
    console.log('[auth] signOut')
    await supabase.auth.signOut()
  }, [])

  /** Re-send signup verification email for the provided address. */
  const resendVerification = useCallback(async (email: string) => {
    console.log('[auth] resendVerification →', email)
    const { error } = await supabase.auth.resend({ type: 'signup', email })
    if (error) console.warn('[auth] resendVerification error:', error.message)
    return error
  }, [])

  const value = useMemo<AuthContextValue>(() => ({
    user,
    session,
    isLoading,
    isAuthenticated: session !== null,
    signInWithPassword,
    signUpWithEmail,
    signInWithGoogle,
    signOut,
    resendVerification,
  }), [user, session, isLoading, signInWithPassword, signUpWithEmail, signInWithGoogle, signOut, resendVerification])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/** Access auth context with a strict provider guard. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
