"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { Card, CardBody } from "@/components/ui/Card";
import { setAtPath } from "@/lib/itr/schema-utils";
import type { ItrManualOverrides, SupportedItrForm } from "@/lib/itr/types";

/**
 * Small, never-persisted form for the details LEKHA has no source data for
 * anywhere (auditor particulars, the verifying signatory, contact
 * details) — kept out of the URL and out of the database on purpose (some
 * of these, like a PAN, are personal data with no reason to be stored twice
 * just to build a download). Deep-clones the server-built JSON and patches
 * these paths in only on click, right before the Blob download — mirrors
 * TallyExportPanel's downloadFile pattern.
 */
function downloadFile(filename: string, content: string) {
  const blob = new Blob([content], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ItrDownloadPanel({
  json,
  filename,
  form,
  entityType,
  rootDefName,
}: {
  json: Record<string, unknown>;
  filename: string;
  form: SupportedItrForm;
  entityType: string;
  rootDefName: string;
}) {
  const [overrides, setOverrides] = useState<ItrManualOverrides>({});

  const personalKey = form === "ITR-3" ? "PersonalInfo" : "OrgFirmInfo";
  const genInfo2Key = form === "ITR-6" ? "PartA_GEN2For6" : "PartA_GEN2";

  function set<K extends keyof ItrManualOverrides>(key: K, value: string) {
    setOverrides((o) => ({ ...o, [key]: value || undefined }));
  }

  function handleDownload() {
    const clone = JSON.parse(JSON.stringify(json)) as Record<string, unknown>;
    const R = rootDefName;
    if (overrides.assesseeMobile) setAtPath(clone, `ITR.${R}.PartA_GEN1.${personalKey}.Address.MobileNo`, Number(overrides.assesseeMobile) || 0);
    if (overrides.assesseeEmail) setAtPath(clone, `ITR.${R}.PartA_GEN1.${personalKey}.Address.EmailAddress`, overrides.assesseeEmail);
    if (overrides.auditorName) setAtPath(clone, `ITR.${R}.${genInfo2Key}.AuditInfo.AudFrmName`, overrides.auditorName);
    if (overrides.auditorPan) setAtPath(clone, `ITR.${R}.${genInfo2Key}.AuditInfo.AudFrmPAN`, overrides.auditorPan.toUpperCase());
    if (overrides.auditReportDate) setAtPath(clone, `ITR.${R}.${genInfo2Key}.AuditInfo.AuditReportFurnishDate`, overrides.auditReportDate);
    if (overrides.verifierName) setAtPath(clone, `ITR.${R}.Verification.Declaration.AssesseeVerName`, overrides.verifierName);
    if (overrides.verifierFatherName) setAtPath(clone, `ITR.${R}.Verification.Declaration.FatherName`, overrides.verifierFatherName);
    if (overrides.verifierPan) setAtPath(clone, `ITR.${R}.Verification.Declaration.AssesseeVerPAN`, overrides.verifierPan.toUpperCase());
    if (overrides.place) setAtPath(clone, `ITR.${R}.Verification.Place`, overrides.place);

    downloadFile(filename, JSON.stringify(clone, null, 2));
    toast.success(`Downloaded ${filename}. Open it in the Income Tax Department's offline utility to review and complete before filing.`);
  }

  const overrideCount = useMemo(() => Object.values(overrides).filter(Boolean).length, [overrides]);

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div>
          <p className="text-sm font-medium text-ink">Additional filing details (optional, not saved)</p>
          <p className="text-xs text-ink-faint">
            LEKHA has no register for any of these — typed here only, merged into the download, never stored.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <Label>Mobile number</Label>
            <Input inputMode="numeric" value={overrides.assesseeMobile ?? ""} onChange={(e) => set("assesseeMobile", e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5">
            <Label>Email address</Label>
            <Input type="email" value={overrides.assesseeEmail ?? ""} onChange={(e) => set("assesseeEmail", e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5">
            <Label>Auditor / audit firm name</Label>
            <Input value={overrides.auditorName ?? ""} onChange={(e) => set("auditorName", e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5">
            <Label>Auditor PAN</Label>
            <Input value={overrides.auditorPan ?? ""} onChange={(e) => set("auditorPan", e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5">
            <Label>Audit report date</Label>
            <Input type="date" value={overrides.auditReportDate ?? ""} onChange={(e) => set("auditReportDate", e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5">
            <Label>Verifier&rsquo;s name (signing the declaration)</Label>
            <Input value={overrides.verifierName ?? ""} onChange={(e) => set("verifierName", e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5">
            <Label>Verifier&rsquo;s father&rsquo;s name</Label>
            <Input value={overrides.verifierFatherName ?? ""} onChange={(e) => set("verifierFatherName", e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5">
            <Label>Verifier&rsquo;s PAN (if different from the entity&rsquo;s)</Label>
            <Input value={overrides.verifierPan ?? ""} onChange={(e) => set("verifierPan", e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5">
            <Label>Place</Label>
            <Input value={overrides.place ?? ""} onChange={(e) => set("place", e.target.value)} />
          </label>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <p className="text-xs text-ink-faint">
            {entityType ? `Entity type: ${entityType}. ` : ""}
            {overrideCount > 0 ? `${overrideCount} detail(s) above will be merged in.` : "Downloads with placeholders where these are blank."}
          </p>
          <Button type="button" onClick={handleDownload}>
            Download JSON
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
