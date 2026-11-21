import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { validateProductInput } from '@/lib/products/product-input'
import { dbErrorResponse, isUuid } from '@/lib/products/server'

// Update / delete one product. The service-role client bypasses RLS,
// so the admin check and the account scope are both enforced here.
// Orders keep their own snapshot of name and price, so edits and
// deletes never change an existing order.

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const admin = supabaseAdmin()
  const { data: existing, error: loadError } = await admin
    .from('products')
    .select('currency')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (loadError) return dbErrorResponse(loadError, 'products.load')
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // The edit form always sends the whole product, so validate it whole.
  // Currency is pinned: changing it would reinterpret the stored minor
  // units (INR paise read as JPY yen is a 100x price change).
  const result = validateProductInput({ ...body, currency: existing.currency }, existing.currency)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })

  const { data, error } = await admin
    .from('products')
    .update(result.product)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select()
    .single()
  if (error) return dbErrorResponse(error, 'products.update')
  return NextResponse.json({ product: data })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { error } = await supabaseAdmin()
    .from('products')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
  if (error) return dbErrorResponse(error, 'products.delete')
  return NextResponse.json({ ok: true })
}
