-- Synthetic manual UPI lifecycle. Run against local or isolated staging only.
-- The transaction rolls back all synthetic accounts, invoices and ledger rows.
BEGIN;

DO $$
DECLARE
  demo_owner uuid := gen_random_uuid();
  demo_operator uuid := gen_random_uuid();
  workspace uuid;
  test_plan text := 'synthetic-smoke-' || substr(demo_owner::text, 1, 8);
  invoice_row public.invoices;
  attempt_row public.payment_attempts;
  proof jsonb;
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES (demo_owner, 'owner-' || demo_owner::text || '@example.invalid'),
         (demo_operator, 'operator-' || demo_operator::text || '@example.invalid');

  SELECT id INTO STRICT workspace FROM public.accounts WHERE owner_user_id = demo_owner;

  INSERT INTO public.plans (id, name, is_public, price_minor, currency)
  VALUES (test_plan, 'Synthetic payment smoke', true, 12345, 'INR');

  SELECT * INTO STRICT invoice_row
  FROM public.billing_open_checkout(workspace, test_plan, 'new', 0, demo_owner);

  IF invoice_row.amount_minor <> 12345 OR invoice_row.status <> 'open' THEN
    RAISE EXCEPTION 'Smoke checkout did not use the plan price or open an invoice';
  END IF;

  SELECT * INTO STRICT attempt_row
  FROM public.billing_create_payment_attempt(
    invoice_row.id, workspace, 'manual_upi', 'synthetic-checkout-1', 'STAGEONLY1',
    'upi://pay?pa=demo%40invalid&am=123.45&cu=INR', NULL, NULL, 30
  );

  PERFORM public.billing_submit_customer_utr(attempt_row.id, workspace, '000000123456');

  INSERT INTO public.payment_provider_events
    (provider, event_id, payment_attempt_id, payload_sha256, payload)
  VALUES
    ('synthetic', 'unverified-event-' || demo_owner::text, attempt_row.id, repeat('0', 64),
     '{"status":"paid","verified":false}'::jsonb);

  PERFORM public.billing_reconcile();

  IF NOT EXISTS (
    SELECT 1
    FROM public.payment_attempts p
    JOIN public.invoices i ON i.id = p.invoice_id
    JOIN public.subscriptions s ON s.id = i.subscription_id
    WHERE p.id = attempt_row.id AND p.customer_utr = '000000123456'
      AND p.status = 'pending_verification' AND i.status = 'open'
      AND s.status = 'pending_payment'
  ) OR EXISTS (SELECT 1 FROM public.billing_ledger WHERE invoice_id = invoice_row.id) THEN
    RAISE EXCEPTION 'An unverified claim changed billing state';
  END IF;

  IF pg_catalog.has_function_privilege('authenticated',
    'public.billing_settle_payment(uuid,text,bigint,text,text,timestamptz,uuid,text,text)', 'EXECUTE')
    OR pg_catalog.has_function_privilege('anon',
    'public.billing_settle_payment(uuid,text,bigint,text,text,timestamptz,uuid,text,text)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'Settlement is callable by a client role';
  END IF;

  SELECT public.billing_settle_payment(
    attempt_row.id, '000000123456', 12345, 'INR', 'SYNTHETIC-ACCOUNT',
    now() - interval '10 minutes', demo_operator, 'operator@example.invalid',
    'Synthetic bank-statement verification'
  ) INTO proof;

  IF proof->>'subscription_status' IS DISTINCT FROM 'active' OR NOT EXISTS (
    SELECT 1
    FROM public.payment_attempts p
    JOIN public.invoices i ON i.id = p.invoice_id
    JOIN public.subscriptions s ON s.id = i.subscription_id
    JOIN public.billing_ledger l ON l.invoice_id = i.id
    JOIN public.billing_audit_log a ON a.target_id = p.id::text
    WHERE p.id = attempt_row.id AND p.status = 'verified' AND p.verified_by = demo_operator
      AND i.status = 'paid' AND s.status = 'active' AND s.plan_id = test_plan
      AND l.entry_type = 'settlement' AND l.amount_minor = 12345
      AND a.action = 'payment.settled' AND a.actor_user_id = demo_operator
  ) THEN
    RAISE EXCEPTION 'Authorized verification did not settle, audit and activate the subscription';
  END IF;
END $$;

ROLLBACK;
