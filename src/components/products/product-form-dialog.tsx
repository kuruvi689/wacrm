"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CURRENCIES } from "@/lib/currency";
import { minorToAmountString } from "@/lib/products/money";
import type { Product } from "@/types";

interface Draft {
  name: string;
  sku: string;
  description: string;
  price: string;
  currency: string;
  tax_rate: string;
  max_discount_pct: string;
  is_active: boolean;
}

function toDraft(product: Product | null, defaultCurrency: string): Draft {
  if (!product) {
    return {
      name: "",
      sku: "",
      description: "",
      price: "",
      currency: defaultCurrency,
      tax_rate: "0",
      max_discount_pct: "0",
      is_active: true,
    };
  }
  return {
    name: product.name,
    sku: product.sku ?? "",
    description: product.description ?? "",
    price: minorToAmountString(product.price_minor, product.currency),
    currency: product.currency,
    tax_rate: String(Number(product.tax_rate)),
    max_discount_pct: String(Number(product.max_discount_pct)),
    is_active: product.is_active,
  };
}

interface ProductFormDialogProps {
  /** `null` creates a new product; a product edits it. */
  product: Product | null;
  defaultCurrency: string;
  onClose: () => void;
  onSaved: () => void;
}

export function ProductFormDialog({
  product,
  defaultCurrency,
  onClose,
  onSaved,
}: ProductFormDialogProps) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(product, defaultCurrency));
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  // Currency is fixed once a product exists: changing it would silently
  // reinterpret the stored minor units (e.g. INR paise as JPY).
  const currencyOptions = CURRENCIES.some((c) => c.code === draft.currency)
    ? CURRENCIES
    : [{ code: draft.currency, label: draft.currency, symbol: "" }, ...CURRENCIES];

  const save = async () => {
    if (!draft.name.trim() || !draft.price.trim()) {
      toast.error("Name and price are required.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(product ? `/api/products/${product.id}` : "/api/products", {
        method: product ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't save the product.");
        return;
      }
      toast.success(product ? "Product updated." : "Product added.");
      onSaved();
    } catch {
      toast.error("Couldn't save the product.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{product ? "Edit product" : "Add product"}</DialogTitle>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-3 overflow-y-auto">
          <Field label="Name">
            <Input
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="e.g. 3-month coaching plan"
              maxLength={200}
              className="bg-muted text-foreground"
            />
          </Field>

          <div className="grid grid-cols-[1fr_7rem] gap-3">
            <Field label="Price (before tax)">
              <Input
                value={draft.price}
                onChange={(e) => set("price", e.target.value)}
                inputMode="decimal"
                placeholder="2999"
                className="bg-muted text-foreground"
              />
            </Field>
            <Field label="Currency">
              <select
                value={draft.currency}
                onChange={(e) => set("currency", e.target.value)}
                disabled={!!product}
                className="h-9 w-full rounded-md border border-input bg-muted px-2 text-sm text-foreground disabled:opacity-60"
              >
                {currencyOptions.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Tax %" hint="Added on top of the price, e.g. 18 for GST.">
              <Input
                value={draft.tax_rate}
                onChange={(e) => set("tax_rate", e.target.value)}
                inputMode="decimal"
                className="bg-muted text-foreground"
              />
            </Field>
            <Field label="Max discount %" hint="The most the AI may offer without asking you.">
              <Input
                value={draft.max_discount_pct}
                onChange={(e) => set("max_discount_pct", e.target.value)}
                inputMode="decimal"
                className="bg-muted text-foreground"
              />
            </Field>
          </div>

          <Field label="SKU (optional)" hint="A unique code. Re-importing a CSV updates products by SKU.">
            <Input
              value={draft.sku}
              onChange={(e) => set("sku", e.target.value)}
              placeholder="PLAN-3M"
              maxLength={64}
              className="bg-muted text-foreground"
            />
          </Field>

          <Field label="Description (optional)" hint="What's included. The AI uses this to answer questions.">
            <Textarea
              value={draft.description}
              onChange={(e) => set("description", e.target.value)}
              maxLength={2000}
              className="min-h-20 bg-muted text-foreground"
            />
          </Field>

          <label className="flex items-center justify-between rounded-lg border border-border p-3">
            <span>
              <span className="block text-sm font-medium text-foreground">Available to sell</span>
              <span className="block text-xs text-muted-foreground">
                Inactive products are hidden from quotes and new orders.
              </span>
            </span>
            <Switch checked={draft.is_active} onCheckedChange={(v) => set("is_active", v)} />
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}

function Field({ label, hint, children }: FieldProps) {
  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
