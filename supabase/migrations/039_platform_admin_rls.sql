-- Migration 039: Platform Admin RLS & Tenant Isolation
-- Platform Admin Email: ssivanesh544@gmail.com

CREATE OR REPLACE FUNCTION is_platform_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN LOWER(COALESCE(auth.jwt() ->> 'email', '')) = LOWER('ssivanesh544@gmail.com');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION is_platform_admin() TO authenticated, service_role, anon;

-- Update RLS on accounts table
ALTER TABLE IF EXISTS accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Platform admin can read all accounts" ON accounts;
CREATE POLICY "Platform admin can read all accounts"
ON accounts FOR SELECT
TO authenticated
USING (is_platform_admin() OR id = public.current_account_id());

-- Update RLS on whatsapp_connections table
ALTER TABLE IF EXISTS whatsapp_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Platform admin can read all whatsapp_connections" ON whatsapp_connections;
CREATE POLICY "Platform admin can read all whatsapp_connections"
ON whatsapp_connections FOR SELECT
TO authenticated
USING (is_platform_admin() OR account_id = public.current_account_id());
