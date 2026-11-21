import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { parseProductCsv, type ProductWrite } from '@/lib/products/product-input'
import { accountDefaultCurrency, dbErrorResponse } from '@/lib/products/server'

// CSV import. The browser previews with the same parser, but the
// server re-parses the raw text so a tampered client can't slip in
// invalid prices. Rows with a SKU upsert (re-importing updates the
// price list); rows without one are always new products. Invalid rows
// are skipped and reported back by line number.

const MAX_CSV_BYTES = 1_000_000

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  const csv = typeof body?.csv === 'string' ? body.csv : ''
  if (!csv.trim()) return NextResponse.json({ error: 'csv is required' }, { status: 400 })
  if (csv.length > MAX_CSV_BYTES) {
    return NextResponse.json({ error: 'The file is too large (max 1 MB).' }, { status: 413 })
  }

  const parsed = parseProductCsv(csv, await accountDefaultCurrency(ctx.accountId))
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const skipped = parsed.rows
    .filter((row) => !row.result.ok)
    .map((row) => ({ line: row.line, error: row.result.ok ? '' : row.result.error }))
  const valid = parsed.rows.flatMap((row) => (row.result.ok ? [row.result.product] : []))

  const toRow = (product: ProductWrite) => ({
    ...product,
    account_id: ctx.accountId,
    created_by: ctx.userId,
  })
  const withSku = valid.filter((p) => p.sku).map(toRow)
  const withoutSku = valid.filter((p) => !p.sku).map(toRow)

  const admin = supabaseAdmin()
  if (withSku.length > 0) {
    const { error } = await admin
      .from('products')
      .upsert(withSku, { onConflict: 'account_id,sku' })
    if (error) return dbErrorResponse(error, 'products.import.upsert')
  }
  if (withoutSku.length > 0) {
    const { error } = await admin.from('products').insert(withoutSku)
    if (error) return dbErrorResponse(error, 'products.import.insert')
  }

  return NextResponse.json({ imported: valid.length, skipped })
}
