-- Local or isolated staging only. Never run against production.
-- First create the Auth user wacrm-demo@example.invalid so signup provisions
-- its workspace. In the same connection, opt in explicitly:
-- SET wacrm.demo_seed = 'isolated-staging';

DO $$
DECLARE
  demo_owner uuid;
  demo_account uuid;
  demo_contact constant uuid := '0d3a0000-0000-4000-8000-000000000001';
  demo_conversation constant uuid := '0d3a0000-0000-4000-8000-000000000002';
  demo_agent constant uuid := '0d3a0000-0000-4000-8000-000000000003';
  demo_version constant uuid := '0d3a0000-0000-4000-8000-000000000004';
BEGIN
  IF current_setting('wacrm.demo_seed', true) IS DISTINCT FROM 'isolated-staging' THEN
    RAISE EXCEPTION 'Demo seed requires explicit isolated-staging opt-in';
  END IF;

  SELECT u.id, a.id INTO STRICT demo_owner, demo_account
  FROM auth.users u
  JOIN public.accounts a ON a.owner_user_id = u.id
  JOIN public.profiles p ON p.user_id = u.id AND p.account_id = a.id
  WHERE u.email = 'wacrm-demo@example.invalid' AND p.account_role = 'owner';

  IF EXISTS (SELECT 1 FROM public.whatsapp_config WHERE account_id = demo_account) THEN
    RAISE EXCEPTION 'Demo workspace must have no WhatsApp connection';
  END IF;

  INSERT INTO public.plans (id, name, description, price_minor, is_public)
  VALUES ('wacrm-demo', 'Demo workspace', 'Synthetic data for release testing.', NULL, false)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.contacts (id, user_id, account_id, phone, name)
  VALUES (demo_contact, demo_owner, demo_account, '12025550141', 'Demo Customer')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.conversations (id, user_id, account_id, contact_id, last_message_text, last_message_at)
  VALUES (demo_conversation, demo_owner, demo_account, demo_contact, 'When does the demo shop open?', now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.messages (id, conversation_id, sender_type, content_text)
  VALUES ('0d3a0000-0000-4000-8000-000000000005', demo_conversation, 'customer', 'When does the demo shop open?')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.ai_agents (id, account_id, name, role, created_by)
  VALUES (demo_agent, demo_account, 'Demo Shop Assistant', 'Support', demo_owner)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.ai_agent_versions
    (id, agent_id, account_id, version_number, provider, model, system_prompt, business_knowledge, created_by)
  VALUES
    (demo_version, demo_agent, demo_account, 1, 'openai', 'gpt-4o-mini',
     'Answer questions about the fictional demo shop.', 'The demo shop opens at 9 am.', demo_owner)
  ON CONFLICT (id) DO NOTHING;

  UPDATE public.ai_agents SET current_version_id = demo_version
  WHERE id = demo_agent AND account_id = demo_account AND current_version_id IS NULL;
END $$;
