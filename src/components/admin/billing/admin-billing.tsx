'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'

import { AuditLog } from './audit-log'
import { PaymentQueue } from './payment-queue'
import { PlansEditor } from './plans-editor'
import { WorkspaceBilling } from './workspace-billing'

const SECTIONS = [
  { id: 'payments', label: 'Payments' },
  { id: 'plans', label: 'Plans' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'audit', label: 'Audit log' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

/** Operator Billing tab: payment queue, plan editor, per-workspace controls, audit log. */
export function AdminBilling() {
  const [section, setSection] = useState<SectionId>('payments')
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {SECTIONS.map((item) => (
          <Button key={item.id} size="sm" variant={item.id === section ? 'secondary' : 'ghost'} onClick={() => setSection(item.id)}>
            {item.label}
          </Button>
        ))}
      </div>
      {section === 'payments' ? <PaymentQueue /> : null}
      {section === 'plans' ? <PlansEditor /> : null}
      {section === 'workspaces' ? <WorkspaceBilling /> : null}
      {section === 'audit' ? <AuditLog /> : null}
    </div>
  )
}
