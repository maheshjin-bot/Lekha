/**
 * lib/capture/analyze.ts mirrors public.ref_uom in a constant, because that
 * module has no database access at all and is not about to grow one (see its
 * header). This suite is what keeps the copy honest.
 *
 * Why it matters more than a normal duplication: public.items.uom carries a
 * FOREIGN KEY to ref_uom(code) (items_uom_fkey), so a code the analyzer emits
 * that the reference table has since dropped is not a slightly-wrong reading —
 * it is a 23503 raised while creating an item master, on a field the preparer
 * never typed. And a code ADDED to ref_uom that the analyzer does not know
 * about is a unit silently read as "unrecognised" forever.
 *
 * Read-only, so it is safe to point at the live project. Set
 * LEKHA_TEST_DATABASE_URL to run it; see tests/helpers/db.ts.
 */
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, hasDb, noDbReason, sql } from "../helpers/db";
import { REF_UOM } from "@/lib/capture/analyze";

afterAll(closeDb);

const describeDb = describe.skipIf(!hasDb);

describeDb(`ref_uom mirror (${hasDb ? "live" : noDbReason})`, () => {
  it("matches public.ref_uom code for code and name for name", async () => {
    const rows = await sql<{ code: string; name: string }>(
      "select code, name from public.ref_uom order by code"
    );

    const live = rows.map((r) => `${r.code}=${r.name}`);
    const mirrored = [...REF_UOM]
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((u) => `${u.code}=${u.name}`);

    // Compared as one array rather than field by field so the failure message
    // names the drifted rows instead of a length.
    expect(mirrored).toEqual(live);
  });
});
