import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

import { buildMeter } from './billing-logic';
import type { UsageRow } from './types';

const BAR_TONE = { ok: 'bg-primary', warn: 'bg-amber-500', bad: 'bg-destructive' } as const;

export function UsageMeters({ usage }: { usage: UsageRow[] }) {
  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Usage this month</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">Counters reset on the 1st of every month (UTC).</p>
        </div>
        <ul className="space-y-3.5">
          {usage.map((row) => {
            const meter = buildMeter(row.metric, row.used, row.reserved, row.limit);
            return (
              <li key={row.metric}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-medium text-foreground">{meter.label}</span>
                  <span className="text-xs text-muted-foreground">{meter.text}</span>
                </div>
                <div
                  className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-label={meter.label}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={meter.percent ?? undefined}
                >
                  {meter.percent !== null ? (
                    <div className={cn('h-full rounded-full', BAR_TONE[meter.tone])} style={{ width: `${meter.percent}%` }} />
                  ) : null}
                </div>
                {row.blocked > 0 ? (
                  <p className="mt-1 text-xs text-destructive">
                    {row.blocked.toLocaleString('en-IN')} blocked after the limit was reached.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
