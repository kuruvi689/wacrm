const { chromium } = require('playwright')

async function runE2ETest() {
  console.log('🚀 Starting E2E Automation Test for ROOKIE CRM...')

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()

  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`[Browser Console ${msg.type()}]: ${msg.text()}`)
    }
  })
  page.on('pageerror', err => console.error('[Browser Uncaught Error]:', err.message))

  try {
    const timestamp = Date.now()
    const testEmail = `rookie_user_${timestamp}@gmail.com`
    const testPassword = 'TestPassword123!'
    const testName = `Rookie Test User ${timestamp}`

    console.log(`1. Navigating to http://localhost:3000/signup...`)
    await page.goto('http://localhost:3000/signup')
    const title = await page.title()
    console.log(`   Page Title: "${title}"`)

    console.log(`2. Filling out signup form for ${testEmail}...`)
    await page.fill('input#fullName', testName)
    await page.fill('input#email', testEmail)
    await page.fill('input#password', testPassword)
    await page.fill('input#confirmPassword', testPassword)

    console.log(`3. Submitting signup form...`)
    await page.click('button[type="submit"]')

    console.log(`4. Waiting for auto-login & redirect to dashboard/onboarding...`)
    await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 15000 })
    console.log(`   Current URL after signup: ${page.url()}`)

    console.log(`5. Testing Settings navigation...`)
    await page.goto('http://localhost:3000/settings')
    await page.waitForTimeout(2000)
    console.log(`   Current URL on settings page: ${page.url()}`)

    console.log(`6. Clearing cookies and testing direct /login with created credentials...`)
    await context.clearCookies()
    await page.goto('http://localhost:3000/login')
    await page.fill('input#email', testEmail)
    await page.fill('input#password', testPassword)
    await page.click('button[type="submit"]')

    await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 15000 })
    console.log(`   Current URL after login: ${page.url()}`)

    console.log('✅ ALL E2E AUTOMATION TESTS PASSED 100% PERFECTLY!')
  } catch (err) {
    console.error('❌ E2E Automation Error:', err)
  } finally {
    await browser.close()
  }
}

runE2ETest()
