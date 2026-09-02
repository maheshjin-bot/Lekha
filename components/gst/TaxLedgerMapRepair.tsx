"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/supabase/rpc";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

/** The 11 registration-scoped purposes app_private.seed_gst_ledgers owns. */
const PURPOSES = [
  "output_cgst",
  "output_sgst",
  "output_igst",
  "output_cess",
  "input_cgst",
  "input_sgst",
  "input_igst",
  "input_cess",
  "rcm_payable",
  "gst_payable",
  "gst_refund_receivable",
] as const;

const PURPOSE_LABEL: Record<string, string> = {
  output_cgst: "Output CGST",
  output_sgst: "Output SGST / UTGST",
  output_igst: "Output IGST",
  output_cess: "Output Cess",
  input_cgst: "Input CGST",
  input_sgst: "Input SGST / UTGST",
  input_igst: "Input IGST",
  input_cess: "Input Cess",
  rcm_payable: "RCM Payable",
  gst_payable: "GST Payable",
  gst_refund_receivable: "GST Refund Receivable",
};

export type RegistrationRow = {
  id: string;
  gstin: string;
  state_code: string;
  is_active: boolean;
};

export type MappedRow = {
  gst_registration_id: string | null;
  purpose: string;
  ledger_name: string;
};

type RepairRow = {
  tax_purpose: string;
  ledger_name: string | null;
  action: string;
};

export function TaxLedgerMapRepair({
  companyId,
  registrations,
  mapped,
  isAdmin,
}: {
  companyId: string;
  registrations: RegistrationRow[];
  mapped: MappedRow[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RepairRow[]>>({});

  async function onRepair(registrationId: string) {
    setBusyId(registrationId);
    // callRpc, not supabase.rpc: repair_gst_ledger_map (1550) is not in
    // types/database.types.ts yet, and regenerating that file here would
    // sweep in every other RPC a concurrent session has shipped live today.
    const { data, error } = await callRpc<Record<string, unknown>, RepairRow[]>(
      createClient(),
      "repair_gst_ledger_map",
      { p_company_id: companyId, p_registration_id: registrationId }
    );
    setBusyId(null);

    if (error) {
      toast.error(error.message);
      return;
    }

    const rows = data ?? [];
    setResults((prev) => ({ ...prev, [registrationId]: rows }));

    const fixed = rows.filter((r) => r.action !== "already mapped").length;
    toast.success(
      fixed === 0
        ? "Nothing to repair — all 11 tax ledgers were already mapped."
        : `${fixed} tax ledger${fixed === 1 ? "" : "s"} mapped.`
    );
    router.refresh();
  }

  if (registrations.length === 0) {
    return (
      <Card className="mt-8">
        <CardBody>
          <p className="text-sm text-ink-soft">
            This company has no GST registration, so there is no tax-ledger map to
            repair. Nothing here applies until a GSTIN is added under Registrations.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="mt-8 flex flex-col gap-6">
      {registrations.map((reg) => {
        const forReg = new Map(
          mapped
            .filter((m) => m.gst_registration_id === reg.id)
            .map((m) => [m.purpose, m.ledger_name])
        );
        const missing = PURPOSES.filter((p) => !forReg.has(p));
        const result = results[reg.id];

        return (
          <Card key={reg.id}>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-mono font-semibold">{reg.gstin}</h2>
                    {missing.length === 0 ? (
                      <Badge tone="ok">All 11 mapped</Badge>
                    ) : (
                      <Badge tone="warn">
                        {missing.length} of 11 missing
                      </Badge>
                    )}
                    {!reg.is_active && <Badge tone="neutral">Inactive</Badge>}
                  </div>
                  <p className="mt-0.5 text-sm text-ink-soft">
                    {missing.length === 0
                      ? "Every tax purpose resolves to a ledger. An invoice under this GSTIN has somewhere to post its tax."
                      : "An invoice under this GSTIN will be refused until every purpose below resolves to a ledger."}
                  </p>
                </div>
                <Button
                  type="button"
                  variant={missing.length === 0 ? "ghost" : "primary"}
                  size="sm"
                  busy={busyId === reg.id}
                  busyLabel="Repairing…"
                  disabled={!isAdmin}
                  title={
                    !isAdmin
                      ? "Only a company admin can create and map a tax ledger"
                      : undefined
                  }
                  onClick={() => onRepair(reg.id)}
                  className="shrink-0"
                >
                  Repair
                </Button>
              </div>
            </CardHeader>

            <CardBody className="p-0">
              <table className="w-full text-sm">
                <tbody>
                  {PURPOSES.map((p) => {
                    const ledger = forReg.get(p) ?? null;
                    const said = result?.find((r) => r.tax_purpose === p);
                    return (
                      <tr key={p} className="border-t border-border">
                        <td className="px-5 py-2 text-ink-soft">
                          {PURPOSE_LABEL[p]}
                        </td>
                        <td className="px-5 py-2">
                          {ledger ? (
                            <span className="text-ink">{ledger}</span>
                          ) : (
                            <span className="text-warning">Not mapped</span>
                          )}
                        </td>
                        <td className="px-5 py-2 text-right text-xs text-ink-faint">
                          {said && said.action !== "already mapped" ? said.action : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardBody>
          </Card>
        );
      })}

      <p className="text-xs text-ink-faint">
        Repair is safe to press more than once: a purpose that already resolves is
        left exactly where it is, never re-pointed, because moving it would strand
        tax already posted to the old ledger. Where the map has lost a row but the
        ledger it named is still in the chart of accounts, that ledger is adopted
        rather than duplicated. New ledgers are created under Duties &amp; Taxes with
        the same names, state suffix and UTGST substitution the original seeding
        uses, so a repaired ledger is indistinguishable from a seeded one.
      </p>
    </div>
  );
}
