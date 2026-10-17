import { BLOCK_MESSAGES, type BlockReason } from '@/lib/saas/access'
import { SignOutButton } from './sign-out-button'

export const metadata = { title: 'Workspace unavailable', robots: { index: false } }

function parseReason(value: string | string[] | undefined): BlockReason {
  return value === 'trial_expired' ? 'trial_expired' : 'suspended'
}

export default async function AccountBlockedPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string | string[] }>
}) {
  const reason = parseReason((await searchParams).reason)
  const title = reason === 'trial_expired' ? 'Your trial has ended' : 'Workspace suspended'

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-4 py-16 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-3 text-muted-foreground">{BLOCK_MESSAGES[reason]}</p>
      <p className="mt-6 text-sm text-muted-foreground">
        Your data is safe and nothing has been deleted.
      </p>
      <div className="mt-8">
        <SignOutButton />
      </div>
    </main>
  )
}
