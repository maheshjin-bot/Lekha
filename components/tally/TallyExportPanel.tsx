"use client";

import { useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { Card, CardBody } from "@/components/ui/Card";
import {
  buildGroupsXml,
  buildLedgersXml,
  buildVouchersXml,
  wrapMastersEnvelope,
  wrapVouchersEnvelope,
  type ExportGroup,
  type ExportLedger,
  type ExportVoucher,
} from "@/lib/tally/xml";

function downloadFile(filename: string, content: string) {
  const blob = new Blob([content], { type: "application/xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function TallyExportPanel({
  companyId,
  companyName,
  period,
}: {
  companyId: string;
  companyName: string;
  period: { from: string; to: string; label: string };
}) {
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  const [busyMasters, setBusyMasters] = useState(false);
  const [busyVouchers, setBusyVouchers] = useState(false);

  const fileStem = companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  async function exportMasters() {
    setBusyMasters(true);
    const supabase = createClient();
    const [{ data: groups, error: gErr }, { data: ledgers, error: lErr }] = await Promise.all([
      supabase.from("account_groups").select("id, name, parent_group_id").eq("company_id", companyId),
      supabase
        .from("ledgers")
        .select(
          "id, name, group_id, gstin, pan, address, city, pincode, email, phone, opening_balance_amount, opening_balance_type, ref_states(name)"
        )
        .eq("company_id", companyId),
    ]);
    setBusyMasters(false);
    if (gErr || lErr) {
      toast.error(gErr?.message ?? lErr?.message ?? "Could not load masters.");
      return;
    }

    const exportGroups: ExportGroup[] = (groups ?? []).map((g) => ({
      id: g.id,
      name: g.name,
      parent_group_id: g.parent_group_id,
    }));
    const exportLedgers: ExportLedger[] = (ledgers ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      group_id: l.group_id,
      gstin: l.gstin,
      pan: l.pan,
      address: l.address,
      city: l.city,
      pincode: l.pincode,
      state_name: (l.ref_states as unknown as { name: string } | null)?.name ?? null,
      email: l.email,
      phone: l.phone,
      opening_balance_amount: Number(l.opening_balance_amount) || 0,
      opening_balance_type: l.opening_balance_type,
    }));

    const groupsXml = buildGroupsXml(exportGroups);
    const customGroupCount = (groupsXml.match(/<GROUP /g) ?? []).length;
    const body = [groupsXml, buildLedgersXml(exportLedgers, exportGroups)].filter(Boolean).join("\n");
    downloadFile(`${fileStem}-tally-masters.xml`, wrapMastersEnvelope(body));
    toast.success(
      `Exported ${customGroupCount} custom group${customGroupCount === 1 ? "" : "s"} and ${exportLedgers.length} ledger${exportLedgers.length === 1 ? "" : "s"}.`
    );
  }

  async function exportVouchers() {
    setBusyVouchers(true);
    const supabase = createClient();
    const { data: vouchers, error } = await supabase
      .from("vouchers")
      .select("id, voucher_type, voucher_number, voucher_date, narration, voucher_entries(debit_amount, credit_amount, ledgers(name))")
      .eq("company_id", companyId)
      .eq("is_deleted", false)
      .gte("voucher_date", from)
      .lte("voucher_date", to)
      .order("voucher_date");
    setBusyVouchers(false);
    if (error) {
      toast.error(error.message);
      return;
    }

    const exportedVouchers: ExportVoucher[] = (vouchers ?? []).map((v) => ({
      voucher_type: v.voucher_type,
      voucher_number: v.voucher_number,
      voucher_date: v.voucher_date,
      narration: v.narration,
      entries: (v.voucher_entries as unknown as { debit_amount: number; credit_amount: number; ledgers: { name: string } | null }[]).map(
        (e) => ({
          ledger_name: e.ledgers?.name ?? "",
          debit_amount: Number(e.debit_amount) || 0,
          credit_amount: Number(e.credit_amount) || 0,
        })
      ),
    }));

    const skipped = exportedVouchers.length;
    const body = buildVouchersXml(exportedVouchers);
    const included = (body.match(/<TALLYMESSAGE/g) ?? []).length;
    downloadFile(`${fileStem}-tally-vouchers.xml`, wrapVouchersEnvelope(body));
    toast.success(
      `Exported ${included} voucher${included === 1 ? "" : "s"}` +
        (skipped > included ? ` (${skipped - included} skipped — no Tally equivalent for that voucher type)` : ".")
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardBody className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <Label>From</Label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>To</Label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>

          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-ink">1. Masters — groups and ledgers</p>
                <p className="text-xs text-ink-faint">Import this file into Tally first, before any voucher file.</p>
              </div>
              <Button type="button" onClick={exportMasters} busy={busyMasters} busyLabel="Preparing…">
                Download masters
              </Button>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-ink">2. Vouchers ({period.label} by default — adjust above)</p>
                <p className="text-xs text-ink-faint">
                  Receipt, payment, contra, journal, sales, purchase, credit note, debit note. Item-level
                  invoice detail, job work, and production vouchers aren&rsquo;t exported &mdash; this
                  feature&rsquo;s scope is plain accounting vouchers only.
                </p>
              </div>
              <Button type="button" onClick={exportVouchers} busy={busyVouchers} busyLabel="Preparing…">
                Download vouchers
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>

      <p className="text-xs text-ink-faint">
        In Tally: Gateway of Tally → Import Data (Alt+O), and consider enabling &ldquo;Ignore
        error &amp; continue during data import&rdquo; (F12) so one bad line doesn&rsquo;t abort
        the whole batch — then check the Exceptions report afterward. Ledgers reference their
        chart-of-accounts group by name; LEKHA&rsquo;s Schedule III groups that don&rsquo;t match
        one of Tally&rsquo;s own reserved groups (Current Assets, Sundry Debtors, etc.) are created
        as new custom groups under Tally&rsquo;s Primary list.
      </p>
    </div>
  );
}
