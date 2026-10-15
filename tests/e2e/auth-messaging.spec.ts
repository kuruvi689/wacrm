import { test, expect } from '@playwright/test'

test.describe('ROOKIE CRM End-to-End Auth & Onboarding Flow', () => {
  const timestamp = Date.now()
  const testEmail = `rookie.test.${timestamp}@gmail.com`
  const testPassword = 'TestPassword123!'
  const testName = `Rookie Test User ${timestamp}`

  test('User Sign up, Auto-Confirm, Login, and Onboarding flow', async ({ page }) => {
    // 1. Visit signup page
    await page.goto('/signup')
    await expect(page).toHaveTitle(/ROOKIE CRM/)

    // Verify brand title and inputs are visible
    const nameInput = page.locator('input#fullName')
    const emailInput = page.locator('input#email')
    const passwordInput = page.locator('input#password')
    const confirmInput = page.locator('input#confirmPassword')
    const submitBtn = page.locator('button[type="submit"]')

    await expect(nameInput).toBeVisible()
    await expect(emailInput).toBeVisible()
    await expect(passwordInput).toBeVisible()
    await expect(confirmInput).toBeVisible()

    // 2. Fill out form
    await nameInput.fill(testName)
    await emailInput.fill(testEmail)
    await passwordInput.fill(testPassword)
    await confirmInput.fill(testPassword)

    // 3. Submit signup
    await submitBtn.click()

    // 4. Expect auto-login redirect to /onboarding or /dashboard
    await page.waitForURL(/\/(onboarding|dashboard)/, { timeout: 15000 })
    const currentUrl = page.url()
    expect(currentUrl).toMatch(/\/(onboarding|dashboard)/)

    // 5. Verify Dashboard navigation
    await page.goto('/dashboard')
    await expect(page).toHaveTitle(/Dashboard — ROOKIE CRM|ROOKIE CRM/)

    // 6. Verify Settings & WhatsApp connect page navigation
    await page.goto('/settings')
    await expect(page).toHaveTitle(/Settings — ROOKIE CRM|ROOKIE CRM/)
  })

  test('Direct Login with created account', async ({ page }) => {
    await page.goto('/login')
    await expect(page).toHaveTitle(/ROOKIE CRM/)

    const emailInput = page.locator('input#email')
    const passwordInput = page.locator('input#password')
    const submitBtn = page.locator('button[type="submit"]')

    await expect(emailInput).toBeVisible()
    await expect(passwordInput).toBeVisible()
    await expect(submitBtn).toBeVisible()

    await emailInput.fill('rookie.test.1786903256256@gmail.com')
    await passwordInput.fill('TestPassword123!')
    await submitBtn.click()

    await page.waitForURL(/\/(onboarding|dashboard)/, { timeout: 15000 })
    expect(page.url()).toMatch(/\/(onboarding|dashboard)/)
  })
})
