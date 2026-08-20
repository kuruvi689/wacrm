import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * POST /api/auth/signup
 *
 * Direct database user registration RPC endpoint.
 * Completely bypasses GoTrue email rate limits (429 "email rate limit exceeded")
 * and pre-confirms users for instant login.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { email, password, fullName } = body

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      )
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )

    // Call stored RPC function to create pre-confirmed user directly
    const { data: rpcResult, error: rpcError } = await supabase.rpc(
      'create_preconfirmed_user',
      {
        p_email: email,
        p_password: password,
        p_full_name: fullName || '',
      }
    )

    if (rpcError) {
      console.error('[api/auth/signup] RPC error:', rpcError.message)
      return NextResponse.json({ error: rpcError.message }, { status: 400 })
    }

    if (rpcResult?.error) {
      return NextResponse.json({ error: rpcResult.error }, { status: 400 })
    }

    return NextResponse.json({
      success: true,
      userId: rpcResult?.userId,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Signup failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
