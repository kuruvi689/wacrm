"use client";

import { useMemo, useRef, useState } from "react";
import { Download, FileUp, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatMinor } from "@/lib/products/money";
import { PRODUCT_CSV_TEMPLATE, parseProductCsv } from "@/lib/products/product-input";

const MAX_FILE_BYTES = 1_000_000;
const PREVIEW_ROWS = 50;

interface ProductImportDialogProps {
  defaultCurrency: string;
  onClose: () => void;
  onImported: () => void;
}

export function ProductImportDialog({
  defaultCurrency,
  onClose,
  onImported,
}: ProductImportDialogProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [importing, setImporting] = useState(false);

  // Preview with the same parser the server uses, so what you see is
  // what gets imported.
  const parsed = useMemo(
    () => (csv === null ? null : parseProductCsv(csv, defaultCurrency)),
    [csv, defaultCurrency],
  );
  const validCount = parsed?.ok ? parsed.rows.filter((r) => r.result.ok).length : 0;
  const errorCount = parsed?.ok ? parsed.rows.length - validCount : 0;

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      toast.error("The file is too large (max 1 MB).");
      return;
    }
    setFileName(file.name);
    setCsv(await file.text());
  };

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([PRODUCT_CSV_TEMPLATE], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "products-template.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const runImport = async () => {
    if (!csv || validCount === 0) return;
    setImporting(true);
    try {
      const res = await fetch("/api/products/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Import failed.");
        return;
      }
      const skipped = Array.isArray(data.skipped) ? data.skipped.length : 0;
      toast.success(
        `Imported ${data.imported} product${data.imported === 1 ? "" : "s"}` +
          (skipped ? `, skipped ${skipped} with errors.` : "."),
      );
      onImported();
    } catch {
      toast.error("Import failed.");
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import products from CSV</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Required columns: <code>name</code>, <code>price</code>. Optional: <code>sku</code>,{" "}
            <code>currency</code> (default {defaultCurrency}), <code>tax_rate</code>,{" "}
            <code>max_discount_pct</code>, <code>active</code>, <code>description</code>. Prices
            are before tax. Rows with a SKU that already exists update that product.
          </p>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => fileRef.current?.click()}>
              <FileUp className="mr-1 h-4 w-4" />
              {fileName ? "Choose another file" : "Choose CSV file"}
            </Button>
            <Button variant="ghost" onClick={downloadTemplate}>
              <Download className="mr-1 h-4 w-4" />
              Download template
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                void pickFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>

          {parsed && !parsed.ok && (
            <p className="rounded-md bg-red-500/10 p-3 text-sm text-red-400">{parsed.error}</p>
          )}

          {parsed?.ok && (
            <>
              <p className="text-sm text-foreground">
                <span className="font-medium">{fileName}</span>: {validCount} ready
                {errorCount > 0 && (
                  <span className="text-red-400">, {errorCount} with errors (will be skipped)</span>
                )}
              </p>
              <div className="max-h-72 overflow-auto rounded-md border border-border">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-muted text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1.5">Line</th>
                      <th className="px-2 py-1.5">Name</th>
                      <th className="px-2 py-1.5">SKU</th>
                      <th className="px-2 py-1.5 text-right">Price</th>
                      <th className="px-2 py-1.5 text-right">Tax</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.rows.slice(0, PREVIEW_ROWS).map((row) =>
                      row.result.ok ? (
                        <tr key={row.line} className="border-t border-border">
                          <td className="px-2 py-1.5 text-muted-foreground">{row.line}</td>
                          <td className="px-2 py-1.5">{row.result.product.name}</td>
                          <td className="px-2 py-1.5 text-muted-foreground">
                            {row.result.product.sku ?? "—"}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            {formatMinor(row.result.product.price_minor, row.result.product.currency)}
                          </td>
                          <td className="px-2 py-1.5 text-right">{row.result.product.tax_rate}%</td>
                        </tr>
                      ) : (
                        <tr key={row.line} className="border-t border-border bg-red-500/5">
                          <td className="px-2 py-1.5 text-muted-foreground">{row.line}</td>
                          <td colSpan={4} className="px-2 py-1.5 text-red-400">
                            {row.result.error}
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
              {parsed.rows.length > PREVIEW_ROWS && (
                <p className="text-xs text-muted-foreground">
                  Showing the first {PREVIEW_ROWS} of {parsed.rows.length} rows.
                </p>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={importing}>
            Cancel
          </Button>
          <Button onClick={runImport} disabled={importing || validCount === 0}>
            {importing && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Import {validCount > 0 ? validCount : ""} product{validCount === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
