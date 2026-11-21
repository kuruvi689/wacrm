'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

interface ReasonDialogProps {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  destructive?: boolean
  /** Resolve true when the action succeeded (closes the dialog). */
  onSubmit: (reason: string) => Promise<boolean>
  onClose: () => void
}

/** Every operator action that changes a customer's access needs a written reason. */
export function ReasonDialog({ open, title, description, confirmLabel, destructive, onSubmit, onClose }: ReasonDialogProps) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    const done = await onSubmit(reason.trim())
    setBusy(false)
    if (done) {
      setReason('')
      onClose()
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="billing-reason">Reason (required, saved in the audit log)</Label>
          <Textarea id="billing-reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={500} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={destructive ? 'destructive' : 'default'} disabled={busy || reason.trim() === ''} onClick={() => void submit()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
