import { Card, CardContent } from '@/components/ui/card';
import { formatMinor } from '@/lib/products/money';

import { formatDate } from './billing-logic';
import type { BillingInvoice } from './types';

const STATUS_TEXT: Record<BillingInvoice['status'], string> = {
  open: 'Awaiting payment',
  paid: 'Paid',
  void: 'Cancelled',
  expired: 'Expired',
  refunded: 'Refunded',
};

export function InvoiceHistory({ invoices }: { invoices: BillingInvoice[] }) {
  return (
    <Card>
      <CardContent className="p-5">
        <h3 className="text-sm font-semibold text-foreground">Invoice history</h3>
        {invoices.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No invoices yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[460px] text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-2 font-medium">Invoice</th>
                  <th className="pb-2 font-medium">Date</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td className="py-2 font-mono text-xs">{invoice.number}</td>
                    <td className="py-2">{formatDate(invoice.paid_at ?? invoice.created_at)}</td>
                    <td className="py-2">{STATUS_TEXT[invoice.status]}</td>
                    <td className="py-2 text-right tabular-nums">{formatMinor(invoice.amount_minor, invoice.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
