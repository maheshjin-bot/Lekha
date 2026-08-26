/**
 * Generic JSON-Schema (draft-04) walker for the vendored government ITR
 * schemas — see lib/itr/gov-schemas/*.schema.json, downloaded directly from
 * incometax.gov.in during this task (URLs and dates in build-itr-json.ts).
 *
 * WHY GENERIC RATHER THAN HAND-TYPED. ITR-3's own schema alone resolves to
 * 287 named definitions; even restricted to the chain reachable from the
 * form's own top-level `required` array (12 keys for ITR-3, ~10-11 for
 * ITR-5/ITR-6) the required leaves run into the hundreds once schedules
 * like PARTA_PL and ITR3ScheduleBP/CorpScheduleBP are expanded — LEKHA's own
 * chart of accounts cannot supply a real figure for the large majority of
 * them (dozens of ICDS/Sec36/37/40/43B adjustment fields, expense-category
 * splits no accounting system this side of the government's own would carry
 * pre-classified). Hand-authoring a zero-filled skeleton for all of them
 * would be thousands of lines of typed-out field names carrying no
 * information the schema itself doesn't already carry. Walking the real,
 * vendored schema instead means: (a) every REQUIRED key the government
 * actually demands is present, by construction, not by the author
 * remembering to include it; (b) if next year's schema renames or restructures
 * a field, re-running this against the new vendored file catches it, instead
 * of a hand-typed object silently going stale; (c) the small number of
 * fields LEKHA genuinely can compute are overlaid on top by name, in
 * build-itr-json.ts, and are exactly and only what appears in the
 * `populated` manifest shown to the user — nothing is quietly "real" by
 * virtue of matching a hand-typed guess.
 *
 * WHAT THIS DOES NOT DO. This is a REQUIRED-KEY-PRESENCE walker, not a full
 * JSON-Schema validator — it does not check `pattern`, `minLength`,
 * cross-field business rules, or conditional (`if`/`then`) requirements the
 * schema does not express as unconditional `required`. That is a deliberate
 * scope line: the offline utility itself re-validates on "Validate return"
 * before it will let anyone proceed to e-Verify, and is the authoritative
 * final check — this builder's job is to get the shape and the real,
 * traceable figures right, not to reimplement the department's own
 * validator. See build-itr-json.ts's own header for the fuller framing.
 */

export type JsonSchemaDefs = Record<string, JsonSchemaNode>;

export interface JsonSchemaNode {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  enum?: (string | number)[];
  allOf?: JsonSchemaNode[];
  default?: unknown;
  description?: string;
  [k: string]: unknown;
}

/** Resolves a single `$ref` (one hop — every ref in these files points
 * straight at `#/definitions/X`, never chained). Returns the node unchanged
 * if it carries no `$ref`. */
export function derefOnce(node: JsonSchemaNode, defs: JsonSchemaDefs): JsonSchemaNode {
  if (node.$ref) {
    const key = node.$ref.split("/").pop()!;
    const target = defs[key];
    if (!target) throw new Error(`ITR schema: unresolved $ref "${node.$ref}"`);
    return target;
  }
  return node;
}

/** Fully resolves a node: follows `$ref`, then merges in every `allOf`
 * member (also deref'd), with the node's OWN direct keys taking precedence
 * over anything an `allOf` member supplies (matches how these particular
 * files use `allOf` purely to pull in a shared base type like
 * `nonEmptyString` alongside a locally-declared `enum`/`pattern`). */
export function resolve(node: JsonSchemaNode, defs: JsonSchemaDefs): JsonSchemaNode {
  let resolved = derefOnce(node, defs);
  if (resolved.allOf?.length) {
    let merged: JsonSchemaNode = {};
    for (const member of resolved.allOf) {
      merged = { ...merged, ...resolve(member, defs) };
    }
    resolved = { ...merged, ...resolved, allOf: undefined };
  }
  return resolved;
}

/** Per-field defaults for required leaves where the bare schema type
 * doesn't imply a safe/sensible value on its own (an enum with no `default`
 * keyword, chosen deliberately rather than picking enum[0] blindly — see
 * call sites in build-itr-json.ts for why each one was picked). Keyed by
 * the LEAF PROPERTY NAME, which is unique enough across these three schemas
 * for every field this map actually needs to cover; a path-keyed map would
 * be more precise but these names do not collide in practice (checked while
 * writing this against all three vendored files).
 */
export const ENUM_DEFAULT_OVERRIDES: Record<string, string> = {
  // Filing on time, u/s 139(1) — the sensible default for a prep tool; the
  // user changes this in the utility if actually filing late/revised.
  SecondaryAdd: "N",
  AssetOutIndiaFlag: "NO",
  DomesticCompFlg: "Y",
};

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Builds a minimal instance of `defName` that satisfies every REQUIRED key
 * in its own (resolved) subtree — recursively, following only `required`
 * chains, never populating an optional property. `overlayLookup(path)` is
 * consulted at every leaf BEFORE the generic default kicks in; returning
 * anything other than `undefined` short-circuits straight to that value
 * (used by build-itr-json.ts to inject the real, sourced figures).
 *
 * `path` accumulates as `Root.child.grandchild` and is what
 * `overlayLookup` receives and what the returned `touchedRequiredPaths` set
 * records — the latter is this module's own structural self-check (see
 * collectMissingRequiredPaths below).
 */
export function buildMinimalInstance(
  defs: JsonSchemaDefs,
  defName: string,
  overlayLookup: (path: string) => unknown,
  path = defName,
  touchedRequiredPaths: Set<string> = new Set(),
  seen: Set<string> = new Set()
): { value: unknown; touchedRequiredPaths: Set<string> } {
  const overlaid = overlayLookup(path);
  if (overlaid !== undefined) {
    touchedRequiredPaths.add(path);
    return { value: overlaid, touchedRequiredPaths };
  }

  const node = resolve({ $ref: `#/definitions/${defName}` }, defs);
  touchedRequiredPaths.add(path);

  const type = Array.isArray(node.type) ? node.type[0] : node.type;

  if (type === "object" || (!type && node.properties)) {
    const out: Record<string, unknown> = {};
    const required = node.required ?? [];
    // Guard against a self-referential/cyclic required chain (none observed
    // in these three files, but cheap insurance against a future schema
    // revision introducing one and this function looping forever).
    const cycleKey = `${defName}:${path}`;
    if (seen.has(cycleKey)) return { value: {}, touchedRequiredPaths };
    const nextSeen = new Set(seen).add(cycleKey);

    for (const key of required) {
      const propSchema = node.properties?.[key];
      if (!propSchema) continue; // required names a key with no schema — skip rather than crash
      const childPath = `${path}.${key}`;
      const resolvedProp = resolve(propSchema, defs);
      const childRef = propSchema.$ref?.split("/").pop();
      if (childRef) {
        const { value } = buildMinimalInstance(defs, childRef, overlayLookup, childPath, touchedRequiredPaths, nextSeen);
        out[key] = value;
      } else {
        out[key] = buildLeaf(defs, resolvedProp, key, childPath, overlayLookup, touchedRequiredPaths);
      }
    }
    return { value: out, touchedRequiredPaths };
  }

  // A top-level defName that resolves straight to a scalar (not observed
  // among the definitions this builder is actually called with, but handled
  // rather than crashing).
  return { value: buildLeaf(defs, node, defName, path, overlayLookup, touchedRequiredPaths), touchedRequiredPaths };
}

function buildLeaf(
  defs: JsonSchemaDefs,
  node: JsonSchemaNode,
  key: string,
  path: string,
  overlayLookup: (path: string) => unknown,
  touchedRequiredPaths: Set<string>
): unknown {
  const overlaid = overlayLookup(path);
  if (overlaid !== undefined) {
    touchedRequiredPaths.add(path);
    return overlaid;
  }
  touchedRequiredPaths.add(path);

  const type = Array.isArray(node.type) ? node.type[0] : node.type;

  if (node.enum?.length) {
    const override = ENUM_DEFAULT_OVERRIDES[key];
    if (override && node.enum.includes(override)) return override;
    if (node.default !== undefined) return node.default;
    return node.enum[0];
  }
  if (node.default !== undefined) return node.default;
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  if (type === "array") return [];
  if (type === "object" || node.properties) {
    const out: Record<string, unknown> = {};
    for (const req of node.required ?? []) {
      const propSchema = node.properties?.[req];
      if (!propSchema) continue;
      const childRef = propSchema.$ref?.split("/").pop();
      const childPath = `${path}.${req}`;
      if (childRef) {
        const { value } = buildMinimalInstance(defs, childRef, overlayLookup, childPath, touchedRequiredPaths);
        out[req] = value;
      } else {
        out[req] = buildLeaf(defs, resolve(propSchema, defs), req, childPath, overlayLookup, touchedRequiredPaths);
      }
    }
    return out;
  }
  // Plain string leaf, no enum. A required *Date field left un-overlaid
  // still needs to satisfy its own date pattern (all three schemas use
  // "YYYY-MM-DD"), so it gets a real, structurally-valid placeholder date
  // rather than "" — every such field is also listed as a manual-review
  // item in build-itr-json.ts wherever it isn't overlaid with a real date.
  if (/date/i.test(key)) return todayIso();
  return "";
}

/** Walks the same required-chain a second time over an ALREADY-BUILT
 * instance and reports any required path that ended up `undefined` — the
 * structural self-check surfaced in ItrBuildResult.structuralCheck and
 * exercised for real in this task's own hand-verification (see the final
 * report). Independent of buildMinimalInstance's own bookkeeping so a bug in
 * one does not hide a bug in the other. */
export function collectMissingRequiredPaths(
  defs: JsonSchemaDefs,
  defName: string,
  instance: unknown,
  path = defName,
  missing: string[] = [],
  seen: Set<string> = new Set()
): string[] {
  const node = resolve({ $ref: `#/definitions/${defName}` }, defs);
  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  if (type !== "object" && !node.properties) return missing;

  const cycleKey = `${defName}:${path}`;
  if (seen.has(cycleKey)) return missing;
  const nextSeen = new Set(seen).add(cycleKey);

  const obj = (instance ?? {}) as Record<string, unknown>;
  for (const key of node.required ?? []) {
    const childPath = `${path}.${key}`;
    if (!(key in obj) || obj[key] === undefined) {
      missing.push(childPath);
      continue;
    }
    const propSchema = node.properties?.[key];
    const childRef = propSchema?.$ref?.split("/").pop();
    if (childRef) {
      collectMissingRequiredPaths(defs, childRef, obj[key], childPath, missing, nextSeen);
    }
  }
  return missing;
}

/** Sets a value at a dot-path inside a plain object tree, creating
 * intermediate objects as needed. Used by build-itr-json.ts's overlay map
 * (a flat `Record<path, value>` is far easier to review/verify than nested
 * object literals mirroring the government's own nesting) and by
 * ItrDownloadPanel.tsx to merge the browser-typed manual-override fields in
 * just before download. */
export function setAtPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}
