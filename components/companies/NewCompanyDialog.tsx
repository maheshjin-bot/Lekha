"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { CreateCompanyForm } from "@/components/companies/CreateCompanyForm";

/**
 * Companies page's "+ New company" button plus the dialog it opens. Kept
 * separate from CreateCompanyForm so that form stays a plain form — this is
 * the only piece that knows it lives in a modal.
 */
export function NewCompanyDialog({
  entityTypes,
  states,
  triggerLabel = "New company",
  triggerClassName,
}: {
  entityTypes: { code: string; name: string }[];
  states: { code: string; name: string }[];
  triggerLabel?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          triggerClassName ??
          "inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90"
        }
      >
        <Plus size={16} />
        {triggerLabel}
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New company"
        description="Creating a company seeds its chart of accounts and a Head Office branch, then resolves which modules apply. Nothing to configure afterwards."
      >
        <CreateCompanyForm entityTypes={entityTypes} states={states} />
      </Modal>
    </>
  );
}
