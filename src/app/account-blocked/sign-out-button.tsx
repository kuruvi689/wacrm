'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'

export function SignOutButton() {
  const [pending, setPending] = useState(false)

  async function handleSignOut() {
    setPending(true)
    await createClient().auth.signOut()
    window.location.assign('/login')
  }

  return (
    <Button variant="outline" onClick={handleSignOut} disabled={pending}>
      {pending ? 'Signing out…' : 'Sign out'}
    </Button>
  )
}
