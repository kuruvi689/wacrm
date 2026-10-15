import { NextResponse } from 'next/server'
import { getTenantConnection, getTenantToken } from '@/lib/whatsapp/token-vault'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const org_id = searchParams.get('org_id')

    if (!org_id) {
      return NextResponse.json({ error: 'org_id parameter is required' }, { status: 400 })
    }

    const connection = await getTenantConnection(org_id)

    if (!connection) {
      return NextResponse.json(
        { error: 'No WhatsApp connection found for this organization', connected: false },
        { status: 444 }
      )
    }

    const accessToken = await getTenantToken(org_id, connection.phone_number_id)

    if (!accessToken) {
      return NextResponse.json(
        { error: 'Failed to decrypt access token for organization' },
        { status: 500 }
      )
    }

    const META_API_VERSION = process.env.META_API_VERSION || 'v20.0'
    const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

    let phoneNumbers: any[] = []
    let templates: any[] = []

    // Fetch Phone Numbers if waba_id present
    if (connection.waba_id) {
      try {
        const phonesRes = await fetch(`${META_API_BASE}/${connection.waba_id}/phone_numbers`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        const phonesData = await phonesRes.json()
        if (phonesData.data) {
          phoneNumbers = phonesData.data
        }
      } catch (err) {
        console.warn('[connection API] Failed to fetch phone numbers:', err)
      }

      // Fetch Message Templates (proves whatsapp_business_management)
      try {
        const templatesRes = await fetch(
          `${META_API_BASE}/${connection.waba_id}/message_templates?limit=100`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        )
        const templatesData = await templatesRes.json()
        if (templatesData.data) {
          templates = templatesData.data
        }
      } catch (err) {
        console.warn('[connection API] Failed to fetch message templates:', err)
      }
    } else if (connection.phone_number_id) {
      // Fallback if waba_id is missing: fetch single phone number details
      try {
        const phoneRes = await fetch(
          `${META_API_BASE}/${connection.phone_number_id}?fields=id,display_phone_number,verified_name`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        )
        const phoneData = await phoneRes.json()
        if (phoneData.id) {
          phoneNumbers = [phoneData]
        }
      } catch (err) {
        console.warn('[connection API] Failed to fetch phone detail:', err)
      }
    }

    return NextResponse.json({
      connected: true,
      connection: {
        id: connection.id,
        org_id: connection.org_id,
        waba_id: connection.waba_id,
        phone_number_id: connection.phone_number_id,
        display_phone_number: connection.display_phone_number,
        status: connection.status,
        updated_at: connection.updated_at,
      },
      phone_numbers: phoneNumbers,
      templates: templates,
    })
  } catch (err: any) {
    console.error('[onboarding/connection] Error:', err)
    return NextResponse.json(
      { error: err.message || 'Internal server error' },
      { status: 500 }
    )
  }
}
