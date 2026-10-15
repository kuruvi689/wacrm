'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { isFirebaseConfigured, auth, googleProvider } from '@/lib/firebase/client'
import { signInWithPopup } from 'firebase/auth'
import { Loader2 } from 'lucide-react'

interface GoogleSignInButtonProps {
  inviteToken?: string | null
  text?: string
  onError?: (err: string) => void
}

export function GoogleSignInButton({
  inviteToken,
  text = 'Continue with Google',
  onError,
}: GoogleSignInButtonProps) {
  const [loading, setLoading] = useState(false)
  const supabase = createClient()

  const handleGoogleLogin = async () => {
    setLoading(true)
    try {
      const nextPath = inviteToken
        ? `/join/${encodeURIComponent(inviteToken)}`
        : '/dashboard'

      // 1. Primary check: Firebase Auth popup fallback
      if (isFirebaseConfigured() && auth && googleProvider) {
        try {
          const result = await signInWithPopup(auth, googleProvider)
          if (result.user.email) {
            window.location.href = nextPath
            return
          }
        } catch (fbErr: any) {
          console.warn('[Firebase Google Auth] Popup failed:', fbErr)
        }
      }

      // 2. Supabase Google OAuth with pre-flight check (skipBrowserRedirect)
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          skipBrowserRedirect: true,
          redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}`,
        },
      })

      if (error) {
        let friendlyMessage = error.message
        if (
          error.message.toLowerCase().includes('provider is not enabled') ||
          error.message.toLowerCase().includes('unsupported provider')
        ) {
          friendlyMessage =
            'Google OAuth provider is not enabled in your Supabase Dashboard. Please enable Google under Supabase Dashboard → Authentication → Providers → Google, or log in with Email & Password below.'
        }
        if (onError) onError(friendlyMessage)
        setLoading(false)
        return
      }

      if (data?.url) {
        // Pre-flight GET check to ensure provider is enabled before redirecting browser
        try {
          const res = await fetch(data.url, { method: 'GET', redirect: 'manual' })
          if (res.status === 400) {
            const bodyText = await res.text()
            if (
              bodyText.includes('validation_failed') ||
              bodyText.includes('provider is not enabled') ||
              bodyText.includes('Unsupported provider')
            ) {
              const friendlyMessage =
                'Google OAuth provider is not enabled in your Supabase Dashboard. Please enable Google under Supabase Dashboard → Authentication → Providers → Google, or log in with Email & Password below.'
              if (onError) onError(friendlyMessage)
              setLoading(false)
              return
            }
          }
        } catch (checkErr) {
          console.warn('[Google OAuth] Pre-flight check warning:', checkErr)
        }

        // Provider is enabled -> proceed to OAuth redirect
        window.location.href = data.url
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Google sign-in failed'
      if (onError) onError(message)
      setLoading(false)
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      onClick={handleGoogleLogin}
      disabled={loading}
      className="w-full gap-2 border-border bg-card hover:bg-muted text-foreground font-medium transition-colors py-5"
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24">
          <path
            fill="#4285F4"
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
          />
          <path
            fill="#34A853"
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
          />
          <path
            fill="#FBBC05"
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
          />
          <path
            fill="#EA4335"
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
          />
        </svg>
      )}
      {loading ? 'Connecting...' : text}
    </Button>
  )
}
