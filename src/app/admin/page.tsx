import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/saas/access'
import { AdminConsole } from './admin-console'

export const metadata = { title: 'Operator console', robots: { index: false } }

export default async function AdminPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')
  // 404 rather than 403 so the console's existence isn't advertised.
  if (!isPlatformAdmin(user)) notFound()

  return <AdminConsole />
}
