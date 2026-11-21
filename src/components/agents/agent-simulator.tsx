'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { ArrowRight, Loader2, RotateCcw, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  apiErrorMessage,
  toolCallStatusLabel,
  toolLabel,
  type SimToolCall,
} from './agent-logic';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  handoff?: boolean;
  versionNumber?: number;
  toolCalls?: SimToolCall[];
}

interface AgentSimulatorProps {
  agentId: string;
}

/**
 * Dry run of the agent's current version. Tools are not executed (the
 * server only reports what they would do), nothing is sent to a customer
 * and nothing is counted against the plan.
 */
export function AgentSimulator({ agentId }: AgentSimulatorProps) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    const next: Turn[] = [...turns, { role: 'user', content: text }];
    setTurns(next);
    setInput('');
    setSending(true);
    try {
      const res = await fetch(`/api/ai/agents/${agentId}/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: next.map((t) => ({ role: t.role, content: t.content })),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(apiErrorMessage(res.status, data));
        setTurns(turns);
        setInput(text);
        return;
      }
      const reply = typeof data?.reply === 'string' ? data.reply : '';
      setTurns([
        ...next,
        {
          role: 'assistant',
          content: reply.trim() || '(no reply)',
          handoff: data?.handoff === true,
          versionNumber: typeof data?.version_number === 'number' ? data.version_number : undefined,
          toolCalls: Array.isArray(data?.tool_calls) ? (data.tool_calls as SimToolCall[]) : [],
        },
      ]);
    } catch {
      toast.error('Network error. Please try again.');
      setTurns(turns);
      setInput(text);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Type as a customer. Lookups and knowledge search do run. Tools that change a contact or call
        your n8n webhook are not run; you only see what they would do. Nothing is sent on WhatsApp and
        nothing counts against your plan quota, but each test uses tokens on your own AI key.
      </p>

      <div className="max-h-96 space-y-3 overflow-y-auto rounded-md border border-border p-3">
        {turns.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Try a question a customer might ask.
          </p>
        )}
        {turns.map((t, i) => (
          <div key={i} className={t.role === 'user' ? 'text-right' : ''}>
            <div
              className={
                'inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-left text-sm ' +
                (t.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground')
              }
            >
              {t.content}
            </div>
            {t.role === 'assistant' && (
              <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                {t.versionNumber !== undefined && <span>Answered by v{t.versionNumber}</span>}
                {t.handoff && (
                  <p className="flex items-center gap-1 text-foreground">
                    <ArrowRight className="h-3 w-3" /> Would hand off to a human
                  </p>
                )}
                {(t.toolCalls ?? []).map((c, j) => (
                  <p key={j} className="flex flex-wrap items-center gap-1">
                    <Badge variant="outline">{toolCallStatusLabel(c.status)}</Badge>
                    <span className="text-foreground">{toolLabel(c.tool)}</span>
                    {c.argsSummary && <span>({c.argsSummary})</span>}
                    {c.wouldCall && <span>would call {c.wouldCall}</span>}
                    {c.error && <span className="text-destructive">{c.error}</span>}
                  </p>
                ))}
              </div>
            )}
          </div>
        ))}
        {sending && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Thinking...
          </p>
        )}
      </div>

      <div className="flex gap-2">
        <Textarea
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message as a customer"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex flex-col gap-2">
          <Button onClick={send} disabled={sending || !input.trim()}>
            <Send className="mr-2 h-4 w-4" /> Send
          </Button>
          <Button variant="outline" onClick={() => setTurns([])} disabled={sending || turns.length === 0}>
            <RotateCcw className="mr-2 h-4 w-4" /> Reset
          </Button>
        </div>
      </div>
    </div>
  );
}
