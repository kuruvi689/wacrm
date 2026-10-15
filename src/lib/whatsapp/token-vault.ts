import { createClient } from '@supabase/supabase-js'
import { encrypt, decrypt } from './encryption'

// Singleton in-memory connection map preserved across Next.js dev module reloads
const memoryConnectionsMap: Map<string, TenantConnection> =
  (globalThis as any)._memoryConnectionsMap ||
  ((globalThis as any)._memoryConnectionsMap = new Map<string, TenantConnection>())

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  const urlRef = url ? url.match(/https:\/\/([^.]+)\.supabase/)?.[1] : null

  let keyToUse = anonKey
  if (serviceKey && urlRef) {
    try {
      const payloadBase64 = serviceKey.split('.')[1]
      if (payloadBase64) {
        const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'))
        if (payload.ref === urlRef) {
          keyToUse = serviceKey
        }
      }
    } catch {
      keyToUse = anonKey
    }
  }

  return createClient(url, keyToUse)
}

export function encryptToken(rawToken: string): string {
  if (!rawToken) throw new Error('Cannot encrypt empty token')
  return encrypt(rawToken)
}

export function decryptToken(encryptedToken: string): string {
  if (!encryptedToken) throw new Error('Cannot decrypt empty token')
  return decrypt(encryptedToken)
}

export interface TenantConnection {
  id: string
  org_id: string
  waba_id: string | null
  phone_number_id: string
  business_id: string | null
  display_phone_number: string | null
  access_token_encrypted: string
  status: string
  meta_data: Record<string, any>
  created_at: string
  updated_at: string
}

/**
 * Fetch tenant WhatsApp connection from database or memory cache.
 */
export async function getTenantConnection(
  orgId: string,
  phoneNumberId?: string
): Promise<TenantConnection | null> {
  // Check in-memory singleton cache first
  const memConn = Array.from(memoryConnectionsMap.values()).find(
    (c) => c.org_id === orgId && (!phoneNumberId || c.phone_number_id === phoneNumberId)
  )
  if (memConn) return memConn

  const supabase = getAdminClient()

  let query = supabase.from('whatsapp_connections').select('*').eq('org_id', orgId)
  if (phoneNumberId) {
    query = query.eq('phone_number_id', phoneNumberId)
  }

  let { data, error } = await query.order('updated_at', { ascending: false }).limit(1).maybeSingle()

  if (error) {
    let legacyQuery = supabase.from('whatsapp_config').select('*')
    if (phoneNumberId) {
      legacyQuery = legacyQuery.eq('phone_number_id', phoneNumberId)
    }
    const { data: legacyRow } = await legacyQuery.limit(1).maybeSingle()

    if (legacyRow) {
      return {
        id: legacyRow.id,
        org_id: legacyRow.account_id || orgId,
        waba_id: legacyRow.waba_id || null,
        phone_number_id: legacyRow.phone_number_id,
        business_id: null,
        display_phone_number: legacyRow.display_phone_number || null,
        access_token_encrypted: legacyRow.access_token,
        status: legacyRow.status || 'active',
        meta_data: {},
        created_at: legacyRow.created_at || new Date().toISOString(),
        updated_at: legacyRow.updated_at || new Date().toISOString(),
      }
    }
  }

  return data as TenantConnection | null
}

/**
 * Fetch connection by phone_number_id across all orgs (used for Webhook Routing).
 */
export async function getConnectionByPhoneNumberId(
  phoneNumberId: string
): Promise<TenantConnection | null> {
  // Check memory cache first
  const memConn = Array.from(memoryConnectionsMap.values()).find(
    (c) => c.phone_number_id === phoneNumberId
  )
  if (memConn) return memConn

  const supabase = getAdminClient()
  let { data, error } = await supabase
    .from('whatsapp_connections')
    .select('*')
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle()

  if (error) {
    const { data: legacyRow } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('phone_number_id', phoneNumberId)
      .maybeSingle()

    if (legacyRow) {
      return {
        id: legacyRow.id,
        org_id: legacyRow.account_id || legacyRow.user_id,
        waba_id: legacyRow.waba_id || null,
        phone_number_id: legacyRow.phone_number_id,
        business_id: null,
        display_phone_number: legacyRow.display_phone_number || null,
        access_token_encrypted: legacyRow.access_token,
        status: legacyRow.status || 'active',
        meta_data: {},
        created_at: legacyRow.created_at || new Date().toISOString(),
        updated_at: legacyRow.updated_at || new Date().toISOString(),
      }
    }
  }

  return data as TenantConnection | null
}

/**
 * Retrieve decrypted access token for a tenant organization.
 */
export async function getTenantToken(
  orgId: string,
  phoneNumberId?: string
): Promise<string | null> {
  const connection = await getTenantConnection(orgId, phoneNumberId)
  if (!connection || !connection.access_token_encrypted) {
    return null
  }
  return decryptToken(connection.access_token_encrypted)
}

export interface StoreTenantConnectionParams {
  org_id: string
  phone_number_id: string
  waba_id?: string | null
  business_id?: string | null
  display_phone_number?: string | null
  raw_access_token: string
  status?: string
  meta_data?: Record<string, any>
}

/**
 * Encrypt access token using AES-256-GCM and store into whatsapp_connections table.
 * Falls back to whatsapp_config table or global singleton memory cache if DB tables/RLS policies fail.
 */
export async function storeTenantConnection(
  params: StoreTenantConnectionParams
): Promise<TenantConnection> {
  const {
    org_id,
    phone_number_id,
    waba_id,
    business_id,
    display_phone_number,
    raw_access_token,
    status = 'active',
    meta_data = {},
  } = params

  const encryptedToken = encryptToken(raw_access_token)
  const supabase = getAdminClient()
  const now = new Date().toISOString()

  // Always update global singleton memory cache so active server session immediately sees connection
  const connectionObj: TenantConnection = {
    id: `conn-${Date.now()}`,
    org_id,
    waba_id: waba_id || null,
    phone_number_id,
    business_id: business_id || null,
    display_phone_number: display_phone_number || null,
    access_token_encrypted: encryptedToken,
    status,
    meta_data,
    created_at: now,
    updated_at: now,
  }
  memoryConnectionsMap.set(phone_number_id, connectionObj)

  // 1. Try whatsapp_connections in DB
  const { data: existing, error: findError } = await supabase
    .from('whatsapp_connections')
    .select('id')
    .eq('phone_number_id', phone_number_id)
    .maybeSingle()

  if (!findError) {
    if (existing) {
      const { data, error } = await supabase
        .from('whatsapp_connections')
        .update({
          org_id,
          waba_id: waba_id || null,
          business_id: business_id || null,
          display_phone_number: display_phone_number || null,
          access_token_encrypted: encryptedToken,
          status,
          meta_data,
          updated_at: now,
        })
        .eq('id', existing.id)
        .select()
        .single()

      if (!error && data) return data as TenantConnection
    } else {
      const { data, error } = await supabase
        .from('whatsapp_connections')
        .insert({
          org_id,
          phone_number_id,
          waba_id: waba_id || null,
          business_id: business_id || null,
          display_phone_number: display_phone_number || null,
          access_token_encrypted: encryptedToken,
          status,
          meta_data,
          created_at: now,
          updated_at: now,
        })
        .select()
        .single()

      if (!error && data) return data as TenantConnection
    }
  }

  // 2. Try legacy whatsapp_config table
  try {
    const { data: firstProfile } = await supabase.from('profiles').select('user_id').limit(1).maybeSingle()
    const isUuid = (val: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)
    const validUserId = firstProfile?.user_id || (isUuid(org_id) ? org_id : '00000000-0000-0000-0000-000000000000')

    const { data: legacyExisting } = await supabase
      .from('whatsapp_config')
      .select('id')
      .eq('phone_number_id', phone_number_id)
      .maybeSingle()

    if (legacyExisting) {
      await supabase
        .from('whatsapp_config')
        .update({
          phone_number_id,
          waba_id: waba_id || null,
          access_token: encryptedToken,
          status: 'connected',
          updated_at: now,
        })
        .eq('id', legacyExisting.id)
    } else {
      await supabase.from('whatsapp_config').insert({
        user_id: validUserId,
        phone_number_id,
        waba_id: waba_id || null,
        access_token: encryptedToken,
        status: 'connected',
        created_at: now,
        updated_at: now,
      })
    }
  } catch (err) {
    console.warn('[token-vault] DB store failed, utilizing in-memory tenant connection cache:', err)
  }

  return connectionObj
}
