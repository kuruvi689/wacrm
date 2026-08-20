'use client'

import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'
import {
  CheckCircle2,
  Building2,
  MessageSquare,
  Send,
  Loader2,
  ShieldCheck,
  Smartphone,
  ExternalLink,
  Code2,
  Layers,
  ArrowRight,
  RefreshCw,
} from 'lucide-react'

import { useAuth } from '@/hooks/use-auth'
import { isPlatformAdmin } from '@/lib/auth/isPlatformAdmin'

interface PageProps {
  params: Promise<{ orgId: string }>
}

declare global {
  interface Window {
    FB: any
    fbAsyncInit: () => void
  }
}

export default function OnboardingOrgPage({ params }: PageProps) {
  const resolvedParams = use(params)
  const orgId = resolvedParams.orgId
  const router = useRouter()
  const { user } = useAuth()

  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(1)
  const [loading, setLoading] = useState(false)
  const [fbSdkLoaded, setFbSdkLoaded] = useState(false)

  // Connection Data
  const [connectionData, setConnectionData] = useState<{
    waba_id: string
    phone_number_id: string
    display_phone_number: string
    templates: any[]
  } | null>(null)

  // Manual fallback state
  const [showManualFallback, setShowManualFallback] = useState(false)
  const [manualToken, setManualToken] = useState('')
  const [manualWabaId, setManualWabaId] = useState('')
  const [manualPhoneId, setManualPhoneId] = useState('')
  const [manualDisplayPhone, setManualDisplayPhone] = useState('')

  // Test Message State
  const [testRecipientPhone, setTestRecipientPhone] = useState('')
  const [selectedTemplate, setSelectedTemplate] = useState('')
  const [testMessageResult, setTestMessageResult] = useState<any>(null)
  const [sendingTest, setSendingTest] = useState(false)

  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Load Facebook JS SDK dynamically
  useEffect(() => {
    if (window.FB) {
      setFbSdkLoaded(true)
      return
    }

    window.fbAsyncInit = function () {
      const appId = process.env.NEXT_PUBLIC_META_APP_ID || '2493797674357293'
      window.FB.init({
        appId,
        cookie: true,
        xfbml: true,
        version: 'v20.0',
      })
      setFbSdkLoaded(true)
    }

    const script = document.createElement('script')
    script.src = 'https://connect.facebook.net/en_US/sdk.js'
    script.async = true
    script.defer = true
    document.body.appendChild(script)
  }, [])

  // Check existing connection on mount
  useEffect(() => {
    fetchConnection()
  }, [orgId])

  async function fetchConnection() {
    try {
      const res = await fetch(`/api/onboarding/connection?org_id=${orgId}`)
      if (res.ok) {
        const data = await res.json()
        if (data.connected && data.connection) {
          setConnectionData({
            waba_id: data.connection.waba_id || '',
            phone_number_id: data.connection.phone_number_id || '',
            display_phone_number: data.connection.display_phone_number || '',
            templates: data.templates || [],
          })
          if (data.templates && data.templates.length > 0) {
            setSelectedTemplate(data.templates[0].name)
          }
          setCurrentStep(2)
        }
      }
    } catch (err) {
      console.error('Failed to fetch existing connection:', err)
    }
  }

  // Auto-detect returned code in query string (from direct OAuth redirect)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const urlParams = new URLSearchParams(window.location.search)
    const code = urlParams.get('code')
    if (code) {
      exchangeCode(code)
      const cleanUrl = window.location.protocol + '//' + window.location.host + window.location.pathname
      window.history.replaceState({ path: cleanUrl }, '', cleanUrl)
    }
  }, [])

  function launchDirectMetaOAuth() {
    const appId = process.env.NEXT_PUBLIC_META_APP_ID || '2493797674357293'
    const configId = process.env.NEXT_PUBLIC_META_CONFIG_ID || ''
    const ngrokUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://inadequately-unintroductive-maple.ngrok-free.dev'
    const currentOrigin = window.location.protocol === 'https:'
      ? window.location.origin
      : ngrokUrl
    const redirectUri = encodeURIComponent(`${currentOrigin}/onboarding/${orgId}`)
    const extras = encodeURIComponent(
      JSON.stringify({
        setup: { business: { type: 'waba' } },
        featureType: 'whatsapp_business_app_onboarding',
        sessionInfoVersion: '3',
      })
    )
    const oauthUrl = `https://www.facebook.com/v20.0/dialog/oauth?client_id=${appId}&config_id=${configId}&redirect_uri=${redirectUri}&response_type=code&override_default_response_type=true&extras=${extras}`

    window.location.href = oauthUrl
  }

  // Handle Meta Embedded Signup Trigger with HTTP fallback
  function handleConnectMeta() {
    setErrorMsg(null)
    setLoading(true)

    if (window.location.protocol === 'http:') {
      console.warn('[Meta Signup] HTTP protocol detected. Redirecting via Meta Direct OAuth...')
      launchDirectMetaOAuth()
      return
    }

    const configId = process.env.NEXT_PUBLIC_META_CONFIG_ID

    if (!window.FB) {
      launchDirectMetaOAuth()
      return
    }

    try {
      window.FB.login(
        (response: any) => {
          if (response.authResponse?.code) {
            exchangeCode(response.authResponse.code)
          } else {
            setLoading(false)
            setErrorMsg('Facebook authentication canceled or failed.')
          }
        },
        {
          config_id: configId,
          response_type: 'code',
          override_default_response_type: true,
          extras: {
            setup: {
              business: { type: 'waba' },
            },
            featureType: 'whatsapp_business_app_onboarding',
            sessionInfoVersion: '3',
          },
        }
      )
    } catch (err) {
      console.warn('[FB.login] Exception caught, launching direct OAuth fallback:', err)
      launchDirectMetaOAuth()
    }
  }

  async function exchangeCode(code: string) {
    try {
      const res = await fetch('/api/onboarding/embedded-signup/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          org_id: orgId,
        }),
      })

      const data = await res.json()
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Embedded signup exchange failed')
      }

      // Fetch refreshed templates and connection state
      await fetchConnection()
      setCurrentStep(2)
    } catch (err: any) {
      setErrorMsg(err.message)
    } finally {
      setLoading(false)
    }
  }

  // Handle Manual Fallback Token Save
  async function handleSaveManualConnection(e: React.FormEvent) {
    e.preventDefault()
    setErrorMsg(null)
    setLoading(true)

    try {
      const res = await fetch('/api/onboarding/embedded-signup/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_id: orgId,
          manual_access_token: manualToken,
          waba_id: manualWabaId,
          phone_number_id: manualPhoneId,
          display_phone_number: manualDisplayPhone,
        }),
      })

      const data = await res.json()
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to save manual connection')
      }

      await fetchConnection()
      setCurrentStep(2)
    } catch (err: any) {
      setErrorMsg(err.message)
    } finally {
      setLoading(false)
    }
  }

  // Handle Sending Test Message
  async function handleSendTestMessage(e: React.FormEvent) {
    e.preventDefault()
    if (!testRecipientPhone) {
      setErrorMsg('Please enter a recipient phone number')
      return
    }

    setSendingTest(true)
    setErrorMsg(null)
    setTestMessageResult(null)

    try {
      const res = await fetch('/api/onboarding/test-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_id: orgId,
          phone_number_id: connectionData?.phone_number_id,
          recipient_phone: testRecipientPhone,
          template_name: selectedTemplate || 'hello_world',
          language_code: 'en_US',
        }),
      })

      const data = await res.json()
      setTestMessageResult(data)
      if (!res.ok || !data.success) {
        setErrorMsg(data.error || 'Failed to send test message')
      }
    } catch (err: any) {
      setErrorMsg(err.message)
    } finally {
      setSendingTest(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-12">
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Header */}
        <div className="text-center space-y-3">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-semibold uppercase tracking-wider">
            <ShieldCheck className="w-4 h-4" /> Multi-Tenant SaaS Onboarding
          </div>
          <h1 className="text-3xl md:text-4xl font-extrabold bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-transparent">
            WhatsApp Business API Connection
          </h1>
          <p className="text-slate-400 max-w-xl mx-auto text-sm md:text-base">
            Connect your own Meta WhatsApp Business Account (WABA) using Meta Embedded Signup or permanent developer credentials.
          </p>
        </div>

        {/* Progress Stepper */}
        <div className="grid grid-cols-3 gap-2 p-1 bg-slate-900/80 border border-slate-800 rounded-xl">
          <button
            onClick={() => setCurrentStep(1)}
            className={`flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-semibold transition-all ${
              currentStep === 1
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/25'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Building2 className="w-4 h-4" />
            1. Embedded Signup
          </button>

          <button
            onClick={() => connectionData && setCurrentStep(2)}
            disabled={!connectionData}
            className={`flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-semibold transition-all ${
              currentStep === 2
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/25'
                : 'text-slate-400 hover:text-white disabled:opacity-40'
            }`}
          >
            <Smartphone className="w-4 h-4" />
            2. Account Details
          </button>

          <button
            onClick={() => connectionData && setCurrentStep(3)}
            disabled={!connectionData}
            className={`flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-semibold transition-all ${
              currentStep === 3
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/25'
                : 'text-slate-400 hover:text-white disabled:opacity-40'
            }`}
          >
            <Send className="w-4 h-4" />
            3. Test Message
          </button>
        </div>

        {/* Error Alert */}
        {errorMsg && (
          <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm flex items-center gap-3">
            <span className="font-bold">Error:</span> {errorMsg}
          </div>
        )}

        {/* STEP 1: Embedded Signup / Manual Token Fallback */}
        {currentStep === 1 && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 md:p-8 space-y-6 shadow-2xl">
            <div className="space-y-2">
              <h2 className="text-xl font-bold flex items-center gap-2 text-white">
                <Building2 className="w-5 h-5 text-blue-400" />
                Connect Your WhatsApp Business Account
              </h2>
              <p className="text-slate-400 text-sm">
                Authenticate with Facebook to register your phone number, WABA ID, and grant messaging permissions to wacrm.
              </p>
            </div>

            <div className="p-6 rounded-xl bg-slate-950/60 border border-slate-800 flex flex-col items-center justify-center text-center space-y-4">
              <div className="w-16 h-16 rounded-full bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
                <MessageSquare className="w-8 h-8" />
              </div>

              <div className="space-y-1 max-w-md">
                <h3 className="font-semibold text-white">Meta Embedded Signup</h3>
                <p className="text-xs text-slate-400">
                  Launches Facebook OAuth popup window for instant tenant onboarding.
                </p>
              </div>

              <button
                onClick={handleConnectMeta}
                disabled={loading || !fbSdkLoaded}
                className="w-full max-w-sm py-3.5 px-6 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-lg shadow-blue-500/20 transition-all disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> Exchanging Auth Code...
                  </>
                ) : (
                  <>
                    <ExternalLink className="w-4 h-4" /> Connect with Facebook
                  </>
                )}
              </button>
            </div>

            {/* Manual Fallback Accordion for Platform Admin Only */}
            {isPlatformAdmin(user?.email) && (
              <div className="border-t border-slate-800 pt-6">
                <button
                  onClick={() => setShowManualFallback(!showManualFallback)}
                  className="text-xs font-semibold text-amber-400 hover:text-amber-300 flex items-center gap-2 transition-colors"
                >
                  <Code2 className="w-4 h-4" />
                  {showManualFallback ? 'Hide Manual Token Fallback (Platform Admin Only)' : 'Show Manual Token Fallback (Platform Admin Only)'}
                </button>

              {showManualFallback && (
                <form onSubmit={handleSaveManualConnection} className="mt-4 space-y-4 bg-slate-950 p-4 rounded-xl border border-slate-800 text-xs">
                  <div className="space-y-1">
                    <label className="text-slate-300 font-medium">Permanent Access Token (System User Token)</label>
                    <input
                      type="password"
                      required
                      value={manualToken}
                      onChange={(e) => setManualToken(e.target.value)}
                      placeholder="EAAG..."
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-slate-300 font-medium">Phone Number ID</label>
                      <input
                        type="text"
                        required
                        value={manualPhoneId}
                        onChange={(e) => setManualPhoneId(e.target.value)}
                        placeholder="100654321..."
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-blue-500"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-slate-300 font-medium">WABA ID (Optional)</label>
                      <input
                        type="text"
                        value={manualWabaId}
                        onChange={(e) => setManualWabaId(e.target.value)}
                        placeholder="109876543..."
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-blue-500"
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-slate-300 font-medium">Display Phone Number (Optional)</label>
                    <input
                      type="text"
                      value={manualDisplayPhone}
                      onChange={(e) => setManualDisplayPhone(e.target.value)}
                      placeholder="+1 555-0199"
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save Manual Connection'}
                  </button>
                </form>
              )}
            </div>
            )}
          </div>
        )}

        {/* STEP 2: Connection Details & Template Inspector */}
        {currentStep === 2 && connectionData && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 md:p-8 space-y-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div className="space-y-1">
                <h2 className="text-xl font-bold flex items-center gap-2 text-white">
                  <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                  Account Connected & Verified
                </h2>
                <p className="text-slate-400 text-sm">
                  Proves <span className="text-blue-400 font-semibold">whatsapp_business_management</span> permission access.
                </p>
              </div>

              <button
                onClick={fetchConnection}
                className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                title="Refresh Connection"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div className="p-4 bg-slate-950 rounded-xl border border-slate-800 space-y-1">
                <span className="text-slate-400 font-medium">Display Phone Number</span>
                <p className="text-base font-bold text-emerald-400">
                  {connectionData.display_phone_number || 'Connected'}
                </p>
              </div>
              <div className="p-4 bg-slate-950 rounded-xl border border-slate-800 space-y-1">
                <span className="text-slate-400 font-medium">Phone Number ID</span>
                <p className="text-sm font-mono text-slate-200">{connectionData.phone_number_id}</p>
              </div>
              <div className="p-4 bg-slate-950 rounded-xl border border-slate-800 space-y-1">
                <span className="text-slate-400 font-medium">WABA ID</span>
                <p className="text-sm font-mono text-slate-200">{connectionData.waba_id || 'N/A'}</p>
              </div>
              <div className="p-4 bg-slate-950 rounded-xl border border-slate-800 space-y-1">
                <span className="text-slate-400 font-medium">Fetched Templates Count</span>
                <p className="text-base font-bold text-blue-400">{connectionData.templates.length}</p>
              </div>
            </div>

            {/* Templates Inspector */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                <Layers className="w-4 h-4 text-purple-400" />
                Available WABA Message Templates ({connectionData.templates.length})
              </h3>

              {connectionData.templates.length === 0 ? (
                <p className="text-xs text-slate-400 italic p-4 bg-slate-950 rounded-xl border border-slate-800">
                  No custom templates found. Defaulting to &quot;hello_world&quot; template.
                </p>
              ) : (
                <div className="max-h-48 overflow-y-auto space-y-2 pr-1">
                  {connectionData.templates.map((tpl: any, idx: number) => (
                    <div
                      key={idx}
                      className="p-3 bg-slate-950 border border-slate-800 rounded-lg flex items-center justify-between text-xs"
                    >
                      <div className="space-y-0.5">
                        <span className="font-semibold text-slate-200">{tpl.name}</span>
                        <p className="text-slate-400 text-[10px]">
                          Lang: {tpl.language} | Status: <span className="text-emerald-400">{tpl.status}</span>
                        </p>
                      </div>
                      <span className="px-2 py-0.5 bg-slate-800 text-slate-400 text-[10px] rounded uppercase font-mono">
                        {tpl.category}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end pt-4 border-t border-slate-800">
              <button
                onClick={() => setCurrentStep(3)}
                className="py-2.5 px-6 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm flex items-center gap-2 transition-all shadow-lg shadow-blue-500/20"
              >
                Proceed to Test Message <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* STEP 3: Test Message Dispatch */}
        {currentStep === 3 && connectionData && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 md:p-8 space-y-6 shadow-2xl">
            <div className="space-y-1 border-b border-slate-800 pb-4">
              <h2 className="text-xl font-bold flex items-center gap-2 text-white">
                <Send className="w-5 h-5 text-blue-400" />
                Send Test Template Message
              </h2>
              <p className="text-slate-400 text-sm">
                Proves <span className="text-blue-400 font-semibold">whatsapp_business_messaging</span> permission access.
              </p>
            </div>

            <form onSubmit={handleSendTestMessage} className="space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">Recipient Phone Number (with Country Code)</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. 15550199 or 919876543210"
                  value={testRecipientPhone}
                  onChange={(e) => setTestRecipientPhone(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">Select Approved Template</label>
                <select
                  value={selectedTemplate}
                  onChange={(e) => setSelectedTemplate(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                >
                  <option value="hello_world">hello_world (Default Meta Template)</option>
                  {connectionData.templates.map((tpl: any, idx: number) => (
                    <option key={idx} value={tpl.name}>
                      {tpl.name} ({tpl.language})
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="submit"
                disabled={sendingTest}
                className="w-full py-3.5 rounded-xl bg-gradient-to-r from-blue-600 to-emerald-600 hover:from-blue-500 hover:to-emerald-500 text-white font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 transition-all disabled:opacity-50"
              >
                {sendingTest ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> Dispatching Message...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" /> Send Approved Template Message
                  </>
                )}
              </button>
            </form>

            {/* Test Message Result Output */}
            {testMessageResult && (
              <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-200">Dispatch Status:</span>
                  <span
                    className={`px-2 py-0.5 rounded font-bold uppercase ${
                      testMessageResult.success ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                    }`}
                  >
                    {testMessageResult.success ? 'Delivered / Accepted' : 'Failed'}
                  </span>
                </div>

                {testMessageResult.wamid && (
                  <p className="text-slate-400">
                    WAMID: <span className="font-mono text-slate-200">{testMessageResult.wamid}</span>
                  </p>
                )}

                <div className="space-y-1">
                  <span className="text-slate-400">Raw Meta Response:</span>
                  <pre className="p-2.5 bg-slate-900 rounded border border-slate-800 text-[10px] text-emerald-300 font-mono overflow-x-auto">
                    {JSON.stringify(testMessageResult, null, 2)}
                  </pre>
                </div>
              </div>
            )}

            <div className="pt-4 border-t border-slate-800 flex justify-between items-center">
              <button
                onClick={() => setCurrentStep(2)}
                className="text-xs font-medium text-slate-400 hover:text-slate-200 transition-colors"
              >
                Back to Connection Details
              </button>

              <button
                onClick={() => router.push(`/dashboard?org_id=${orgId}`)}
                className="py-2.5 px-6 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold text-sm flex items-center gap-2 transition-colors"
              >
                Go to Workspace Dashboard <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
