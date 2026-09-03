'use client'

import { useState, useEffect } from 'react'
import {
  ShieldCheck,
  Building2,
  MessageSquare,
  Send,
  Loader2,
  ExternalLink,
  CheckCircle2,
  Layers,
  Code2,
  RefreshCw,
  AlertCircle,
  Copy,
} from 'lucide-react'

declare global {
  interface Window {
    FB: any
    fbAsyncInit: () => void
  }
}

export default function MetaAppReviewPage() {
  const [orgId, setOrgId] = useState<string>('review-meta-demo-org')
  const [loading, setLoading] = useState(false)
  const [fbSdkLoaded, setFbSdkLoaded] = useState(false)

  // Connection State
  const [connectedData, setConnectedData] = useState<{
    waba_id: string
    phone_number_id: string
    display_phone_number: string
    templates: any[]
  } | null>(null)

  // Manual fallback state
  const [showManualForm, setShowManualForm] = useState(false)
  const [manualToken, setManualToken] = useState('')
  const [manualPhoneId, setManualPhoneId] = useState('')
  const [manualWabaId, setManualWabaId] = useState('')

  // Test Message State
  const [recipientPhone, setRecipientPhone] = useState('')
  const [selectedTemplate, setSelectedTemplate] = useState('hello_world')
  const [sendingTest, setSendingTest] = useState(false)
  const [testResult, setTestResult] = useState<any>(null)

  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Load Meta Facebook SDK
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

  // Check connection on load
  useEffect(() => {
    checkConnection()
  }, [orgId])

  async function checkConnection() {
    try {
      const res = await fetch(`/api/onboarding/connection?org_id=${orgId}`)
      if (res.ok) {
        const data = await res.json()
        if (data.connected && data.connection) {
          setConnectedData({
            waba_id: data.connection.waba_id || '',
            phone_number_id: data.connection.phone_number_id || '',
            display_phone_number: data.connection.display_phone_number || '',
            templates: data.templates || [],
          })
          if (data.templates && data.templates.length > 0) {
            setSelectedTemplate(data.templates[0].name)
          }
        }
      }
    } catch (err) {
      console.error('Error fetching review connection:', err)
    }
  }

  // Auto-detect returned code in query string (from direct OAuth redirect)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const urlParams = new URLSearchParams(window.location.search)
    const code = urlParams.get('code')
    if (code) {
      handleCodeExchange(code)
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
    const redirectUri = encodeURIComponent(`${currentOrigin}/review`)
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

  // Handle FB Embedded Signup with HTTP fallback
  function triggerEmbeddedSignup() {
    setErrorMessage(null)
    setStatusMessage(null)
    setLoading(true)

    if (window.location.protocol === 'http:') {
      console.warn('[Meta Signup] HTTP protocol detected. Falling back to Meta Direct OAuth flow...')
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
            handleCodeExchange(response.authResponse.code)
          } else {
            setLoading(false)
            setErrorMessage('Embedded Signup authentication was canceled or closed.')
          }
        },
        {
          config_id: configId,
          response_type: 'code',
          override_default_response_type: true,
          extras: {
            setup: { business: { type: 'waba' } },
            featureType: 'whatsapp_business_app_onboarding',
            sessionInfoVersion: '3',
          },
        }
      )
    } catch (err) {
      console.warn('[FB.login] Exception caught, executing direct OAuth fallback:', err)
      launchDirectMetaOAuth()
    }
  }

  async function handleCodeExchange(code: string) {
    try {
      setStatusMessage('Exchanging OAuth authorization code with Meta Graph API...')
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
        throw new Error(data.error || 'Embedded Signup code exchange failed')
      }

      setStatusMessage('Embedded Signup successful! Connected WABA and subscribed apps.')
      await checkConnection()
    } catch (err: any) {
      setErrorMessage(err.message)
    } finally {
      setLoading(false)
    }
  }

  // Handle Manual Token Submission for Review Testing
  async function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErrorMessage(null)
    setStatusMessage(null)
    setLoading(true)

    try {
      const res = await fetch('/api/onboarding/embedded-signup/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_id: orgId,
          manual_access_token: manualToken,
          phone_number_id: manualPhoneId,
          waba_id: manualWabaId,
        }),
      })

      const data = await res.json()
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to connect using manual token')
      }

      setStatusMessage('Manual Developer Token saved & verified.')
      await checkConnection()
    } catch (err: any) {
      setErrorMessage(err.message)
    } finally {
      setLoading(false)
    }
  }

  // Handle Test Message Send (whatsapp_business_messaging proof)
  async function handleSendTestMessage(e: React.FormEvent) {
    e.preventDefault()
    if (!recipientPhone) {
      setErrorMessage('Please enter a recipient phone number (with country code)')
      return
    }

    setSendingTest(true)
    setErrorMessage(null)
    setTestResult(null)

    try {
      const res = await fetch('/api/onboarding/test-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_id: orgId,
          phone_number_id: connectedData?.phone_number_id,
          recipient_phone: recipientPhone,
          template_name: selectedTemplate || 'hello_world',
          language_code: 'en_US',
        }),
      })

      const data = await res.json()
      setTestResult(data)
      if (!res.ok || !data.success) {
        setErrorMessage(data.error || 'Test message dispatch failed')
      } else {
        setStatusMessage('Test message successfully sent via Meta Graph API!')
      }
    } catch (err: any) {
      setErrorMessage(err.message)
    } finally {
      setSendingTest(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-12 font-sans">
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Banner */}
        <div className="p-6 rounded-2xl bg-gradient-to-r from-blue-900/40 via-slate-900 to-indigo-900/40 border border-blue-500/30 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-blue-500/20 text-blue-400 text-xs font-bold uppercase tracking-wider">
              <ShieldCheck className="w-4 h-4" /> Meta App Review Portal
            </div>
            <h1 className="text-2xl md:text-3xl font-extrabold text-white">
              Tech Provider Integration Demo
            </h1>
            <p className="text-xs text-slate-300">
              Demonstrates Meta Embedded Signup onboarding and Granular Scopes: <code className="text-blue-300">whatsapp_business_management</code>, <code className="text-blue-300">whatsapp_business_messaging</code>, <code className="text-blue-300">business_management</code>.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={checkConnection}
              className="px-3 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Refresh Proofs
            </button>
          </div>
        </div>

        {/* Status / Error Alerts */}
        {statusMessage && (
          <div className="p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-emerald-400 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            <span>{statusMessage}</span>
          </div>
        )}

        {errorMessage && (
          <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* PROOF STEP 1: Embedded Signup Onboarding */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6 shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center gap-3">
              <span className="w-8 h-8 rounded-full bg-blue-600/20 text-blue-400 border border-blue-500/30 flex items-center justify-center font-bold text-sm">
                1
              </span>
              <div>
                <h2 className="font-bold text-base text-white">PROOF 1: Client Embedded Signup Onboarding</h2>
                <p className="text-xs text-slate-400">Client connects their own WABA via Meta Embedded Signup popup.</p>
              </div>
            </div>
            {connectedData && (
              <span className="px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-xs font-semibold flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" /> Account Connected
              </span>
            )}
          </div>

          <div className="p-6 bg-slate-950 rounded-xl border border-slate-800 flex flex-col items-center justify-center text-center space-y-4">
            <div className="w-14 h-14 rounded-full bg-blue-600/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
              <Building2 className="w-7 h-7" />
            </div>

            <div className="space-y-1 max-w-md">
              <h3 className="font-semibold text-sm text-white">Connect WhatsApp Business Account</h3>
              <p className="text-xs text-slate-400">
                Launches Meta Embedded Signup dialog to register WABA ID, Phone Number ID, and subscribe webhooks.
              </p>
            </div>

            <button
              onClick={triggerEmbeddedSignup}
              disabled={loading || !fbSdkLoaded}
              className="py-3 px-8 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold text-sm flex items-center gap-2 shadow-lg shadow-blue-500/20 transition-all disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Authenticating with Meta...
                </>
              ) : (
                <>
                  <ExternalLink className="w-4 h-4" /> Launch Embedded Signup
                </>
              )}
            </button>
          </div>

          {/* Manual Developer Fallback for Review Testing */}
          <div className="pt-2">
            <button
              onClick={() => setShowManualForm(!showManualForm)}
              className="text-xs font-medium text-slate-400 hover:text-blue-400 flex items-center gap-1.5 transition-colors"
            >
              <Code2 className="w-3.5 h-3.5" />
              {showManualForm ? 'Hide Direct Developer Token Input' : 'Direct Developer Token Input (For Reviewer Testing)'}
            </button>

            {showManualForm && (
              <form onSubmit={handleManualSubmit} className="mt-3 p-4 bg-slate-950 rounded-xl border border-slate-800 space-y-3 text-xs">
                <div className="space-y-1">
                  <label className="text-slate-300 font-semibold">Permanent Access Token (System User / User Token)</label>
                  <input
                    type="password"
                    required
                    placeholder="EAAG..."
                    value={manualToken}
                    onChange={(e) => setManualToken(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-blue-500 font-mono"
                  />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-slate-300 font-semibold">Phone Number ID</label>
                    <input
                      type="text"
                      required
                      placeholder="100..."
                      value={manualPhoneId}
                      onChange={(e) => setManualPhoneId(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-blue-500 font-mono"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-slate-300 font-semibold">WABA ID (Optional)</label>
                    <input
                      type="text"
                      placeholder="109..."
                      value={manualWabaId}
                      onChange={(e) => setManualWabaId(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-blue-500 font-mono"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Save & Verify Developer Credentials'}
                </button>
              </form>
            )}
          </div>
        </section>

        {/* PROOF STEP 2: Read Connected Phone Number & Templates */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6 shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center gap-3">
              <span className="w-8 h-8 rounded-full bg-purple-600/20 text-purple-400 border border-purple-500/30 flex items-center justify-center font-bold text-sm">
                2
              </span>
              <div>
                <h2 className="font-bold text-base text-white">
                  PROOF 2: Read Phone Numbers & Message Templates
                </h2>
                <p className="text-xs text-slate-400">
                  Proves <code className="text-purple-300 font-mono">whatsapp_business_management</code> permission access.
                </p>
              </div>
            </div>
          </div>

          {!connectedData ? (
            <p className="text-xs text-slate-400 italic p-6 bg-slate-950 rounded-xl border border-slate-800 text-center">
              No account connected yet. Complete Step 1 above to load phone numbers & templates via Graph API.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                <div className="p-3.5 bg-slate-950 rounded-xl border border-slate-800 space-y-1">
                  <span className="text-slate-400 font-medium">Display Phone Number</span>
                  <p className="text-sm font-bold text-emerald-400">{connectedData.display_phone_number || 'Connected'}</p>
                </div>
                <div className="p-3.5 bg-slate-950 rounded-xl border border-slate-800 space-y-1">
                  <span className="text-slate-400 font-medium">Phone Number ID</span>
                  <p className="text-xs font-mono text-slate-200">{connectedData.phone_number_id}</p>
                </div>
                <div className="p-3.5 bg-slate-950 rounded-xl border border-slate-800 space-y-1">
                  <span className="text-slate-400 font-medium">WABA ID</span>
                  <p className="text-xs font-mono text-slate-200">{connectedData.waba_id || 'N/A'}</p>
                </div>
              </div>

              {/* Template Inspector */}
              <div className="space-y-2">
                <h3 className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-purple-400" />
                  Fetched Message Templates ({connectedData.templates.length})
                </h3>

                {connectedData.templates.length === 0 ? (
                  <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 text-xs text-slate-400 italic">
                    No custom templates retrieved. &quot;hello_world&quot; default template is available.
                  </div>
                ) : (
                  <div className="max-h-40 overflow-y-auto space-y-1.5 pr-1">
                    {connectedData.templates.map((tpl: any, idx: number) => (
                      <div key={idx} className="p-2.5 bg-slate-950 border border-slate-800 rounded-lg flex items-center justify-between text-xs">
                        <div>
                          <span className="font-semibold text-slate-200">{tpl.name}</span>
                          <span className="ml-2 text-[10px] text-slate-400">({tpl.language})</span>
                        </div>
                        <span className="px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] rounded uppercase font-bold">
                          {tpl.status || 'APPROVED'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        {/* PROOF STEP 3: Send Approved Template Message */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6 shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center gap-3">
              <span className="w-8 h-8 rounded-full bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center font-bold text-sm">
                3
              </span>
              <div>
                <h2 className="font-bold text-base text-white">
                  PROOF 3: Send Approved Template Message
                </h2>
                <p className="text-xs text-slate-400">
                  Proves <code className="text-emerald-300 font-mono">whatsapp_business_messaging</code> permission access.
                </p>
              </div>
            </div>
          </div>

          <form onSubmit={handleSendTestMessage} className="space-y-4 text-xs">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-slate-300 font-semibold">Recipient Phone Number (With Country Code)</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. 15550199 or 919876543210"
                  value={recipientPhone}
                  onChange={(e) => setRecipientPhone(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-slate-100 focus:outline-none focus:border-blue-500 font-mono text-sm"
                />
              </div>

              <div className="space-y-1">
                <label className="text-slate-300 font-semibold">Template Name</label>
                <select
                  value={selectedTemplate}
                  onChange={(e) => setSelectedTemplate(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-slate-100 focus:outline-none focus:border-blue-500 text-sm"
                >
                  <option value="hello_world">hello_world (Meta Default)</option>
                  {connectedData?.templates.map((tpl: any, idx: number) => (
                    <option key={idx} value={tpl.name}>
                      {tpl.name} ({tpl.language})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <button
              type="submit"
              disabled={sendingTest || !connectedData}
              className="w-full py-3.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 transition-all disabled:opacity-50"
            >
              {sendingTest ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Dispatching Template Message...
                </>
              ) : (
                <>
                  <Send className="w-4 h-4" /> Send Approved Template to Recipient Phone
                </>
              )}
            </button>
          </form>

          {/* Test Dispatch Result Output */}
          {testResult && (
            <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-200">Message Dispatch Result:</span>
                <span
                  className={`px-2.5 py-0.5 rounded font-bold uppercase ${
                    testResult.success ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                  }`}
                >
                  {testResult.success ? 'ACCEPTED BY META (DELIVERED)' : 'FAILED'}
                </span>
              </div>

              {testResult.wamid && (
                <p className="text-slate-300">
                  Meta WAMID: <span className="font-mono text-emerald-400 font-semibold">{testResult.wamid}</span>
                </p>
              )}

              <div className="space-y-1">
                <span className="text-slate-400 font-mono text-[11px]">API Payload Response:</span>
                <pre className="p-3 bg-slate-900 rounded-lg border border-slate-800 text-[10px] text-emerald-300 font-mono overflow-x-auto">
                  {JSON.stringify(testResult, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
