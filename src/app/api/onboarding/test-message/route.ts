import { NextResponse } from 'next/server'
import { getTenantConnection, getTenantToken } from '@/lib/whatsapp/token-vault'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const {
      org_id,
      phone_number_id,
      recipient_phone,
      template_name,
      language_code = 'en_US',
      components = [],
    } = body

    if (!org_id) {
      return NextResponse.json({ error: 'org_id is required' }, { status: 400 })
    }
    if (!recipient_phone) {
      return NextResponse.json({ error: 'recipient_phone is required' }, { status: 400 })
    }
    if (!template_name) {
      return NextResponse.json({ error: 'template_name is required' }, { status: 400 })
    }

    const connection = await getTenantConnection(org_id, phone_number_id)
    if (!connection) {
      return NextResponse.json(
        { error: 'No WhatsApp connection found for this organization' },
        { status: 404 }
      )
    }

    const targetPhoneId = phone_number_id || connection.phone_number_id
    const accessToken = await getTenantToken(org_id, targetPhoneId)

    if (!accessToken) {
      return NextResponse.json(
        { error: 'Failed to retrieve access token' },
        { status: 500 }
      )
    }

    const META_API_VERSION = process.env.META_API_VERSION || 'v20.0'
    const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

    // Clean recipient phone number
    const cleanPhone = recipient_phone.replace(/[^0-9]/g, '')

    const payload = {
      messaging_product: 'whatsapp',
      to: cleanPhone,
      type: 'template',
      template: {
        name: template_name,
        language: { code: language_code },
        ...(components.length > 0 ? { components } : {}),
      },
    }

    const metaRes = await fetch(`${META_API_BASE}/${targetPhoneId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    const metaData = await metaRes.json()

    if (!metaRes.ok) {
      console.error('[test-message API] Meta send failed:', metaData)
      return NextResponse.json(
        {
          success: false,
          error: metaData.error?.message || 'Meta API returned error',
          details: metaData,
        },
        { status: metaRes.status }
      )
    }

    return NextResponse.json({
      success: true,
      wamid: metaData.messages?.[0]?.id,
      recipient_phone: cleanPhone,
      template_name,
      meta_response: metaData,
    })
  } catch (err: any) {
    console.error('[onboarding/test-message] Error:', err)
    return NextResponse.json(
      { error: err.message || 'Internal server error' },
      { status: 500 }
    )
  }
}
