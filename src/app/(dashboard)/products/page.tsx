'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileUp, Loader2, Package, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ProductFormDialog } from '@/components/products/product-form-dialog';
import { ProductImportDialog } from '@/components/products/product-import-dialog';
import { useAuth } from '@/hooks/use-auth';
import { canManageCatalog } from '@/lib/auth/roles';
import { formatMinor, percentOf } from '@/lib/products/money';
import type { Product } from '@/types';

// The price list. The AI agent will quote ONLY from these rows, so this
// page is where an owner decides what can be sold and for how much.

type Editing = { product: Product | null } | null;

export default function ProductsPage() {
  const { accountRole, defaultCurrency } = useAuth();
  const canEdit = accountRole ? canManageCatalog(accountRole) : false;

  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Editing>(null);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/products', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setProducts((data.products as Product[]) ?? []);
      else toast.error(data.error ?? "Couldn't load products.");
    } catch {
      toast.error("Couldn't load products.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) => p.name.toLowerCase().includes(q) || (p.sku ?? '').toLowerCase().includes(q),
    );
  }, [products, query]);

  const remove = async (product: Product) => {
    if (!window.confirm(`Delete "${product.name}"? Existing orders keep their copy.`)) return;
    const res = await fetch(`/api/products/${product.id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error("Couldn't delete the product.");
      return;
    }
    toast.success('Product deleted.');
    await load();
  };

  const closeAndReload = () => {
    setEditing(null);
    setImporting(false);
    void load();
  };

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Package className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Products</h1>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Your price list. Orders and the AI agent take prices, tax and discount limits from here,
            never from chat text.
          </p>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setImporting(true)}>
              <FileUp className="mr-1 h-4 w-4" />
              Import CSV
            </Button>
            <Button onClick={() => setEditing({ product: null })}>
              <Plus className="mr-1 h-4 w-4" />
              Add product
            </Button>
          </div>
        )}
      </div>

      <div className="relative mt-6 max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or SKU"
          className="bg-muted pl-8 text-foreground"
        />
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : products.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-border px-6 py-14 text-center">
          <Package className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium text-foreground">No products yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            {canEdit
              ? 'Add what you sell, or import a CSV of your price list, so orders and the AI quote real prices.'
              : 'An owner or admin adds products here.'}
          </p>
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-border text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">Product</th>
                <th className="px-4 py-2.5 text-right font-medium">Price</th>
                <th className="px-4 py-2.5 text-right font-medium">Tax</th>
                <th className="px-4 py-2.5 text-right font-medium">With tax</th>
                <th className="px-4 py-2.5 text-right font-medium">Max discount</th>
                {canEdit && <th className="w-24 px-4 py-2.5" />}
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr
                  key={p.id}
                  className={`border-b border-border last:border-0 ${p.is_active ? '' : 'opacity-55'}`}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{p.name}</span>
                      {!p.is_active && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          Inactive
                        </span>
                      )}
                    </div>
                    {(p.sku || p.description) && (
                      <p className="mt-0.5 max-w-md truncate text-xs text-muted-foreground">
                        {[p.sku, p.description].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatMinor(p.price_minor, p.currency)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {Number(p.tax_rate)}%
                  </td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">
                    {formatMinor(p.price_minor + percentOf(p.price_minor, Number(p.tax_rate)), p.currency)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {Number(p.max_discount_pct)}%
                  </td>
                  {canEdit && (
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Edit ${p.name}`}
                          onClick={() => setEditing({ product: p })}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete ${p.name}`}
                          onClick={() => remove(p)}
                          className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={canEdit ? 6 : 5} className="px-4 py-8 text-center text-muted-foreground">
                    No products match “{query}”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <ProductFormDialog
          product={editing.product}
          defaultCurrency={defaultCurrency}
          onClose={() => setEditing(null)}
          onSaved={closeAndReload}
        />
      )}
      {importing && (
        <ProductImportDialog
          defaultCurrency={defaultCurrency}
          onClose={() => setImporting(false)}
          onImported={closeAndReload}
        />
      )}
    </div>
  );
}
