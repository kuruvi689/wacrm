import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { validateProductInput } from '@/lib/products/product-input'
import { accountDefaultCurrency, dbErrorResponse } from '@/lib/products/server'

// Product catalog — the price list the inbox and (later) the AI quote
// from. GET lists for any member (RLS-scoped); POST creates and is
// admin+, because prices are business-critical.

export async function GET() {
  try {
    const { supabase } = await getCurrentAccount()
    // RLS (products_select) scopes to the caller's account.
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .order('is_active', { ascending: false })
      .order('name', { ascending: true })
    if (error) return dbErrorResponse(error, 'products.list')
    return NextResponse.json({ products: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const result = validateProductInput(body, await accountDefaultCurrency(ctx.accountId))
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })

  const { data, error } = await supabaseAdmin()
    .from('products')
    .insert({ ...result.product, account_id: ctx.accountId, created_by: ctx.userId })
    .select()
    .single()
  if (error) return dbErrorResponse(error, 'products.create')
  return NextResponse.json({ product: data }, { status: 201 })
}
