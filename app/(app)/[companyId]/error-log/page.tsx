import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import {
  DEFAULT_RANGE,
  ErrorLogView,
  RANGES,
  sinceForRange,
  type ErrorLogRow,
} from "@/components/errors/ErrorLogView";

/**
 * /[companyId]/error-log — the screen the owner asked for after bill capture
 * failed with a message that told them nothing and the real cause (Google
 * replying 503) was only visible over SSH.
 *
 * Server-rendered, no client JavaScript: the filters are links and the
 * technical-detail disclosure is a native <details>. A page whose entire
 * purpose is to be readable when something else has broken should carry as
 * little of its own machinery as possible.
 *
 * get_error_log (migration 0950) raises for a non-admin rather than returning
 * an empty list, so "you are not allowed to see this" and "nothing has gone
 * wrong" stay distinguishable on screen — an empty list here genuinely means
 * good news.
 */
export default async function ErrorLogPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/error-log">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const rangeKey =
    typeof sp.range === "string" && RANGES.some((r) => r.key === sp.range) ? sp.range : DEFAULT_RANGE;
  const operation = typeof sp.op === "string" && sp.op !== "" ? sp.op : undefined;

  const since = sinceForRange(rangeKey);

  // error_log and get_error_log are new in 0950 and types/database.types.ts
  // does not know them (that file is owned by a concurrent session this
  // session must not touch). Same untyped-RPC escape hatch the rest of the
  // app already uses for a just-shipped function.
  const { data, error } = await callRpc<
    {
      p_company_id: string;
      p_operation: string | null;
      p_since: string;
      p_severity: string | null;
      p_limit: number;
    },
    ErrorLogRow[]
  >(supabase, "get_error_log", {
    p_company_id: companyId,
    p_operation: operation ?? null,
    p_since: since,
    p_severity: null,
    p_limit: 200,
  });

  return (
    <ErrorLogView
      companyId={companyId}
      rows={data ?? []}
      rangeKey={rangeKey}
      operation={operation}
      errorMessage={error?.message ?? null}
    />
  );
}
