# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: auth-messaging.spec.ts >> ROOKIE CRM End-to-End Auth & Onboarding Flow >> User Sign up, Auto-Confirm, Login, and Onboarding flow
- Location: tests\e2e\auth-messaging.spec.ts:9:7

# Error details

```
TimeoutError: page.waitForURL: Timeout 15000ms exceeded.
=========================== logs ===========================
waiting for navigation until "load"
============================================================
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e3]:
    - generic [ref=e4]:
      - generic [ref=e10]: Create account
      - generic [ref=e11]: Get started with ROOKIE CRM
    - generic [ref=e12]:
      - generic [ref=e13]:
        - generic [ref=e14]: email rate limit exceeded
        - generic [ref=e15]:
          - generic [ref=e16]: Full name
          - textbox "Full name" [ref=e17]:
            - /placeholder: John Doe
            - text: Rookie Test User 1786903314343
        - generic [ref=e18]:
          - generic [ref=e19]: Email
          - textbox "Email" [ref=e20]:
            - /placeholder: you@example.com
            - text: rookie.test.1786903314343@gmail.com
        - generic [ref=e21]:
          - generic [ref=e22]: Password
          - textbox "Password" [ref=e23]:
            - /placeholder: At least 6 characters
            - text: TestPassword123!
        - generic [ref=e24]:
          - generic [ref=e25]: Confirm password
          - textbox "Confirm password" [ref=e26]:
            - /placeholder: Repeat your password
            - text: TestPassword123!
        - button "Sign up with Google" [ref=e27]
        - generic [ref=e28]: Or sign up with email
        - button "Create account" [ref=e33]
      - paragraph [ref=e34]:
        - text: Already have an account?
        - link "Sign in" [ref=e35] [cursor=pointer]:
          - /url: /login
  - region "Notifications alt+T"
  - button "Open Next.js Dev Tools" [ref=e41] [cursor=pointer]
  - alert [ref=e45]
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test'
  2  | 
  3  | test.describe('ROOKIE CRM End-to-End Auth & Onboarding Flow', () => {
  4  |   const timestamp = Date.now()
  5  |   const testEmail = `rookie.test.${timestamp}@gmail.com`
  6  |   const testPassword = 'TestPassword123!'
  7  |   const testName = `Rookie Test User ${timestamp}`
  8  | 
  9  |   test('User Sign up, Auto-Confirm, Login, and Onboarding flow', async ({ page }) => {
  10 |     // 1. Visit signup page
  11 |     await page.goto('/signup')
  12 |     await expect(page).toHaveTitle(/ROOKIE CRM/)
  13 | 
  14 |     // Verify brand title and inputs are visible
  15 |     const nameInput = page.locator('input#fullName')
  16 |     const emailInput = page.locator('input#email')
  17 |     const passwordInput = page.locator('input#password')
  18 |     const confirmInput = page.locator('input#confirmPassword')
  19 |     const submitBtn = page.locator('button[type="submit"]')
  20 | 
  21 |     await expect(nameInput).toBeVisible()
  22 |     await expect(emailInput).toBeVisible()
  23 |     await expect(passwordInput).toBeVisible()
  24 |     await expect(confirmInput).toBeVisible()
  25 | 
  26 |     // 2. Fill out form
  27 |     await nameInput.fill(testName)
  28 |     await emailInput.fill(testEmail)
  29 |     await passwordInput.fill(testPassword)
  30 |     await confirmInput.fill(testPassword)
  31 | 
  32 |     // 3. Submit signup
  33 |     await submitBtn.click()
  34 | 
  35 |     // 4. Expect auto-login redirect to /onboarding or /dashboard
> 36 |     await page.waitForURL(/\/(onboarding|dashboard)/, { timeout: 15000 })
     |                ^ TimeoutError: page.waitForURL: Timeout 15000ms exceeded.
  37 |     const currentUrl = page.url()
  38 |     expect(currentUrl).toMatch(/\/(onboarding|dashboard)/)
  39 | 
  40 |     // 5. Verify Dashboard navigation
  41 |     await page.goto('/dashboard')
  42 |     await expect(page).toHaveTitle(/Dashboard — ROOKIE CRM|ROOKIE CRM/)
  43 | 
  44 |     // 6. Verify Settings & WhatsApp connect page navigation
  45 |     await page.goto('/settings')
  46 |     await expect(page).toHaveTitle(/Settings — ROOKIE CRM|ROOKIE CRM/)
  47 |   })
  48 | 
  49 |   test('Direct Login with created account', async ({ page }) => {
  50 |     await page.goto('/login')
  51 |     await expect(page).toHaveTitle(/ROOKIE CRM/)
  52 | 
  53 |     const emailInput = page.locator('input#email')
  54 |     const passwordInput = page.locator('input#password')
  55 |     const submitBtn = page.locator('button[type="submit"]')
  56 | 
  57 |     await expect(emailInput).toBeVisible()
  58 |     await expect(passwordInput).toBeVisible()
  59 |     await expect(submitBtn).toBeVisible()
  60 | 
  61 |     await emailInput.fill('rookie.test.1786903256256@gmail.com')
  62 |     await passwordInput.fill('TestPassword123!')
  63 |     await submitBtn.click()
  64 | 
  65 |     await page.waitForURL(/\/(onboarding|dashboard)/, { timeout: 15000 })
  66 |     expect(page.url()).toMatch(/\/(onboarding|dashboard)/)
  67 |   })
  68 | })
  69 | 
```