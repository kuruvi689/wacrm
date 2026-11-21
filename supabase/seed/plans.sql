-- Launch plans. Prices are in paise, excluding GST. Idempotent: operator edits are never overwritten.
-- Rationale: docs/PRICING.md. Re-check competitor prices before changing.
INSERT INTO plans (id, name, description, is_active, is_public, price_minor, currency, period_days, grace_days,
  max_ai_agents, max_whatsapp_numbers, max_members, max_contacts, max_active_automations, max_integrations,
  knowledge_storage_mb, monthly_messages, monthly_ai_responses, monthly_ai_tokens, monthly_workflow_runs, sort_order)
VALUES
 ('starter', 'Starter', 'Shared inbox and a basic AI agent for a small team.', TRUE, TRUE, 99900, 'INR', 30, 3,
  1, 1, 3, 1000, 5, 1, 25, 5000, 500, 500000, 1000, 10),
 ('growth', 'Growth', 'Automations and more AI for a growing team.', TRUE, TRUE, 249900, 'INR', 30, 3,
  3, 1, 10, 10000, 25, 3, 100, 25000, 3000, 3000000, 10000, 20),
 ('pro', 'Pro', 'Multiple numbers, larger team and high AI volume.', TRUE, TRUE, 599900, 'INR', 30, 3,
  10, 3, 25, 50000, 100, 10, 500, 100000, 15000, 15000000, 50000, 30)
ON CONFLICT (id) DO NOTHING;
