/**
 * ref_states.code (GST/Census-2011 numbering, used everywhere else in this
 * app — GSTINs, gst_registrations.state_code, branches.state_code) is NOT
 * the same numbering the ITR JSON schema uses for Address.StateCode. This
 * is exactly the kind of "obvious answer" trap the task brief warned about:
 * reusing ref_states.code directly would have silently written the wrong
 * state onto every single generated return.
 *
 * Confirmed live by pulling the ITR-3 AY 2026-27 schema's own
 * `definitions.StateCode.description` (lib/itr/gov-schemas/itr3.schema.json,
 * downloaded from incometax.gov.in during this task — see
 * build-itr-json.ts's header for the exact URL/date), which spells out its
 * own code list in full:
 *
 *   01-Andaman and Nicobar islands; 02-Andhra Pradesh; 03-Arunachal Pradesh;
 *   04-Assam; 05-Bihar; 06-Chandigarh; 07-Dadra Nagar and Haveli; 08-Daman
 *   and Diu; 09-Delhi; 10-Goa; 11-Gujarat; 12-Haryana; 13-Himachal Pradesh;
 *   14-Jammu and Kashmir; 15-Karnataka; 16-Kerala; 17-Lakshadweep;
 *   18-Madhya Pradesh; 19-Maharashtra; 20-Manipur; 21-Meghalaya;
 *   22-Mizoram; 23-Nagaland; 24-Odisha; 25-Puducherry; 26-Punjab;
 *   27-Rajasthan; 28-Sikkim; 29-Tamil Nadu; 30-Tripura; 31-Uttar Pradesh;
 *   32-West Bengal; 33-Chhattisgarh; 34-Uttarakhand; 35-Jharkhand;
 *   36-Telangana; 37-Ladakh; 99-Foreign
 *
 * This is an ALPHABETICAL list (the Income Tax Department's own long-standing
 * State Master), completely different from GST's numeric state codes (where,
 * for example, 07 = Delhi and 27 = Maharashtra — under the ITR list above, 07
 * = Dadra Nagar and Haveli and 27 = Rajasthan). The two numberings share no
 * relationship beyond both happening to run 01-37ish.
 *
 * The crosswalk below was built by matching STATE NAME between that live
 * schema description and this app's own `ref_states` table (`select code,
 * name from ref_states order by code`, run live during this task) — not by
 * assuming any positional/arithmetic relationship between the two numbering
 * schemes, because there isn't one.
 *
 * Two rows are genuine best-effort approximations, called out explicitly
 * rather than silently guessed:
 *   - ref_states '26' (Dadra and Nagar Haveli and Daman and Diu — the
 *     post-2020 MERGED union territory, GST's current code) has no single
 *     matching entry in the ITR list above, which still carries the two
 *     pre-merger territories separately ('07' Dadra Nagar and Haveli, '08'
 *     Daman and Diu) — the ITR State Master has evidently not been updated
 *     for the 2020 UT merger. Mapped to '07' as the closer-population match;
 *     flagged in the UI wherever it fires.
 *   - ref_states '97' (Other Territory — this app's placeholder for
 *     territorial waters/continental shelf, used only as a GST place-of-supply
 *     value) has no domestic equivalent in the ITR list at all. Mapped to
 *     '99' (Foreign) as the least-wrong available code; flagged in the UI.
 */
export const GST_STATE_CODE_TO_ITR_STATE_CODE: Record<string, string> = {
  "01": "14", // Jammu and Kashmir
  "02": "13", // Himachal Pradesh
  "03": "26", // Punjab
  "04": "06", // Chandigarh
  "05": "34", // Uttarakhand
  "06": "12", // Haryana
  "07": "09", // Delhi
  "08": "27", // Rajasthan
  "09": "31", // Uttar Pradesh
  "10": "05", // Bihar
  "11": "28", // Sikkim
  "12": "03", // Arunachal Pradesh
  "13": "23", // Nagaland
  "14": "20", // Manipur
  "15": "22", // Mizoram
  "16": "30", // Tripura
  "17": "21", // Meghalaya
  "18": "04", // Assam
  "19": "32", // West Bengal
  "20": "35", // Jharkhand
  "21": "24", // Odisha
  "22": "33", // Chhattisgarh
  "23": "18", // Madhya Pradesh
  "24": "11", // Gujarat
  "25": "08", // Daman and Diu (pre-merger)
  "26": "07", // Dadra & Nagar Haveli + Daman & Diu (merged UT) — approximation, see header
  "27": "19", // Maharashtra
  "28": "02", // Andhra Pradesh (before bifurcation) — legacy code, approximation
  "29": "15", // Karnataka
  "30": "10", // Goa
  "31": "17", // Lakshadweep
  "32": "16", // Kerala
  "33": "29", // Tamil Nadu
  "34": "25", // Puducherry
  "35": "01", // Andaman and Nicobar Islands
  "36": "36", // Telangana
  "37": "02", // Andhra Pradesh
  "38": "37", // Ladakh
  "96": "99", // Other Country -> Foreign
  "97": "99", // Other Territory -> Foreign — no domestic equivalent, approximation
};

/** Rows where the mapping above is a genuine best-effort approximation
 * (not a clean 1:1 name match) — surfaced as a warning when hit. */
export const APPROXIMATE_STATE_CODES = new Set(["26", "28", "97"]);

export function gstStateCodeToItrStateCode(gstCode: string | null | undefined): {
  itrCode: string;
  approximate: boolean;
} {
  if (!gstCode || !(gstCode in GST_STATE_CODE_TO_ITR_STATE_CODE)) {
    return { itrCode: "99", approximate: true };
  }
  return {
    itrCode: GST_STATE_CODE_TO_ITR_STATE_CODE[gstCode],
    approximate: APPROXIMATE_STATE_CODES.has(gstCode),
  };
}
