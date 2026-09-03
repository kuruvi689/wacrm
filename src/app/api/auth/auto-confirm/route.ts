import { NextResponse } from 'next/server'

/**
 * Disabled endpoint.
 * Registration and email confirmation are handled directly via /api/auth/signup.
 */
export async function POST() {
  return NextResponse.json(
    { error: 'Endpoint disabled' },
    { status: 404 }
  )
}
