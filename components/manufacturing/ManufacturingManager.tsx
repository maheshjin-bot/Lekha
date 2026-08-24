"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { Button } from "@/components/ui/Button";
import { Input, Select, Label } from "@/components/ui/Input";
import { Card, CardBody } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";

type Bom = {
  bom_id: string;
  output_item_id: string;
  output_item_name: string;
  output_uom: string;
  name: string;
  yield_quantity: number;
  is_active: boolean;
  component_count: number;
  component_cost_at_yield: number;
};

type ComponentRow = {
  id: string;
  bom_id: string;
  component_item_id: string;
  quantity: number;
  item_name: string;
  uom: string;
};

type OutputType = "by_product" | "scrap" | "co_product";

type OutputRow = {
  id: string;
  bom_id: string;
  output_type: OutputType;
  output_item_id: string;
  quantity: number;
  nrv_rate: number;
  item_name: string;
  uom: string;
};

const OUTPUT_TYPE_LABEL: Record<OutputType, string> = {
  by_product: "By-product",
  scrap: "Scrap",
  co_product: "Co-product",
};

type Item = { id: string; name: string; uom: string; sale_rate: number | null };
type Branch = { id: string; code: string; name: string };
type Godown = { id: string; name: string; is_default: boolean };

function NewBomForm({ companyId, items }: { companyId: string; items: Item[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outputItemId, setOutputItemId] = useState("");
  const [name, setName] = useState("Standard");
  const [yieldQty, setYieldQty] = useState("1");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!outputItemId || !(Number(yieldQty) > 0)) {
      toast.error("Pick the output item and a positive yield quantity.");
      return;
    }
    setBusy(true);
    const { error } = await createClient()
      .from("bill_of_materials")
      .insert({ company_id: companyId, output_item_id: outputItemId, name: name.trim() || "Standard", yield_quantity: Number(yieldQty) });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("BOM created — add its components next.");
    setOutputItemId("");
    setYieldQty("1");
    setOpen(false);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setOpen((s) => !s)}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90"
        >
          {open ? "Cancel" : "New BOM"}
        </button>
      </div>
      {open && (
        <form onSubmit={submit} className="flex flex-col gap-4 rounded-[14px] border border-border bg-surface p-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="flex flex-col gap-1.5">
              <Label>Output item</Label>
              <Select value={outputItemId} onChange={(e) => setOutputItemId(e.target.value)}>
                <option value="">— select —</option>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Recipe name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Yield quantity (batch size)</Label>
              <Input type="number" min={0} step="any" value={yieldQty} onChange={(e) => setYieldQty(e.target.value)} />
            </label>
          </div>
          <div className="flex justify-end">
            <Button type="submit" busy={busy} busyLabel="Creating…">
              Create BOM
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function AddComponentForm({ companyId, bomId, items, onDone }: { companyId: string; bomId: string; items: Item[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("1");

  async function submit() {
    if (!itemId || !(Number(quantity) > 0)) {
      toast.error("Pick a component item and a positive quantity.");
      return;
    }
    setBusy(true);
    const { error } = await createClient()
      .from("bom_components")
      .insert({ bom_id: bomId, company_id: companyId, component_item_id: itemId, quantity: Number(quantity) });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Component added.");
    setItemId("");
    setQuantity("1");
    setOpen(false);
    onDone();
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs font-medium text-accent hover:underline">
        + Add component
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select value={itemId} onChange={(e) => setItemId(e.target.value)} className="h-8 min-w-[160px] rounded-md border border-border-strong bg-surface px-2 text-xs">
        <option value="">— item —</option>
        {items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
      </select>
      <input
        type="number"
        min={0}
        step="any"
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        className="h-8 w-20 rounded-md border border-border-strong bg-surface px-2 text-xs"
      />
      <Button type="button" size="sm" onClick={submit} busy={busy} busyLabel="Saving…">
        Add
      </Button>
      <button type="button" onClick={() => setOpen(false)} className="text-xs text-ink-faint hover:text-ink">
        Cancel
      </button>
    </div>
  );
}

function AddOutputForm({
  companyId,
  bomId,
  items,
  onDone,
}: {
  companyId: string;
  bomId: string;
  items: Item[];
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outputType, setOutputType] = useState<OutputType>("scrap");
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [nrvRate, setNrvRate] = useState("0");

  function onItemChange(id: string) {
    setItemId(id);
    const item = items.find((i) => i.id === id);
    if (item?.sale_rate) setNrvRate(String(item.sale_rate));
  }

  async function submit() {
    if (!itemId || !(Number(quantity) > 0) || Number(nrvRate) < 0) {
      toast.error("Pick an item, a positive quantity, and a net realisable value (0 or more).");
      return;
    }
    setBusy(true);
    // bom_outputs is brand new in migration 0114 — not yet in the
    // generated database types (owned by the integration pass), hence
    // the disabled rule below. RLS and the runtime shape are both
    // verified live.
    const payload: Record<string, unknown> = {
      bom_id: bomId,
      company_id: companyId,
      output_type: outputType,
      output_item_id: itemId,
      quantity: Number(quantity),
      nrv_rate: Number(nrvRate),
    };
    const { error } = await createClient()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      .from("bom_outputs" as any)
      .insert(payload);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Output added.");
    setItemId("");
    setQuantity("1");
    setNrvRate("0");
    setOpen(false);
    onDone();
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs font-medium text-accent hover:underline">
        + Add by-product / scrap / co-product
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={outputType}
        onChange={(e) => setOutputType(e.target.value as OutputType)}
        className="h-8 rounded-md border border-border-strong bg-surface px-2 text-xs"
      >
        <option value="scrap">Scrap</option>
        <option value="by_product">By-product</option>
        <option value="co_product">Co-product</option>
      </select>
      <select
        value={itemId}
        onChange={(e) => onItemChange(e.target.value)}
        className="h-8 min-w-[160px] rounded-md border border-border-strong bg-surface px-2 text-xs"
      >
        <option value="">— item —</option>
        {items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
      </select>
      <input
        type="number"
        min={0}
        step="any"
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        title="Quantity per batch (at yield quantity)"
        placeholder="Qty"
        className="h-8 w-20 rounded-md border border-border-strong bg-surface px-2 text-xs"
      />
      <input
        type="number"
        min={0}
        step="any"
        value={nrvRate}
        onChange={(e) => setNrvRate(e.target.value)}
        title="Net realisable value per unit (selling price less further processing/selling costs)"
        placeholder="NRV ₹/unit"
        className="h-8 w-28 rounded-md border border-border-strong bg-surface px-2 text-xs"
      />
      <Button type="button" size="sm" onClick={submit} busy={busy} busyLabel="Saving…">
        Add
      </Button>
      <button type="button" onClick={() => setOpen(false)} className="text-xs text-ink-faint hover:text-ink">
        Cancel
      </button>
    </div>
  );
}

function ProduceForm({
  companyId,
  bom,
  branches,
  godowns,
  hasCoProduct,
  onDone,
}: {
  companyId: string;
  bom: Bom;
  branches: Branch[];
  godowns: Godown[];
  hasCoProduct: boolean;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [quantity, setQuantity] = useState(String(bom.yield_quantity));
  const [additionalCost, setAdditionalCost] = useState("0");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [componentGodown, setComponentGodown] = useState(godowns.find((g) => g.is_default)?.id ?? godowns[0]?.id ?? "");
  const [outputGodown, setOutputGodown] = useState(godowns.find((g) => g.is_default)?.id ?? godowns[0]?.id ?? "");

  const estimatedCost =
    bom.yield_quantity > 0 ? (bom.component_cost_at_yield / bom.yield_quantity) * Number(quantity || 0) : 0;

  async function submit() {
    if (!(Number(quantity) > 0) || !componentGodown || !outputGodown) {
      toast.error("Quantity and both godowns are required.");
      return;
    }
    setBusy(true);
    const { error } = await createClient().rpc("create_production_voucher", {
      p_company_id: companyId,
      p_branch_id: branches[0]?.id,
      p_bom_id: bom.bom_id,
      p_quantity_produced: Number(quantity),
      p_component_godown_id: componentGodown,
      p_output_godown_id: outputGodown,
      p_voucher_date: date,
      p_additional_cost: Number(additionalCost) || 0,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Production posted.");
    setOpen(false);
    onDone();
  }

  if (bom.component_count === 0) {
    return <span className="text-xs text-ink-faint">Add components first</span>;
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-border-strong px-2.5 py-1 text-xs font-medium text-ink hover:bg-accent-soft"
      >
        Produce
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-strong bg-surface-2 p-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-8 rounded-md border border-border-strong bg-surface px-2" />
        <input
          type="number"
          min={0}
          step="any"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          placeholder="Qty to produce"
          className="h-8 w-24 rounded-md border border-border-strong bg-surface px-2"
        />
        <select value={componentGodown} onChange={(e) => setComponentGodown(e.target.value)} title="Consume from" className="h-8 rounded-md border border-border-strong bg-surface px-2">
          {godowns.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} (consume)
            </option>
          ))}
        </select>
        <select value={outputGodown} onChange={(e) => setOutputGodown(e.target.value)} title="Receive into" className="h-8 rounded-md border border-border-strong bg-surface px-2">
          {godowns.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} (receive)
            </option>
          ))}
        </select>
        <input
          type="number"
          min={0}
          step="any"
          value={additionalCost}
          onChange={(e) => setAdditionalCost(e.target.value)}
          placeholder="Additional cost ₹"
          className="h-8 w-28 rounded-md border border-border-strong bg-surface px-2"
        />
      </div>
      <p className="text-xs text-ink-faint">
        Estimated cost: {formatINR(estimatedCost + (Number(additionalCost) || 0), { showZero: true })} (today&rsquo;s
        rates — the actual posting uses rates as at the production date)
      </p>
      {hasCoProduct && (
        <p className="text-xs text-ink-faint">
          This recipe has a co-product — the split against the main product uses the main
          product&rsquo;s own Sale Rate (set it in Items first if it isn&rsquo;t already).
        </p>
      )}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={submit} busy={busy} busyLabel="Posting…">
          Confirm production
        </Button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-ink-faint hover:text-ink">
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ManufacturingManager({
  companyId,
  boms,
  components,
  outputs,
  items,
  branches,
  godowns,
}: {
  companyId: string;
  boms: Bom[];
  components: ComponentRow[];
  outputs: OutputRow[];
  items: Item[];
  branches: Branch[];
  godowns: Godown[];
}) {
  const router = useRouter();

  return (
    <div className="flex flex-col gap-6">
      <NewBomForm companyId={companyId} items={items} />

      {boms.length === 0 ? (
        <EmptyState>No BOMs yet. Create one above, then add its components.</EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          {boms.map((b) => {
            const comps = components.filter((c) => c.bom_id === b.bom_id);
            const outs = outputs.filter((o) => o.bom_id === b.bom_id);
            const hasCoProduct = outs.some((o) => o.output_type === "co_product");
            return (
              <Card key={b.bom_id}>
                <CardBody className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-semibold text-ink">{b.output_item_name}</span>{" "}
                      <span className="text-xs text-ink-faint">
                        {b.name} · yields {formatINR(b.yield_quantity, { showZero: true })} {b.output_uom}
                      </span>
                    </div>
                    <span className="text-xs text-ink-faint">
                      Est. cost/batch: {formatINR(b.component_cost_at_yield, { showZero: true })}
                    </span>
                  </div>

                  <div className="flex flex-col gap-1 text-sm">
                    {comps.length === 0 ? (
                      <p className="text-xs text-ink-faint">No components yet.</p>
                    ) : (
                      comps.map((c) => (
                        <div key={c.id} className="flex justify-between text-xs">
                          <span>{c.item_name}</span>
                          <span className="font-mono tabular-nums text-ink-faint">
                            {formatINR(c.quantity, { showZero: true })} {c.uom}
                          </span>
                        </div>
                      ))
                    )}
                  </div>

                  {outs.length > 0 && (
                    <div className="flex flex-col gap-1 border-t border-border pt-2 text-sm">
                      <span className="text-xs font-medium text-ink-soft">Other outputs</span>
                      {outs.map((o) => (
                        <div key={o.id} className="flex justify-between text-xs">
                          <span>
                            {o.item_name}{" "}
                            <span className="text-ink-faint">({OUTPUT_TYPE_LABEL[o.output_type]})</span>
                          </span>
                          <span className="font-mono tabular-nums text-ink-faint">
                            {formatINR(o.quantity, { showZero: true })} {o.uom} @ {formatINR(o.nrv_rate, { showZero: true })}/unit NRV
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
                    <div className="flex flex-col gap-1">
                      <AddComponentForm companyId={companyId} bomId={b.bom_id} items={items} onDone={() => router.refresh()} />
                      <AddOutputForm companyId={companyId} bomId={b.bom_id} items={items} onDone={() => router.refresh()} />
                    </div>
                    <ProduceForm
                      companyId={companyId}
                      bom={b}
                      branches={branches}
                      godowns={godowns}
                      hasCoProduct={hasCoProduct}
                      onDone={() => router.refresh()}
                    />
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      <p className="text-xs text-ink-faint">
        Every component is consumed at its current weighted-average rate (the same figure
        Reports → Stock summary shows for that item) — the estimate above updates as stock
        moves. A production run posts as a stock journal voucher with a self-cancelling
        &ldquo;Manufacturing Clearing&rdquo; entry, so it carries a real total value for
        audit trail without affecting any real ledger balance, P&amp;L or balance sheet.
        Scrap and by-products are valued at their own net realisable value and netted off the
        main product&rsquo;s cost; co-products instead share the remaining cost with the main
        product in proportion to relative sales value — the standard Ind AS 2 / cost-accounting
        treatment for each. NRV here means selling price less further processing/selling
        costs — enter that net figure by hand, it is not derived automatically.
      </p>
    </div>
  );
}
