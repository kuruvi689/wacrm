'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

const FB_SDK_SRC = 'https://connect.facebook.net/en_US/sdk.js';
const FB_GRAPH_VERSION = 'v21.0';
const FB_ORIGINS = new Set(['https://www.facebook.com', 'https://web.facebook.com']);
/** How long to wait for Meta's session event after FB.login returns a code. */
const SESSION_EVENT_TIMEOUT_MS = 30_000;

interface SignupSession {
  phone_number_id: string;
  waba_id: string;
}

interface FacebookSdk {
  init: (options: Record<string, unknown>) => void;
  login: (
    callback: (response: { authResponse?: { code?: string } | null }) => void,
    options: Record<string, unknown>,
  ) => void;
}

type FacebookWindow = Window & { FB?: FacebookSdk; fbAsyncInit?: () => void };

interface UseEmbeddedSignupArgs {
  appId: string;
  configId: string;
  /** Called after the server has saved the connection. */
  onConnected: () => void;
}

function isSignupSession(data: unknown): data is SignupSession {
  if (typeof data !== 'object' || data === null) return false;
  const { phone_number_id, waba_id } = data as Record<string, unknown>;
  return typeof phone_number_id === 'string' && typeof waba_id === 'string';
}

/**
 * Meta Embedded Signup: loads the Facebook JS SDK, opens the signup
 * popup, and finishes the connection on the server. Meta delivers the
 * result in two independent pieces — the one-time `code` (FB.login
 * callback) and the chosen phone_number_id / waba_id (a postMessage
 * event) — in no guaranteed order, so we wait for both.
 */
export function useEmbeddedSignup({ appId, configId, onConnected }: UseEmbeddedSignupArgs) {
  const [launching, setLaunching] = useState(false);
  const codeRef = useRef<string | null>(null);
  const sessionRef = useRef<SignupSession | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reset = useCallback(() => {
    codeRef.current = null;
    sessionRef.current = null;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    setLaunching(false);
  }, []);

  const complete = useCallback(async () => {
    const code = codeRef.current;
    const session = sessionRef.current;
    if (!code || !session) return; // still waiting for the other half

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    try {
      const res = await fetch('/api/whatsapp/embedded-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, ...session }),
      });
      const payload = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast.error(payload.error ?? 'Could not connect WhatsApp. Please try again.');
        return;
      }
      if (payload.success === false && payload.registration_error) {
        toast.warning(`Connected, but the number is not live yet: ${payload.registration_error}`);
      } else {
        toast.success('WhatsApp connected!');
      }
      onConnected();
    } catch {
      toast.error('Network error while connecting WhatsApp. Please try again.');
    } finally {
      reset();
    }
  }, [onConnected, reset]);

  // Load the Facebook SDK once an app id is known.
  useEffect(() => {
    if (!appId) return;
    const w = window as FacebookWindow;
    const init = () => w.FB?.init({ appId, cookie: true, xfbml: false, version: FB_GRAPH_VERSION });

    if (w.FB) {
      init();
      return;
    }
    w.fbAsyncInit = init;
    if (!document.querySelector(`script[src="${FB_SDK_SRC}"]`)) {
      const script = document.createElement('script');
      script.src = FB_SDK_SRC;
      script.async = true;
      script.defer = true;
      script.crossOrigin = 'anonymous';
      document.body.appendChild(script);
    }
  }, [appId]);

  // Receive the phone number / WABA the customer picked in the popup.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!FB_ORIGINS.has(event.origin)) return;
      let message: unknown = event.data;
      if (typeof message === 'string') {
        try {
          message = JSON.parse(message);
        } catch {
          return;
        }
      }
      if (typeof message !== 'object' || message === null) return;
      const { type, event: kind, data } = message as Record<string, unknown>;
      if (type !== 'WA_EMBEDDED_SIGNUP') return;

      if (kind === 'FINISH' && isSignupSession(data)) {
        sessionRef.current = { phone_number_id: data.phone_number_id, waba_id: data.waba_id };
        void complete();
      } else if (kind === 'CANCEL') {
        toast.info('WhatsApp signup was cancelled.');
        reset();
      } else if (kind === 'ERROR') {
        toast.error('Meta reported an error during signup. Please try again.');
        reset();
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [complete, reset]);

  const launch = useCallback(() => {
    if (!appId || !configId) {
      toast.error('Embedded Signup is not configured (missing Meta App ID or Configuration ID).');
      return;
    }
    const fb = (window as FacebookWindow).FB;
    if (!fb) {
      toast.error('Facebook is still loading — try again in a moment.');
      return;
    }

    codeRef.current = null;
    sessionRef.current = null;
    setLaunching(true);

    fb.login(
      (response) => {
        const code = response.authResponse?.code;
        if (!code) {
          toast.info('WhatsApp signup was not completed.');
          reset();
          return;
        }
        codeRef.current = code;
        // The session event normally lands within moments; don't wait forever.
        timeoutRef.current = setTimeout(() => {
          toast.error('Meta did not confirm the phone number. Please try again.');
          reset();
        }, SESSION_EVENT_TIMEOUT_MS);
        void complete();
      },
      {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, sessionInfoVersion: '3' },
      },
    );
  }, [appId, configId, complete, reset]);

  return { launch, launching };
}
