'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatMinor } from '@/lib/products/money'

import { adminRequest } from './admin-api'
import { LIMIT_FIELDS, emptyPlanForm, formToBody, planToForm, type PlanForm } from './plan-form'
import type { AdminPlan } from './types'

export function PlansEditor() {
  const [plans, setPlans] = useState<AdminPlan[]>([])
  const [form, setForm] = useState<PlanForm | null>(null)
  const [editingExisting, setEditingExisting] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const result = await adminRequest<{ plans: AdminPlan[] }>('/api/admin/billing/plans')
    if (result.ok) setPlans(result.data.plans)
    else toast.error(result.message)
  }, [])

  useEffect(() => {
    let cancelled = false
    adminRequest<{ plans: AdminPlan[] }>('/api/admin/billing/plans').then((result) => {
      if (cancelled) return
      if (result.ok) setPlans(result.data.plans)
      else toast.error(result.message)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function save() {
    if (!form) return
    setSaving(true)
    const result = await adminRequest('/api/admin/billing/plans', formToBody(form))
    setSaving(false)
    if (!result.ok) {
      toast.error(result.message)
      return
    }
    toast.success('Plan saved')
    setForm(null)
    await load()
  }

  const update = (patch: Partial<PlanForm>) => setForm((prev) => (prev ? { ...prev, ...patch } : prev))

  return (
    <Card>
      <CardHeader>
        <CardTitle>Plans</CardTitle>
        <CardDescription>
          You set every price here. A plan is on sale only when it is active, public and has a price. Leave a limit
          empty for unlimited.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="divide-y rounded-lg border">
          {plans.map((plan) => (
            <li key={plan.id} className="flex flex-wrap items-center gap-2 p-3">
              <span className="font-medium">{plan.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{plan.id}</span>
              {plan.is_active ? <Badge variant="secondary">active</Badge> : <Badge variant="outline">inactive</Badge>}
              {plan.is_public ? <Badge variant="secondary">public</Badge> : <Badge variant="outline">hidden</Badge>}
              <span className="ml-auto text-sm tabular-nums">
                {plan.price_minor === null ? 'Not for sale' : `${formatMinor(plan.price_minor, plan.currency)} / ${plan.period_days}d`}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditingExisting(true)
                  setForm(planToForm(plan))
                }}
              >
                Edit
              </Button>
            </li>
          ))}
        </ul>
        {!form ? (
          <Button
            onClick={() => {
              setEditingExisting(false)
              setForm(emptyPlanForm())
            }}
          >
            New plan
          </Button>
        ) : (
          <div className="space-y-4 rounded-lg border p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Plan id" hint="lowercase, e.g. starter">
                <Input value={form.id} disabled={editingExisting} onChange={(e) => update({ id: e.target.value })} />
              </Field>
              <Field label="Name">
                <Input value={form.name} onChange={(e) => update({ name: e.target.value })} />
              </Field>
              <Field label="Description">
                <Input value={form.description} onChange={(e) => update({ description: e.target.value })} />
              </Field>
              <Field label="Price" hint="e.g. 999.00; empty = not for sale">
                <Input inputMode="decimal" value={form.price} onChange={(e) => update({ price: e.target.value })} />
              </Field>
              <Field label="Currency">
                <Input value={form.currency} maxLength={3} onChange={(e) => update({ currency: e.target.value })} />
              </Field>
              <Field label="Period (days)">
                <Input inputMode="numeric" value={form.period_days} onChange={(e) => update({ period_days: e.target.value })} />
              </Field>
              <Field label="Grace (days)">
                <Input inputMode="numeric" value={form.grace_days} onChange={(e) => update({ grace_days: e.target.value })} />
              </Field>
              <Field label="Sort order">
                <Input inputMode="numeric" value={form.sort_order} onChange={(e) => update({ sort_order: e.target.value })} />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {LIMIT_FIELDS.map(([key, label]) => (
                <Field key={key} label={label} hint="empty = unlimited">
                  <Input
                    inputMode="numeric"
                    value={form.limits[key]}
                    onChange={(e) => update({ limits: { ...form.limits, [key]: e.target.value } })}
                  />
                </Field>
              ))}
            </div>
            <div className="flex flex-wrap gap-6">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={form.is_active} onCheckedChange={(v) => update({ is_active: v === true })} /> Active
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={form.is_public} onCheckedChange={(v) => update({ is_public: v === true })} /> Public (shown to customers)
              </label>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => void save()} disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                Save plan
              </Button>
              <Button variant="outline" onClick={() => setForm(null)} disabled={saving}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
