'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { MessageSquare, UsersRound, Building2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * First-run setup for a brand-new workspace. Reached via the dashboard
 * layout gate until `accounts.onboarding_completed_at` is set. Each
 * step is optional — the goal is to get a new client to a connected
 * WhatsApp number fast, not to block them.
 */
export default function OnboardingPage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [savedName, setSavedName] = useState('')
  const [loading, setLoading] = useState(true)
  const [savingName, setSavingName] = useState(false)
  const [finishing, setFinishing] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/account')
      .then((res) => (res.ok ? res.json() : null))
      .then((payload) => {
        if (cancelled || !payload?.account?.name) return
        setName(payload.account.name)
        setSavedName(payload.account.name)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function saveName() {
    const trimmed = name.trim()
    if (!trimmed || trimmed === savedName) return
    setSavingName(true)
    const res = await fetch('/api/account', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    })
    setSavingName(false)
    if (!res.ok) {
      toast.error('Could not save the workspace name')
      return
    }
    setSavedName(trimmed)
    toast.success('Workspace name saved')
  }

  async function finish(destination: string) {
    setFinishing(true)
    const { error } = await createClient().rpc('complete_onboarding')
    if (error) {
      setFinishing(false)
      toast.error('Could not finish setup. Please try again.')
      return
    }
    router.replace(destination)
    router.refresh()
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-4 py-12">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome — let&apos;s set up your workspace</h1>
        <p className="mt-1 text-muted-foreground">
          Three quick steps. You can skip any of them and come back from Settings.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="size-4" /> 1. Name your workspace
          </CardTitle>
          <CardDescription>Shown to your teammates and on invitations.</CardDescription>
        </CardHeader>
        <CardContent className="flex items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="workspace-name">Workspace name</Label>
            <Input
              id="workspace-name"
              value={name}
              maxLength={80}
              disabled={loading}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <Button onClick={saveName} disabled={savingName || loading || !name.trim() || name.trim() === savedName}>
            {savingName ? 'Saving…' : 'Save'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="size-4" /> 2. Connect WhatsApp
          </CardTitle>
          <CardDescription>
            Link your WhatsApp Business number to start receiving and sending messages.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" disabled={finishing} onClick={() => finish('/settings?tab=whatsapp')}>
            Connect WhatsApp
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UsersRound className="size-4" /> 3. Invite your team
          </CardTitle>
          <CardDescription>Add agents so everyone can work from the shared inbox.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" disabled={finishing} onClick={() => finish('/settings?tab=members')}>
            Invite teammates
          </Button>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button disabled={finishing} onClick={() => finish('/dashboard')}>
          {finishing ? 'Finishing…' : 'Go to dashboard'}
        </Button>
      </div>
    </main>
  )
}
