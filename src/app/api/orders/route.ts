import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { priceOrder, type OrderLineRequest, type PricingProduct } from '@/lib/products/pricing'
import { parsePercent } from '@/lib/products/product-input'
import { dbErrorResponse, isUuid } from '@/lib/products/server'

// Orders. POST takes product ids + quantities only: every price, tax
// and discount limit is read from the catalog and totalled by
// `priceOrder`, so neither the browser nor (later) the AI can set an
// amount. Payment links attach to these orders in the next phase.

const ORDER_SELECT = '*, order_items(*), contact:contacts(id, name, phone)'

export async function GET(request: Request) {
  try {
    const { supabase } = await getCurrentAccount()
    const url = new URL(request.url)
    const contactId = url.searchParams.get('contact_id')
    // RLS (orders_select) scopes to the caller's account.
    let query = supabase
      .from('orders')
      .select(ORDER_SELECT)
      .order('created_at', { ascending: false })
      .limit(100)
    if (contactId) {
      if (!isUuid(contactId)) return NextResponse.json({ orders: [] })
      query = query.eq('contact_id', contactId)
    }
    const { data, error } = await query
    if (error) return dbErrorResponse(error, 'orders.list')
    return NextResponse.json({ orders: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const items: OrderLineRequest[] = Array.isArray(body.items) ? body.items : []
  if (items.some((item) => !isUuid(item?.product_id))) {
    return NextResponse.json({ error: 'Each item needs a valid product_id.' }, { status: 400 })
  }
  const discountPct = parsePercent(body.discount_pct ?? 0)
  if (discountPct === null) {
    return NextResponse.json({ error: 'Discount must be between 0 and 100%.' }, { status: 400 })
  }
  for (const key of ['contact_id', 'conversation_id', 'deal_id'] as const) {
    if (body[key] != null && !isUuid(body[key])) {
      return NextResponse.json({ error: `${key} is not a valid id.` }, { status: 400 })
    }
  }
  const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) || null : null

  const admin = supabaseAdmin()

  // Linked records must belong to the caller's account: the service
  // role would otherwise let an order point at another tenant's data.
  const links = [
    ['contacts', body.contact_id],
    ['conversations', body.conversation_id],
    ['deals', body.deal_id],
  ] as const
  for (const [table, id] of links) {
    if (!id) continue
    const { data, error } = await admin
      .from(table)
      .select('id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (error) return dbErrorResponse(error, `orders.check_${table}`)
    if (!data) return NextResponse.json({ error: `${table.slice(0, -1)} not found` }, { status: 404 })
  }

  const productIds = [...new Set(items.map((item) => item.product_id))]
  const { data: products, error: productsError } = productIds.length
    ? await admin
        .from('products')
        .select('id, name, sku, price_minor, currency, tax_rate, max_discount_pct, is_active')
        .eq('account_id', ctx.accountId)
        .in('id', productIds)
    : { data: [], error: null }
  if (productsError) return dbErrorResponse(productsError, 'orders.load_products')

  const priced = priceOrder(items, (products ?? []) as PricingProduct[], discountPct)
  if (!priced.ok) {
    return NextResponse.json({ error: priced.error, code: priced.code }, { status: 400 })
  }
  const { lines, ...totals } = priced.order

  const { data: order, error: orderError } = await admin
    .from('orders')
    .insert({
      ...totals,
      account_id: ctx.accountId,
      contact_id: body.contact_id ?? null,
      conversation_id: body.conversation_id ?? null,
      deal_id: body.deal_id ?? null,
      created_via: 'agent',
      created_by: ctx.userId,
      notes,
    })
    .select('id')
    .single()
  if (orderError) return dbErrorResponse(orderError, 'orders.create')

  const { error: itemsError } = await admin
    .from('order_items')
    .insert(lines.map((line) => ({ ...line, order_id: order.id, account_id: ctx.accountId })))
  if (itemsError) {
    // No multi-statement transactions over PostgREST: remove the empty
    // order so a half-written basket is never left behind.
    await admin.from('orders').delete().eq('id', order.id)
    return dbErrorResponse(itemsError, 'orders.create_items')
  }

  const { data: full, error: loadError } = await admin
    .from('orders')
    .select(ORDER_SELECT)
    .eq('id', order.id)
    .single()
  if (loadError) return dbErrorResponse(loadError, 'orders.reload')
  return NextResponse.json({ order: full }, { status: 201 })
}
