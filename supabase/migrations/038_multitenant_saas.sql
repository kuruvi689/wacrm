-- ============================================================
-- 038_multitenant_saas.sql
-- Multi-Tenant SaaS Orchestration with Meta Embedded Signup
-- ============================================================

-- 1. ORGANIZATIONS TABLE
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organizations_owner_id ON organizations(owner_id);

-- 2. WHATSAPP CONNECTIONS TABLE
CREATE TABLE IF NOT EXISTS whatsapp_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  waba_id TEXT,
  phone_number_id TEXT NOT NULL UNIQUE,
  business_id TEXT,
  display_phone_number TEXT,
  access_token_encrypted TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  meta_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_org_id ON whatsapp_connections(org_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_phone_number_id ON whatsapp_connections(phone_number_id);

-- 3. ORG MEMBERS TABLE (Team invites / roles per organization)
CREATE TABLE IF NOT EXISTS org_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_user_id ON org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org_id ON org_members(org_id);

-- Enable RLS on core multi-tenant tables
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;

-- Helper function: is_org_member
CREATE OR REPLACE FUNCTION is_org_member(_org_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM org_members
    WHERE org_id = _org_id AND user_id = auth.uid()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. ADD org_id TO ALL DATA TABLES
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE automations ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

-- Additional data tables for complete multi-tenancy
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_knowledge_documents') THEN
    ALTER TABLE ai_knowledge_documents ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tags') THEN
    ALTER TABLE tags ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'custom_fields') THEN
    ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'flows') THEN
    ALTER TABLE flows ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'quick_replies') THEN
    ALTER TABLE quick_replies ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Create indexes on org_id across data tables
CREATE INDEX IF NOT EXISTS idx_contacts_org_id ON contacts(org_id);
CREATE INDEX IF NOT EXISTS idx_conversations_org_id ON conversations(org_id);
CREATE INDEX IF NOT EXISTS idx_messages_org_id ON messages(org_id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_org_id ON broadcasts(org_id);
CREATE INDEX IF NOT EXISTS idx_pipelines_org_id ON pipelines(org_id);
CREATE INDEX IF NOT EXISTS idx_automations_org_id ON automations(org_id);

-- 5. AUTOMATIC BACKFILL FOR EXISTING USERS & RECORDS
DO $$
DECLARE
  u RECORD;
  new_org_id UUID;
BEGIN
  FOR u IN SELECT DISTINCT id FROM auth.users LOOP
    SELECT id INTO new_org_id FROM organizations WHERE owner_id = u.id LIMIT 1;
    IF new_org_id IS NULL THEN
      INSERT INTO organizations (name, owner_id)
      VALUES ('My Organization', u.id)
      RETURNING id INTO new_org_id;
    END IF;

    INSERT INTO org_members (org_id, user_id, role)
    VALUES (new_org_id, u.id, 'owner')
    ON CONFLICT (org_id, user_id) DO NOTHING;

    -- Backfill data tables for this user
    UPDATE contacts SET org_id = new_org_id WHERE user_id = u.id AND org_id IS NULL;
    UPDATE conversations SET org_id = new_org_id WHERE user_id = u.id AND org_id IS NULL;
    UPDATE broadcasts SET org_id = new_org_id WHERE user_id = u.id AND org_id IS NULL;
    UPDATE pipelines SET org_id = new_org_id WHERE user_id = u.id AND org_id IS NULL;
    UPDATE automations SET org_id = new_org_id WHERE user_id = u.id AND org_id IS NULL;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tags') THEN
      UPDATE tags SET org_id = new_org_id WHERE user_id = u.id AND org_id IS NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'custom_fields') THEN
      UPDATE custom_fields SET org_id = new_org_id WHERE user_id = u.id AND org_id IS NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'flows') THEN
      UPDATE flows SET org_id = new_org_id WHERE user_id = u.id AND org_id IS NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'quick_replies') THEN
      UPDATE quick_replies SET org_id = new_org_id WHERE user_id = u.id AND org_id IS NULL;
    END IF;
  END FOR;

  -- Backfill messages.org_id from parent conversation
  UPDATE messages m
  SET org_id = c.org_id
  FROM conversations c
  WHERE m.conversation_id = c.id AND m.org_id IS NULL;
END $$;

-- 6. RLS POLICIES FOR ORG ISOLATION
DROP POLICY IF EXISTS "Members can view their organizations" ON organizations;
CREATE POLICY "Members can view their organizations" ON organizations
  FOR SELECT USING (EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = id AND org_members.user_id = auth.uid()));

DROP POLICY IF EXISTS "Owners can update their organization" ON organizations;
CREATE POLICY "Owners can update their organization" ON organizations
  FOR UPDATE USING (owner_id = auth.uid());

DROP POLICY IF EXISTS "Users can view org members" ON org_members;
CREATE POLICY "Users can view org members" ON org_members
  FOR SELECT USING (is_org_member(org_id));

DROP POLICY IF EXISTS "Org members can view whatsapp connections" ON whatsapp_connections;
CREATE POLICY "Org members can view whatsapp connections" ON whatsapp_connections
  FOR SELECT USING (is_org_member(org_id));

DROP POLICY IF EXISTS "Org members can manage whatsapp connections" ON whatsapp_connections;
CREATE POLICY "Org members can manage whatsapp connections" ON whatsapp_connections
  FOR ALL USING (is_org_member(org_id));

-- RLS Policies on Data Tables using org_id
DROP POLICY IF EXISTS "Org members manage contacts" ON contacts;
CREATE POLICY "Org members manage contacts" ON contacts
  FOR ALL USING (org_id IS NULL OR is_org_member(org_id));

DROP POLICY IF EXISTS "Org members manage conversations" ON conversations;
CREATE POLICY "Org members manage conversations" ON conversations
  FOR ALL USING (org_id IS NULL OR is_org_member(org_id));

DROP POLICY IF EXISTS "Org members manage messages" ON messages;
CREATE POLICY "Org members manage messages" ON messages
  FOR ALL USING (org_id IS NULL OR is_org_member(org_id));

DROP POLICY IF EXISTS "Org members manage broadcasts" ON broadcasts;
CREATE POLICY "Org members manage broadcasts" ON broadcasts
  FOR ALL USING (org_id IS NULL OR is_org_member(org_id));

DROP POLICY IF EXISTS "Org members manage pipelines" ON pipelines;
CREATE POLICY "Org members manage pipelines" ON pipelines
  FOR ALL USING (org_id IS NULL OR is_org_member(org_id));

DROP POLICY IF EXISTS "Org members manage automations" ON automations;
CREATE POLICY "Org members manage automations" ON automations
  FOR ALL USING (org_id IS NULL OR is_org_member(org_id));
