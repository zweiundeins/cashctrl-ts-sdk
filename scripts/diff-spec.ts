/**
 * Compares two scraped specs and writes a human-readable summary of what
 * CashCtrl changed upstream.
 *
 * The generated TypeScript diff is enormous and unreadable; this is the diff
 * you actually want to review. Used as the body of the weekly upstream PR.
 *
 * Run: deno run --allow-read --allow-write scripts/diff-spec.ts old.json new.json [--out FILE]
 */

import type { Param, Spec } from "./ir.ts";

const [oldPath, newPath] = Deno.args.filter((a) => !a.startsWith("--"));
if (!oldPath || !newPath) {
  console.error(
    "usage: diff-spec.ts <old.json> <new.json> [--out FILE]",
  );
  Deno.exit(1);
}

const outIdx = Deno.args.indexOf("--out");
const outPath = outIdx >= 0 ? Deno.args[outIdx + 1] : undefined;

const before: Spec = JSON.parse(await Deno.readTextFile(oldPath));
const after: Spec = JSON.parse(await Deno.readTextFile(newPath));

const byPath = (s: Spec) => new Map(s.endpoints.map((e) => [e.path, e]));
const oldEndpoints = byPath(before);
const newEndpoints = byPath(after);

const added = [...newEndpoints.keys()].filter((p) => !oldEndpoints.has(p));
const removed = [...oldEndpoints.keys()].filter((p) => !newEndpoints.has(p));

interface ParamChange {
  path: string;
  added: string[];
  removed: string[];
  changed: string[];
}

function describe(p: Param): string {
  const bits = [p.type, p.required ? "mandatory" : "optional"];
  if (p.maxLength) bits.push(`max:${p.maxLength}`);
  if (p.enum?.length) bits.push(`enum:${p.enum.join("|")}`);
  return bits.join(", ");
}

const paramChanges: ParamChange[] = [];
for (const [path, next] of newEndpoints) {
  const prev = oldEndpoints.get(path);
  if (!prev) continue;

  const prevParams = new Map(prev.params.map((p) => [p.name, p]));
  const nextParams = new Map(next.params.map((p) => [p.name, p]));

  const change: ParamChange = { path, added: [], removed: [], changed: [] };

  for (const [name, p] of nextParams) {
    const old = prevParams.get(name);
    if (!old) {
      change.added.push(`${name} (${describe(p)})`);
    } else if (describe(old) !== describe(p)) {
      change.changed.push(`${name}: ${describe(old)} -> ${describe(p)}`);
    }
  }
  for (const name of prevParams.keys()) {
    if (!nextParams.has(name)) change.removed.push(name);
  }

  if (change.added.length || change.removed.length || change.changed.length) {
    paramChanges.push(change);
  }
}

const changedSummaries = [...newEndpoints].filter(([path, next]) => {
  const prev = oldEndpoints.get(path);
  return prev && prev.summary !== next.summary;
});

/* ------------------------------------------------------------- report --- */

const lines: string[] = [];
const total = added.length + removed.length + paramChanges.length;

if (total === 0) {
  lines.push("No API changes detected.");
  lines.push("");
  lines.push(
    `Both specs describe ${after.endpoints.length} endpoints with identical ` +
      `parameters.`,
  );
} else {
  lines.push(
    `**${before.endpoints.length} -> ${after.endpoints.length} endpoints.** ` +
      `${added.length} added, ${removed.length} removed, ` +
      `${paramChanges.length} with parameter changes.`,
  );
  lines.push("");

  if (removed.length) {
    lines.push("## Removed endpoints");
    lines.push("");
    lines.push("These are breaking: generated methods for them disappear.");
    lines.push("");
    for (const path of removed.sort()) {
      lines.push(`- \`${oldEndpoints.get(path)!.method} ${path}\``);
    }
    lines.push("");
  }

  if (added.length) {
    lines.push("## New endpoints");
    lines.push("");
    for (const path of added.sort()) {
      const e = newEndpoints.get(path)!;
      lines.push(`- \`${e.method} ${path}\` - ${e.summary}`);
    }
    lines.push("");
  }

  if (paramChanges.length) {
    lines.push("## Parameter changes");
    lines.push("");
    for (
      const change of paramChanges.sort((a, b) => a.path.localeCompare(b.path))
    ) {
      lines.push(`### \`${change.path}\``);
      for (const p of change.removed) lines.push(`- removed: \`${p}\``);
      for (const p of change.changed) lines.push(`- changed: \`${p}\``);
      for (const p of change.added) lines.push(`- added: \`${p}\``);
      lines.push("");
    }
  }

  if (changedSummaries.length) {
    lines.push("## Reworded descriptions");
    lines.push("");
    for (const [path, next] of changedSummaries) {
      lines.push(
        `- \`${path}\`: "${
          oldEndpoints.get(path)!.summary
        }" -> "${next.summary}"`,
      );
    }
    lines.push("");
  }
}

const report = lines.join("\n") + "\n";
if (outPath) {
  await Deno.writeTextFile(outPath, report);
  console.log(`wrote ${outPath}`);
} else {
  console.log(report);
}

// Exit 1 signals "there are changes", so CI can branch on it.
Deno.exit(total === 0 ? 0 : 1);
