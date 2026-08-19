"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

type ModuleRow = {
  code: string;
  name: string;
  // Widened from the DB's plain text column — narrowed at the one place
  // (byTier) that reads it, same as ref_entity_types.tax_audit_report_form
  // elsewhere in this app.
  tier: string;
  active: boolean;
  licensed: boolean;
  can_toggle: boolean;
  locked_reason: string | null;
  depends_on: string[];
  description: string | null;
};

type Tier = "core" | "conditional" | "optional";

const TIER_COPY: Record<Tier, { title: string; blurb: string }> = {
  core: {
    title: "Core",
    blurb: "Always on for every company. Nothing here can be switched off.",
  },
  conditional: {
    title: "Conditional",
    blurb:
      "The system decides these from your registrations and entity type — set the underlying fact (TAN, GSTIN, compliance mode) rather than a switch here.",
  },
  optional: {
    title: "Optional",
    blurb: "Your call. Turn on what this company actually uses.",
  },
};

/** A module's own name, looked up by code, for "requires X" / "used by X" text. */
function nameFor(modules: ModuleRow[], code: string): string {
  return modules.find((m) => m.code === code)?.name ?? code;
}

export function ModuleManager({
  companyId,
  modules,
  isAdmin,
}: {
  companyId: string;
  modules: ModuleRow[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [busyCode, setBusyCode] = useState<string | null>(null);

  async function onToggle(m: ModuleRow) {
    setBusyCode(m.code);
    const { error } = await createClient().rpc("set_module", {
      p_company_id: companyId,
      p_module_code: m.code,
      p_enabled: !m.active,
    });
    setBusyCode(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`${m.name} ${m.active ? "disabled" : "enabled"}`);
    router.refresh();
  }

  const byTier = (tier: Tier) =>
    modules.filter((m) => m.tier === tier);

  return (
    <div className="mt-8 flex flex-col gap-6">
      {(["optional", "conditional", "core"] as const).map((tier) => {
        const rows = byTier(tier);
        if (rows.length === 0) return null;
        const copy = TIER_COPY[tier];
        return (
          <Card key={tier}>
            <CardHeader>
              <h2 className="font-semibold">{copy.title}</h2>
              <p className="mt-0.5 text-sm text-ink-soft">{copy.blurb}</p>
            </CardHeader>
            <CardBody className="flex flex-col divide-y divide-border p-0">
              {rows.map((m) => (
                <div
                  key={m.code}
                  className="flex items-start justify-between gap-4 px-5 py-3.5"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{m.name}</span>
                      <Badge tone={m.active ? "ok" : "neutral"}>
                        {m.active ? "On" : "Off"}
                      </Badge>
                      {tier === "optional" && !m.licensed && (
                        <Badge tone="warn">Not licensed</Badge>
                      )}
                    </div>
                    {m.description && (
                      <p className="mt-0.5 text-sm text-ink-soft">{m.description}</p>
                    )}
                    {tier === "conditional" && m.locked_reason && (
                      <p className="mt-0.5 text-xs text-ink-faint">{m.locked_reason}</p>
                    )}
                    {tier === "optional" && m.depends_on.length > 0 && (
                      <p className="mt-0.5 text-xs text-ink-faint">
                        Requires: {m.depends_on.map((d) => nameFor(modules, d)).join(", ")}
                      </p>
                    )}
                  </div>

                  {tier === "optional" && (
                    <Button
                      type="button"
                      variant={m.active ? "ghost" : "primary"}
                      size="sm"
                      busy={busyCode === m.code}
                      busyLabel="Working…"
                      disabled={!isAdmin || !m.licensed}
                      title={
                        !isAdmin
                          ? "Only an admin can change which modules this company uses"
                          : !m.licensed
                            ? "Not included in this company's plan"
                            : undefined
                      }
                      onClick={() => onToggle(m)}
                      className="shrink-0"
                    >
                      {m.active ? "Disable" : "Enable"}
                    </Button>
                  )}
                </div>
              ))}
            </CardBody>
          </Card>
        );
      })}
    </div>
  );
}
