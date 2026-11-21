# WACRM client onboarding

Date: 2026-11-21
Branch: `feat/production-release-candidate`
Audience: the person setting up a new client account, and the client owner.

Support contact: **[SUPPORT_CONTACT, to be filled in by the founder]**

Items marked **unverified** could not be confirmed from the repo. Where a feature is not yet on production, this guide says so. Check `docs/PRODUCTION_GAPS.md` before promising anything to a client.

---

## 1. Before the call

Collect these from the client. Do not ask for passwords, tokens or card numbers.

| Item | Why | Who provides |
|---|---|---|
| Meta Business account (Business Manager) | WhatsApp is connected through it. | Client |
| Admin access to that Business Manager | The connection is approved by an admin. | Client |
| WhatsApp Business phone number | The number customers will message. | Client |
| The number must not already be in use on the WhatsApp or WhatsApp Business app | Meta requires the number to be freed from the consumer app before connecting. Requirement **unverified**; confirm with current Meta guidance. | Client |
| Display name for the number | Shown to customers; Meta must approve it. | Client |
| A payment method in Meta | Meta charges per conversation. | Client |
| Client's own AI provider key (OpenAI or Anthropic), if using AI replies | AI charges are billed by that provider to the client. | Client |
| Company name and email for the owner login | Creates the account. | Client |

Explain up front: **WhatsApp conversation fees are billed by Meta** to the client's Meta payment method. **AI usage is billed by the AI provider** against the client's own key. **The WACRM subscription is separate** and is paid by UPI (section 8).

---

## 2. Create the account and sign in

| Step | Action | Check |
|---|---|---|
| 1 | The owner opens the sign-up page and signs up with email, or with Continue with Google. | Account created and signed in. |
| 2 | Confirm the email if asked. If no email arrives, see section 9. | Signed in to the dashboard. |
| 3 | Complete onboarding in the dashboard. The account is created with the plan and limits set by the operator. | Onboarding finished. |
| 4 | Confirm the company name in account settings. | Name is correct. |
| 5 | Operator: confirm the account is listed in the console and its subscription state is what was agreed (trial or pending payment). | Matches the agreement. |

Password reset is not yet self-service (no reset page, OPS-11). If the owner forgets the password, the operator follows OPERATIONS_RUNBOOK section 5.2.

---

## 3. Connect WhatsApp

Use the **Connect WhatsApp** button in the dashboard. It starts Meta's Embedded Signup flow.

| Step | Action | Check |
|---|---|---|
| 1 | The owner clicks Connect WhatsApp. Which roles may connect is **unverified**; assume the owner. | Meta sign-in window opens. |
| 2 | Log in to Meta **yourself** and select the Business Manager. Pick or create the WhatsApp Business account and the phone number. | Meta confirms the number. |
| 3 | Finish the Meta steps: display name, and any verification code Meta sends to the number. Whoever holds the phone enters the code. | Meta reports success. |
| 4 | Return to the dashboard. The number shows as connected. | Connected number shown. |
| 5 | Send one test message from the number to a test phone, and reply from that phone. | Outbound is delivered; reply appears once in the inbox. |

Notes:
- Do not paste tokens, codes or the Meta app secret into chat or into any support ticket.
- If connection fails, check the Meta message in the window, then the troubleshooting list in section 10.
- The Meta webhook is `/api/whatsapp/webhook` on the production domain. Meta sends inbound messages there. The client does not configure it by hand.
- Meta retries are deduplicated on this branch by `claim_inbound_message` (migration 040, WA-01 fixed). Still ask the client to report any double replies.

---

## 4. Team and roles

Roles, highest first: **owner, admin, agent, viewer.**

| Role | Intended permissions |
|---|---|
| Owner | Everything, including billing contact and removing members. |
| Admin | Manage members, settings and templates. |
| Agent | Work in the inbox, send messages, use AI tools. |
| Viewer | Read only. |

Invite people through the dashboard invitation link. The invitee signs up or signs in with the invited email and accepts.

**Viewers cannot send.** On this branch, send and react need the agent role, and broadcast and templates need admin (`src/lib/whatsapp/role-gate.ts`, SEC-01 fixed). Production gets this when the release is deployed. Give the agent role only to people you trust to message customers.

Also note:
- All members of an account can read every conversation (TEN-07). Tell the client if they need some chats hidden from some staff.
- Give the owner role to one or two people only.

---

## 5. Inbox basics

| Topic | What to tell the client |
|---|---|
| Assigning a chat | Assigning a conversation to a human stops AI replies for that chat. |
| Notes | Internal notes on contacts are not sent to customers. |
| Tags and pipelines | Set up tags and pipeline stages before importing contacts, so the first import is clean. |
| Importing contacts | Contacts are de-duplicated by phone number. Check a small batch first. |
| Quick replies | Save common replies to speed up agents. |

---

## 6. AI agent setup

The AI agent answers WhatsApp messages automatically when it is switched on. Set it up in this order.

| Step | Action | Check |
|---|---|---|
| 1 | Choose the provider (OpenAI or Anthropic) and enter the client's **own** key in AI settings. The key is stored encrypted and is never shown back in the browser. | Key saved; field shows it is set, not the value. |
| 2 | Choose a model and write the system prompt: the business, what to answer, what to hand off, and the tone. Keep it plain. | Prompt saved. |
| 3 | Add knowledge: product or FAQ documents. Keep each document modest in size. Large uploads are processed inside the request and can time out (AI-08). | Documents listed with status. |
| 4 | Use the **playground** to test 10 to 20 realistic questions, including ones it should refuse or hand off. The playground runs for inactive agents and is not yet counted against quotas (AI-03). | Answers are correct and on-brand. |
| 5 | Set the per-conversation reply limit (default 3). Explain it to the client. | Limit set. |
| 6 | Only then switch the agent on. | Agent active. |

Things the client must know before switching on:
- **Automations win over AI.** If an active automation triggers on every new message or on a keyword, AI replies go silent (AI-05). Check the automations list first.
- **A handoff stops AI.** When the AI hands off, or a person takes the chat, the AI stops for that conversation until a person resumes it.
- **AI can fail silently.** If the AI provider errors or times out, the customer gets no reply and no handoff (AI-01). Staff must check the inbox daily.
- **AI does not check the 24-hour window or suspension in the server** (WA-07, TEN-02). Use the UI and the operator's suspension steps (OPERATIONS_RUNBOOK 3.4).
- **Only one active agent per account** on production today. Named multiple agents with version history arrive with migration 044 (on this branch; not on prod until deployed).

---

## 7. Messaging rules: STOP, START and the 24-hour window

### 7.1 Opt-out keywords

| Customer sends | Result (on releases that include the keyword handling) |
|---|---|
| `STOP` or `UNSUBSCRIBE` (exact word, any capitals) | Contact is marked opted out of marketing messages. Broadcasts and marketing sends are blocked. |
| `START` or `SUBSCRIBE` | Opt-out is cleared. |

Notes:
- The match is exact. `please stop` is not treated as an opt-out.
- These fields are in migration 042, which is on this branch and not on production until deployed. Confirm the release status before telling a client this works.
- Staff must still respect opt-outs by hand in conversations that are not broadcasts. The rule for "service" replies is not built (unverified).

### 7.2 The 24-hour window

WhatsApp allows free-form messages only within 24 hours after the customer last wrote. After that, the business can send only an **approved template**.

| Situation | What staff do |
|---|---|
| Customer wrote within 24 hours | Reply normally. |
| More than 24 hours since the customer wrote | Send an approved template. Free text will fail with error 131047. |
| Templates | Create in the templates page, submit to Meta, wait for approval. Templates are not sent until approved. |

The window is checked in the UI only today (WA-07). Do not work around the UI, for example by calling the API directly.

---

## 8. Billing

The billing UI is in progress in this release candidate. The steps below describe the intended flow; confirm the screens before the client call.

### 8.1 Plans

- Plans and prices are set by the founder. No prices are fixed in the product. Quote the prices from the signed agreement only.
- Each plan sets limits (members, contacts, AI responses, and similar). Limits shown in the app are the ones the operator set.
- A free trial may be given by the operator. The trial end date is shown in the account.

### 8.2 How a subscription is paid (UPI, manual)

WACRM is paid by UPI directly to the business's bank account. There is no automatic card or UPI debit yet. Renewal is manual each period.

| Step | Owner does | Operator does |
|---|---|---|
| 1 | Chooses a plan in the billing page and starts checkout. | Nothing yet. |
| 2 | Pays the exact amount shown by UPI, using the link or UPI ID in the checkout screen. | Nothing yet. |
| 3 | Enters the **UTR** (the bank's transaction reference) shown in their payment app or bank. | Receives the claim. A UTR entered by the customer is only a claim. |
| 4 | Waits. | Logs in to the bank portal and checks the exact amount, UTR, date and receiving account (OPERATIONS_RUNBOOK 3.1). |
| 5 | Waits. | Verifies and settles. The plan activates. Usually within working hours. |
| 6 | Checks the plan and invoice show as paid. | Confirms with the owner. |

Important for the client:
- Pay the **exact** amount. Under- or over-payments are checked by hand and can delay activation.
- Do not pay to a personal UPI ID or account. Use only the details shown in checkout.
- A screenshot, an SMS or a payment app success page does not activate the plan. Only verification does.
- Keep the UTR and payment receipt.
- Renewal is manual: the owner pays again at each period. Reminders are **unverified** in this release.

### 8.3 Refunds, cancellation and changes

- Cancellation runs to the end of the paid period, then the account moves to read and export mode. The owner can renew later.
- Refunds go back through the bank. Operators record them. A refund does not change the plan by itself.
- Upgrades and downgrades: the proration rule is a founder decision (`BILLING_PRORATION_POLICY`). Confirm the rule in the agreement before the client changes plan.
- GST and tax treatment is **not built**. Confirm with the founder before quoting tax-inclusive prices.

### 8.4 What the client pays separately

| Charge | Paid to | Set up where |
|---|---|---|
| WACRM subscription | WACRM, by UPI (above) | WACRM billing page |
| WhatsApp conversation fees | Meta | Meta Business Manager payment method |
| AI usage | AI provider (OpenAI or Anthropic) | The client's own provider account and key |

---

## 9. Email and login problems

| Problem | Action |
|---|---|
| Sign-up or invite email not received | Default email only reaches team members and has low limits (OPS-10). Ask the operator to check the email provider settings; use another address for now. |
| Password forgotten | No self-service reset yet (OPS-11). Operator follows OPERATIONS_RUNBOOK 5.2. |
| Google sign-in fails | Try email sign-in. Report the time to support. |

---

## 10. Troubleshooting for the first week

| Symptom | First check | Next step |
|---|---|---|
| Message not delivered | Error shown on the message (for example 131047 or 131026) | 131047: send an approved template (section 7.2). 131026: check the customer's number. Report others to support. |
| Connect WhatsApp did not finish | Did Meta show success? Were the Business Manager and number correct? | Retry once. If it still fails, support. Do not share codes. |
| Messages sent to a wrong or old number | Check the connected number in settings | Support. |
| Replies not coming from the AI | Is the agent active? Is an automation or a human taking the chat? Is the reply limit reached? | Section 6 checks. Support if the provider errors. |
| A customer's replies are doubled | Dedup is on this branch (WA-01 fixed); check whether it is deployed | Tell support the time and customer. |
| Access token error (190) | Reconnect WhatsApp through Embedded Signup | Section 3. The owner does it. |
| Billing shows unpaid after paying | Did you enter the UTR and pay the exact amount? | Keep the receipt; contact support with the UTR and the time. |

---

## 11. Handover checklist

Tick each item before you close the onboarding call.

| # | Item | Done |
|---|---|---|
| 1 | Account created; owner can sign in | |
| 2 | WhatsApp connected; test message sent and replied to | |
| 3 | Team invited with correct roles (roles per section 4) | |
| 4 | Tags, pipeline stages and quick replies set up | |
| 5 | AI agent tested in the playground; switched on only if the client agreed | |
| 6 | Automations checked for conflicts with AI | |
| 7 | Client knows the 24-hour window and templates | |
| 8 | Client knows how to read and send opt-out keywords | |
| 9 | Subscription plan agreed in writing; first UPI payment instructions given | |
| 10 | Support contact given to the owner | |
| 11 | Operator has logged the onboarding in the operations log | |
