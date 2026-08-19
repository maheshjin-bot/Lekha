"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";

type Category = {
  category_code: string;
  description: string;
  useful_life_years: number;
};

type Block = {
  block_code: string;
  description: string;
  rate_percent: number;
};

// Mirrors get_fixed_asset_register's return shape. Supabase returns numeric
// columns as strings over .rpc() — every report in this codebase wraps them
// in Number(...) before use, and this table does the same.
type AssetRow = {
  asset_id: string;
  name: string;
  asset_code: string | null;
  category_code: string;
  category_description: string;
  it_block: string;
  book_method: string;
  acquisition_date: string;
  put_to_use_date: string;
  gross_value: string | number;
  residual_value_percent: string | number;
  accumulated_depreciation: string | number;
  net_book_value: string | number;
  disposal_date: string | null;
  disposal_value: string | number | null;
  is_active: boolean;
};

/** Today as a local wall-clock date — not toISOString(), which is UTC. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const field =
  "rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 dark:border-zinc-700 dark:bg-zinc-900";

export function FixedAssetManager({
  companyId,
  assets,
  categories,
  blocks,
}: {
  companyId: string;
  assets: AssetRow[];
  categories: Category[];
  blocks: Block[];
}) {
  const router = useRouter();

  const [name, setName] = useState("");
  const [assetCode, setAssetCode] = useState("");
  const [categoryCode, setCategoryCode] = useState(categories[0]?.category_code ?? "");
  const [itBlock, setItBlock] = useState(blocks[0]?.block_code ?? "");
  const [bookMethod, setBookMethod] = useState<"slm" | "wdv">("wdv");
  const [residualPercent, setResidualPercent] = useState("5");
  const [acquisitionDate, setAcquisitionDate] = useState(todayLocal);
  const [putToUseDate, setPutToUseDate] = useState(todayLocal);
  const [grossValue, setGrossValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Two-step reveal for disposal — same pattern as YearEndPanel's reopen
  // section, not a confirm() and not a modal.
  const [disposingId, setDisposingId] = useState<string | null>(null);
  const [disposalDate, setDisposalDate] = useState("");
  const [disposalValue, setDisposalValue] = useState("");
  const [disposeBusy, setDisposeBusy] = useState(false);
  const [disposeError, setDisposeError] = useState<string | null>(null);

  const categoryByCode = new Map(categories.map((c) => [c.category_code, c]));
  const blockByCode = new Map(blocks.map((b) => [b.block_code, b]));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { error } = await createClient()
      .from("fixed_assets")
      .insert({
        company_id: companyId,
        name: name.trim(),
        asset_code: assetCode.trim() || null,
        category_code: categoryCode,
        it_block: itBlock,
        book_method: bookMethod,
        residual_value_percent: Number(residualPercent) || 0,
        acquisition_date: acquisitionDate,
        put_to_use_date: putToUseDate,
        gross_value: Number(grossValue) || 0,
      });

    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }

    setName("");
    setAssetCode("");
    setGrossValue("");
    setBusy(false);
    router.refresh();
  }

  function startDispose(assetId: string) {
    setDisposingId(assetId);
    setDisposalDate(todayLocal());
    setDisposalValue("");
    setDisposeError(null);
  }

  function cancelDispose() {
    setDisposingId(null);
    setDisposeError(null);
  }

  async function onDispose(e: React.FormEvent, assetId: string) {
    e.preventDefault();
    setDisposeBusy(true);
    setDisposeError(null);

    const { error } = await createClient()
      .from("fixed_assets")
      .update({
        disposal_date: disposalDate,
        disposal_value: Number(disposalValue) || 0,
      })
      .eq("id", assetId)
      .eq("company_id", companyId);

    setDisposeBusy(false);
    if (error) {
      setDisposeError(error.message);
      return;
    }
    setDisposingId(null);
    router.refresh();
  }

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_320px]">
      <section className="min-w-0">
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full min-w-[920px] text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-[11px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                <th className="px-4 py-2.5 font-medium">Asset</th>
                <th className="px-4 py-2.5 font-medium">Category</th>
                <th className="px-4 py-2.5 font-medium">IT block</th>
                <th className="px-4 py-2.5 font-medium">Method</th>
                <th className="px-4 py-2.5 text-right font-medium">Gross value</th>
                <th className="px-4 py-2.5 text-right font-medium">Accum. depreciation</th>
                <th className="px-4 py-2.5 text-right font-medium">Net book value</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {assets.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-zinc-500">
                    No fixed assets yet. Create one on the right.
                  </td>
                </tr>
              )}
              {assets.map((a) => {
                const category = categoryByCode.get(a.category_code);
                const block = blockByCode.get(a.it_block);
                const disposed = Boolean(a.disposal_date);

                return (
                  <Fragment key={a.asset_id}>
                    <tr className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                      <td className="px-4 py-2.5">
                        <span className="font-medium">{a.name}</span>
                        {a.asset_code && (
                          <div className="font-mono text-xs text-zinc-500">{a.asset_code}</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {a.category_description}
                        {category && (
                          <div className="text-xs text-zinc-500">
                            {category.useful_life_years} yrs
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="font-mono text-xs">{a.it_block}</span>
                        {block && (
                          <div className="text-xs text-zinc-500">{block.rate_percent}%</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                          {a.book_method}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {formatINR(Number(a.gross_value))}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {formatINR(Number(a.accumulated_depreciation))}
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium tabular-nums">
                        {formatINR(Number(a.net_book_value))}
                      </td>
                      <td className="px-4 py-2.5">
                        {disposed ? (
                          <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                            Disposed
                          </span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                              Active
                            </span>
                            {disposingId !== a.asset_id && (
                              <button
                                type="button"
                                onClick={() => startDispose(a.asset_id)}
                                className="text-xs text-zinc-500 underline underline-offset-4 hover:text-zinc-800 dark:hover:text-zinc-300"
                              >
                                Dispose
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                    {disposingId === a.asset_id && (
                      <tr className="border-b border-zinc-100 bg-zinc-50 dark:border-zinc-800/60 dark:bg-zinc-900/60">
                        <td colSpan={8} className="px-4 py-3">
                          <form
                            onSubmit={(e) => onDispose(e, a.asset_id)}
                            className="flex flex-wrap items-end gap-3"
                          >
                            <label className="flex flex-col gap-1.5">
                              <span className="text-xs font-medium">Disposal date</span>
                              <input
                                type="date"
                                required
                                value={disposalDate}
                                onChange={(e) => setDisposalDate(e.target.value)}
                                className={field}
                              />
                            </label>
                            <label className="flex flex-col gap-1.5">
                              <span className="text-xs font-medium">Disposal value</span>
                              <input
                                inputMode="decimal"
                                value={disposalValue}
                                onChange={(e) => setDisposalValue(e.target.value)}
                                className={field + " text-right tabular-nums"}
                              />
                            </label>
                            <button
                              type="submit"
                              disabled={disposeBusy}
                              className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-600 disabled:opacity-50"
                            >
                              {disposeBusy ? "Recording…" : "Confirm disposal"}
                            </button>
                            <button
                              type="button"
                              onClick={cancelDispose}
                              className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
                            >
                              Cancel
                            </button>
                            {disposeError && (
                              <p className="w-full rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
                                {disposeError}
                              </p>
                            )}
                          </form>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="font-semibold">New asset</h2>
        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Name</span>
            <input required value={name} onChange={(e) => setName(e.target.value)} className={field} />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Asset code <span className="font-normal text-zinc-500">optional</span>
            </span>
            <input
              value={assetCode}
              onChange={(e) => setAssetCode(e.target.value)}
              className={field + " font-mono"}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Category</span>
            <select
              required
              value={categoryCode}
              onChange={(e) => setCategoryCode(e.target.value)}
              className={field}
            >
              {categories.map((c) => (
                <option key={c.category_code} value={c.category_code}>
                  {c.description} — {c.useful_life_years} yrs
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">IT block</span>
            <select
              required
              value={itBlock}
              onChange={(e) => setItBlock(e.target.value)}
              className={field}
            >
              {blocks.map((b) => (
                <option key={b.block_code} value={b.block_code}>
                  {b.description} — {b.rate_percent}%
                </option>
              ))}
            </select>
          </label>

          <fieldset className="flex gap-2">
            {(["slm", "wdv"] as const).map((m) => (
              <label
                key={m}
                className={
                  "flex-1 cursor-pointer rounded-md border px-3 py-1.5 text-center text-sm uppercase transition " +
                  (bookMethod === m
                    ? "border-emerald-600 bg-emerald-50 dark:bg-emerald-950/40"
                    : "border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800/60")
                }
              >
                <input
                  type="radio"
                  name="book_method"
                  checked={bookMethod === m}
                  onChange={() => setBookMethod(m)}
                  className="sr-only"
                />
                {m}
              </label>
            ))}
          </fieldset>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Residual value %</span>
            <input
              inputMode="decimal"
              value={residualPercent}
              onChange={(e) => setResidualPercent(e.target.value)}
              className={field + " text-right tabular-nums"}
            />
            <span className="text-xs text-zinc-500">Companies Act ceiling is 5% of cost</span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Acquisition date</span>
            <input
              type="date"
              required
              value={acquisitionDate}
              onChange={(e) => setAcquisitionDate(e.target.value)}
              className={field}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Put to use date</span>
            <input
              type="date"
              required
              value={putToUseDate}
              onChange={(e) => setPutToUseDate(e.target.value)}
              className={field}
            />
            <span className="text-xs text-zinc-500">
              Depreciation and the 180-day rule run from this date, not the acquisition date
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Gross value</span>
            <input
              inputMode="decimal"
              required
              value={grossValue}
              onChange={(e) => setGrossValue(e.target.value)}
              className={field + " text-right tabular-nums"}
            />
          </label>

          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-1 rounded-md bg-emerald-800 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-700 dark:hover:bg-emerald-600"
          >
            {busy ? "Adding…" : "Add asset"}
          </button>
        </form>
      </section>
    </div>
  );
}
