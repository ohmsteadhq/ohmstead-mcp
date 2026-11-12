// Ohmstead domain layer for the MCP tools: catalog lookups, project load/save
// with optimistic concurrency, endpoint parsing, and plain-text rendering.

import type { SupabaseClient } from "@supabase/supabase-js";
import { blockOf, findStripPort, jumpered, levelsAt, missingLevel, projectStripBom, ROLE_LABEL, stripParts } from "@/lib/doc/blocks";
import { conductorsOf, placedConnector } from "@/lib/doc/cables";
import { harnessesOf, harnessOfWire, harnessShown, minWiresOf, withHarnessTags } from "@/lib/doc/harnesses";
import { isPlcPart, mountOf } from "@/lib/doc/rack";
import { endLabel, findIssues, signalLabel, tagOf } from "@/lib/doc/issues";
import { connectionGauge, formatGauge, unitsOf } from "@/lib/doc/gauge";
import { currentRollup, formatAmps } from "@/lib/sizing/current";
import { formatLength, lengthOf, lengthUnitOf } from "@/lib/sizing/drop";
import { pidSymbol } from "@/lib/pid/symbols";
import { pidTagOf } from "@/lib/pid/tags";
import type { Catalog } from "@/lib/schematic";
import { connectorsOf, normalizeDoc, normalizePart, type Block, type Component, type Connection, type Manufacturer, type Part, type ProjectRow, type SignalType, type WireDoc } from "@/lib/types";

export class UserError extends Error {}

/** Same messages the app shows for Postgres/PostgREST errors. */
export function friendlyError(e: unknown): string {
  const msg = (e as { message?: string })?.message ?? String(e);
  if (msg.includes("FREE_PROJECT_LIMIT")) return "Free plan is limited to 3 projects. Upgrade to Pro for unlimited projects.";
  if (msg.includes("PART_INCOMPLETE:")) return msg.split("PART_INCOMPLETE:")[1].trim();
  if (msg.includes("duplicate key") && msg.includes("part_ports")) return "That terminal already exists on this part.";
  if (msg.includes("duplicate key")) return "That name is already taken.";
  if (msg.includes("row-level security")) return "You don't have permission to change that.";
  // Team rules raise "CODE: sentence"; show the sentence.
  const coded = msg.match(/\b(?:TEAM_[A-Z_]+|PROJECT_(?:LOCKED|MOVE|GUARD)|EDIT_LOCKED|SHARE_NOT_MEMBER):\s*(.+)/);
  if (coded) return coded[1].trim();
  return msg;
}

export type TeamRole = "owner" | "admin" | "editor" | "viewer";
/** A team or class the user is in (my_teams). */
export type MyTeam = {
  id: string;
  name: string;
  kind: "team" | "class";
  role: TeamRole;
  active: boolean;
  writable: boolean;
  term_ends_at: string | null;
  archived_at: string | null;
};

export function roleLabel(kind: MyTeam["kind"], role: TeamRole): string {
  if (kind === "class") return { owner: "Instructor", admin: "TA", editor: "Student", viewer: "Viewer" }[role];
  return { owner: "Owner", admin: "Admin", editor: "Editor", viewer: "Viewer" }[role];
}

const RANK: Record<TeamRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };
export const atLeast = (t: MyTeam, role: TeamRole) => RANK[t.role] >= RANK[role];

export function check<T>(res: { data: T; error: unknown }): T {
  if (res.error) throw new UserError(friendlyError(res.error));
  return res.data;
}

const sortPorts = normalizePart;

/** Hosted runs: the signed-in user is known up front, and background work goes to `defer` (Workers waitUntil). */
export type RunOptions = { userId?: string; defer?: (work: Promise<unknown>) => void };

export class Ohmstead {
  private cat: Catalog | null = null;
  private myTeams: MyTeam[] | null = null;
  constructor(
    readonly db: SupabaseClient,
    private readonly opts: RunOptions = {},
  ) {}

  async userId(): Promise<string> {
    if (this.opts.userId) return this.opts.userId;
    const { data } = await this.db.auth.getUser();
    if (!data.user) throw new UserError("Not signed in. Run `ohmstead-mcp login`.");
    return data.user.id;
  }

  // -------------------------------------------------------------------------
  // Catalog (parts visible to the user, signal types, manufacturers)
  // -------------------------------------------------------------------------
  async catalog(fresh = false): Promise<Catalog> {
    if (this.cat && !fresh) return this.cat;
    const [parts, signals, mfrs] = await Promise.all([
      this.db.from("parts").select("*, part_ports(*)").order("name"),
      this.db.from("signal_types").select("*").order("name"),
      this.db.from("manufacturers").select("*").order("name"),
    ]);
    this.cat = {
      parts: new Map((check(parts) as Part[]).map((p) => [p.id, sortPorts(p)])),
      signals: new Map((check(signals) as SignalType[]).map((s) => [s.id, s])),
      manufacturers: new Map((check(mfrs) as Manufacturer[]).map((m) => [m.id, m])),
    };
    return this.cat;
  }

  invalidate() {
    this.cat = null;
  }

  async signal(ref: string): Promise<SignalType> {
    const cat = await this.catalog();
    const byId = cat.signals.get(ref);
    if (byId) return byId;
    const q = ref.trim().toLowerCase();
    const hits = [...cat.signals.values()].filter((s) => s.name.toLowerCase() === q);
    if (hits.length === 1) return hits[0];
    const loose = [...cat.signals.values()].filter((s) => s.name.toLowerCase().includes(q));
    if (loose.length === 1) return loose[0];
    throw new UserError(
      `Unknown signal type "${ref}". Options: ${[...cat.signals.values()].map((s) => s.name).join(", ")}`,
    );
  }

  async manufacturer(ref: string): Promise<Manufacturer> {
    const cat = await this.catalog();
    const byId = cat.manufacturers.get(ref);
    if (byId) return byId;
    const q = ref.trim().toLowerCase();
    const hit = [...cat.manufacturers.values()].find((m) => m.name.toLowerCase() === q || m.short_code.toLowerCase() === q);
    if (hit) return hit;
    throw new UserError(
      `Unknown manufacturer "${ref}". Options: ${[...cat.manufacturers.values()].map((m) => m.name).join(", ")}`,
    );
  }

  async part(id: string): Promise<Part> {
    const p = (await this.catalog()).parts.get(id);
    if (!p) throw new UserError(`No Codex part with id ${id} (or it isn't visible to you).`);
    return p;
  }

  // -------------------------------------------------------------------------
  // Teams
  // -------------------------------------------------------------------------
  async teams(): Promise<MyTeam[]> {
    this.myTeams ??= (check(await this.db.rpc("my_teams")) ?? []) as MyTeam[];
    return this.myTeams;
  }

  /** A team the user is in, by id or name (case-insensitive). */
  async team(ref: string): Promise<MyTeam> {
    const teams = await this.teams();
    const q = ref.trim().toLowerCase();
    const hit = teams.find((t) => t.id === ref.trim()) ?? teams.find((t) => t.name.toLowerCase() === q);
    if (hit) return hit;
    throw new UserError(
      teams.length ? `You aren't in a team "${ref}". Your teams: ${teams.map((t) => t.name).join(", ")}.` : "You aren't in any team or class.",
    );
  }

  /** A team the user can add to: editor or up, and the team is active and before its term end. */
  async writableTeam(ref: string): Promise<MyTeam> {
    const t = await this.team(ref);
    if (!atLeast(t, "editor")) throw new UserError(`You're a ${roleLabel(t.kind, t.role).toLowerCase()} in ${t.name}, so you can't add to it.`);
    if (!t.writable) throw new UserError(`${t.name} is read-only (${t.archived_at ? "archived" : !t.active ? "needs an active plan or a verified class" : "past its term end"}).`);
    return t;
  }

  /** Throws a UserError saying why the user can't change this project, if they can't. */
  async assertEditable(row: ProjectRow): Promise<void> {
    const uid = await this.userId();
    if (!row.team_id) {
      if (row.user_id !== uid) throw new UserError("You can only edit your own projects.");
    } else if (!(check(await this.db.rpc("can_edit_project", { pid: row.id })) as boolean)) {
      const t = (await this.teams()).find((x) => x.id === row.team_id);
      throw new UserError(
        t && !t.writable
          ? `${t.name} is read-only (archived, inactive or past its term end).`
          : "You can view this team project but not edit it. Ask its creator or a team admin to share it with you as an editor.",
      );
    }
    if (row.locked_at) {
      const kind = row.team_id ? (await this.teams()).find((x) => x.id === row.team_id)?.kind : undefined;
      throw new UserError(`This project is ${kind === "class" ? "submitted" : "issued"} and locked read-only. ${row.team_id ? "A team admin can unlock it in Ohmstead." : "Unlock it in Ohmstead to edit."}`);
    }
    if (row.team_id) {
      // The edit lock is per side (roles, 2026-10-30): either side held by someone
      // else keeps the project read-only here, and the message names the side.
      const locks = check(
        await this.db.from("project_locks").select("user_id, side, heartbeat_at").eq("project_id", row.id),
      ) as { user_id: string; side: string; heartbeat_at: string }[];
      const live = locks.filter((l) => l.user_id !== uid && Date.parse(l.heartbeat_at) > Date.now() - 90_000);
      if (live.length) {
        const members = check(await this.db.rpc("team_member_list", { tid: row.team_id })) as { user_id: string; display_name: string | null; email: string }[];
        const held = live[0];
        const who = members.find((m) => m.user_id === held.user_id);
        throw new UserError(
          `${who?.display_name ?? who?.email ?? "A teammate"} has this project's ${held.side === "pid" ? "P&ID" : "schematic"} open for editing in Ohmstead. Try again once they close it.`,
        );
      }
    }
  }

  /**
   * The part a team project should use: the user's own private part is copied into the
   * team Codex (once; later calls reuse the copy) so teammates see it in full. Anything
   * else (built-in, public, already a team part) is used as is.
   */
  async forTeam(teamId: string | null, partId: string): Promise<string> {
    if (!teamId) return partId;
    const part = await this.part(partId);
    if (part.team_id || part.is_public || part.owner_id !== (await this.userId())) return partId;
    const copy = [...(await this.catalog()).parts.values()].find((p) => p.team_id === teamId && p.forked_from === partId);
    if (copy) return copy.id;
    const id = check(await this.db.rpc("copy_part_to_team", { source_id: partId, tid: teamId })) as string;
    this.invalidate();
    return id;
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------
  async project(id: string): Promise<ProjectRow> {
    const row = check(await this.db.from("projects").select("*").eq("id", id).maybeSingle()) as ProjectRow | null;
    if (!row) throw new UserError(`No project with id ${id} (or it isn't visible to you).`);
    return { ...row, content: normalizeDoc(row.content) };
  }

  /**
   * Load → apply `fn` → save, only if nobody saved in between (updated_at
   * match). Retries on a race so app autosaves and tool edits don't clobber.
   */
  async edit<T>(id: string, fn: (doc: WireDoc, cat: Catalog) => T | Promise<T>): Promise<{ result: T; doc: WireDoc; row: ProjectRow }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await this.project(id);
      await this.assertEditable(row);
      const edited = structuredClone(row.content);
      const result = await fn(edited, await this.catalog());
      const doc = withHarnessTags(edited);
      const saved = check(
        await this.db.from("projects").update({ content: doc }).eq("id", id).eq("updated_at", row.updated_at).select("updated_at"),
      ) as { updated_at: string }[];
      if (saved.length) {
        // User embed links are paused (src/lib/embed/links.ts), so edits don't refresh embeds. To bring it back, call
        // embedPublish.ts here again: scheduleEmbedPublish for stdio, publishEmbedNow through opts.defer when hosted.
        return { result, doc, row: { ...row, content: doc, updated_at: saved[0].updated_at } };
      }
    }
    throw new UserError("The project kept changing while saving (is it open and being edited in Ohmstead?). Try again.");
  }
}

// ---------------------------------------------------------------------------
// Endpoints: "TAG:PORT"
// ---------------------------------------------------------------------------
export function componentByTag(doc: WireDoc, tag: string): Component | undefined {
  const t = tag.trim().toLowerCase();
  return doc.components.find((c) => c.tag.toLowerCase() === t);
}

/** Split "TAG:PORT" using the longest tag in the project that matches (ports may contain ':'). */
export function parseEndpoint(doc: WireDoc, ref: string): { comp: Component; port: string } {
  const s = ref.trim();
  const matches = doc.components
    .filter((c) => s.toLowerCase().startsWith(`${c.tag.toLowerCase()}:`))
    .sort((a, b) => b.tag.length - a.tag.length);
  if (!matches.length) {
    const tag = s.split(":")[0];
    throw new UserError(
      `"${ref}": no component tagged "${tag}" in this project. Add it first with add_components (tags: ${doc.components.map((c) => c.tag).join(", ") || "none"}).`,
    );
  }
  const comp = matches[0];
  const port = s.slice(comp.tag.length + 1).trim();
  if (!port) throw new UserError(`"${ref}": missing terminal after the colon.`);
  return { comp, port };
}

/**
 * Normalize a terminal name to the Codex spelling; strips accept new terminals.
 * Strip ports resolve to their canonical address ("4", or "4A" on multi-level blocks).
 */
export function resolvePort(comp: Component, port: string, cat: Catalog, doc: WireDoc): { port: string; signalTypeId: string | null; newStripTerminal: boolean } {
  if (comp.strip) {
    const p = findStripPort(doc, cat, comp.strip, port);
    if (p) return { port: p.address, signalTypeId: null, newStripTerminal: false };
    const miss = missingLevel(doc, cat, comp.strip, port);
    if (miss)
      throw new UserError(
        `${comp.tag}:${miss.terminal.label} has no level ${miss.level}${miss.levels.length ? `; its block has levels ${miss.levels.join(", ")}` : " (single-level block)"}.`,
      );
    return { port, signalTypeId: null, newStripTerminal: true };
  }
  const part = comp.partId ? cat.parts.get(comp.partId) : undefined;
  if (!part) throw new UserError(`${comp.tag} has no Codex part linked; link one with update_components first.`);
  const p =
    part.part_ports.find((x) => x.port === port) ?? part.part_ports.find((x) => x.port.toLowerCase() === port.toLowerCase());
  if (!p) {
    throw new UserError(
      `${comp.tag} (${part.name}) has no terminal "${port}". Terminals: ${part.part_ports.map((x) => x.port).join(", ")}. ` +
        `If the part really has it, add it in the Codex with add_part_terminals.`,
    );
  }
  return { port: p.port, signalTypeId: p.signal_type_id, newStripTerminal: false };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
export { endLabel, findIssues, signalLabel };

export const partLabel = (p: Part) => `${p.name} — ${p.manufacturer} ${p.serial_number}`;

export function renderPart(p: Part, cat: Catalog, uid?: string): string {
  const owner = p.team_id ? "team" : p.owner_id === null ? "built-in" : p.owner_id === uid ? "yours" : "community";
  const lines = [
    `### ${p.name}  [id ${p.id}]`,
    `${p.manufacturer} ${p.serial_number} · ${p.category} · ${p.is_public ? "public" : "private"} · ${owner}${p.forked_from ? ` · fork of ${p.forked_from}` : ""}`,
    p.description,
    `Terminals: ${p.part_ports.length ? p.part_ports.map((t) => `${t.port} (${t.type}, ${signalLabel(cat, t.signal_type_id)}${t.load_a != null ? `, load ${t.load_a} A` : ""}${t.rated_a != null ? `, rated ${t.rated_a} A` : ""}${t.charge_a != null ? `, charges ${t.charge_a} A` : ""}${t.fuse_a != null ? `, maker's fuse ${t.fuse_a} A` : ""}${t.through ? `, ${t.through_fused ? "fused from" : "joined to"} ${t.through}` : ""}${t.max_wires > 1 ? `, ${t.max_wires} wires` : ""}${t.level ? `, level ${t.level}` : ""}${t.side ? `, ${t.side}` : ""})`).join("; ") : "none"}`,
  ];
  if (p.block) lines.push(renderBlock(p.block, cat));
  if (p.trip_ratings?.length) lines.splice(3, 0, `Allowed trip ratings (A): ${p.trip_ratings.join(", ")}`);
  if (p.slot_count > 0) lines.splice(3, 0, `Module slots: ${p.slot_count}`);
  const conns = connectorsOf(p);
  if (conns.length)
    lines.push(
      `Connectors: ${conns
        .map((c) => `${c.name} (${c.pins.length} pins${c.gender ? `, ${c.gender}` : ""}${c.coding ? `, ${c.coding}-coded` : ""})`)
        .join("; ")}. Pins are addressed CONNECTOR.PIN, e.g. ${conns[0].name}.${conns[0].pins[0]?.pin ?? "1"}.`,
    );
  return lines.join("\n");
}

function renderBlock(b: Block, cat: Catalog): string {
  const ref = (id: string | undefined) => {
    const a = id ? cat.parts.get(id) : undefined;
    return a ? `${a.manufacturer} ${a.serial_number}` : id ? `?${id}` : "";
  };
  if (b.kind === "accessory") return `Terminal block accessory: ${b.accessory ?? "?"}${b.poles ? `, ${b.poles}-pole` : ""}`;
  const facts = [
    b.kind,
    b.pitch_mm && `${b.pitch_mm} mm wide`,
    b.wire_mm2 && `${b.wire_mm2[0]}–${b.wire_mm2[1]} mm²`,
    b.max_conductors && b.max_conductors > 1 && `${b.max_conductors} wires per clamp`,
    b.rated_a && `${b.rated_a} A`,
    b.rated_v && `${b.rated_v} V`,
    b.jumper && `${b.jumper} jumpers`,
  ].filter(Boolean);
  const a = b.accessories ?? {};
  const acc = [
    a.end_plate && `end plate ${ref(a.end_plate)}`,
    a.end_stop && `end stop ${ref(a.end_stop)}`,
    a.marker && `marker ${ref(a.marker)}`,
    ...Object.entries(a.jumpers ?? {}).map(([n, id]) => `${n}-pole jumper ${ref(id)}`),
  ].filter(Boolean);
  return `Terminal block: ${facts.join(", ")}${acc.length ? `. Accessories: ${acc.join("; ")}` : ""}`;
}

export function renderProject(row: ProjectRow, cat: Catalog): string {
  const doc = row.content;
  const groupName = (id: string | null) => (id ? (doc.groups.find((g) => g.id === id)?.name ?? `?${id}`) : "—");
  const tb = doc.settings.titleBlock;
  const L: string[] = [];
  L.push(`# ${row.title}  [project ${row.id}]`);
  L.push(`Status ${row.status} · ${row.visibility} · updated ${row.updated_at} · flow ${doc.settings.flow}`);
  L.push(`Title block: drawing ${tb.drawingNo || "—"}, rev ${tb.rev || "—"}, customer ${tb.customer || "—"}, drawn by ${tb.drawnBy || "—"}`);
  const units = unitsOf(doc);
  // Gauge as shown in the grid; "(own)" marks a wire's or conductor's override.
  const gaugeCell = (c: Connection) => {
    const g = connectionGauge(doc, cat.signals, c);
    return g ? `${formatGauge(g, units)}${g.from === "wire" ? " (own)" : ""}` : "—";
  };
  // Amps as shown in the grid's Amps column, when the rollup knows them.
  const rollup = currentRollup(doc, cat);
  const ampsCell = (c: Connection) => {
    const a = rollup.wireAmps.get(c.id);
    return a != null ? `${formatAmps(a)} A` : "—";
  };
  // Length as shown in the grid's Len column: the wire's own, else its cable's.
  const lenUnit = lengthUnitOf(doc);
  const lenCell = (c: Connection) => {
    const m = lengthOf(doc, c);
    return m != null ? `${formatLength(m, lenUnit)} ${lenUnit}` : "—";
  };
  L.push(`Gauge units: ${units === "awg" ? "AWG" : units === "mm2" ? "mm²" : "AWG and mm²"}${doc.settings.gaugeOnLabels ? " · printed on wire labels" : ""}`);

  L.push(`\n## Subsystems (${doc.groups.length})`);
  for (const g of doc.groups) L.push(`- ${g.name} [${g.id}] · flow ${g.flow} · parent ${groupName(g.parentId)}`);

  const stripNotes: string[] = [];
  L.push(`\n## Components (${doc.components.length})`);
  L.push(`| Tag | Part | Subsystem | Terminals |`);
  L.push(`|---|---|---|---|`);
  for (const c of doc.components) {
    if (c.strip) {
      const s = c.strip;
      // Terminal "4" on a 2-level block reads "4[A=,B]": level A jumpered to the next terminal.
      const terms = s.terminals
        .map((t) => {
          const lv = levelsAt(doc, cat, s, t);
          if (lv.length === 1 && lv[0] === null) return `${t.label}${t.jumperNext ? "=" : ""}`;
          return `${t.label}[${lv.map((l) => `${l}${jumpered(t, l) ? "=" : ""}`).join(",")}]`;
        })
        .join(" ");
      const named = [...new Set(s.terminals.map((t) => blockOf(doc, cat, s, t).partId))].map((id) => {
        const p = cat.parts.get(id);
        return p ? `${p.manufacturer} ${p.serial_number}` : `?${id}`;
      });
      L.push(`| ${c.tag} | terminal strip (${s.term}, ${s.clampsPerSide} clamp/side; blocks ${named.join(", ")}) | ${groupName(c.groupId)} | ${terms || "none"} (= jumpered to next; [A,B] = levels, address as 4A) |`);
      const { lines, missing } = stripParts(doc, cat, s);
      stripNotes.push(
        `- ${c.tag}: ${lines
          .filter((l) => l.qty > 0)
          .map((l) => {
            const p = cat.parts.get(l.partId);
            return `${l.qty} × ${p ? `${p.manufacturer} ${p.serial_number}` : l.partId} (${ROLE_LABEL[l.role].toLowerCase()}${l.generic ? ", generic" : ""}${l.overridden ? ", set by hand" : ""})`;
          })
          .join("; ")}${missing.length ? `. Missing: ${missing.join("; ")}` : ""}`,
      );
      continue;
    }
    const p = c.partId ? cat.parts.get(c.partId) : undefined;
    const m = mountOf(doc, cat, c.id);
    const rack = isPlcPart(p) ? ` · rack, ${p.slot_count} slots` : m ? ` · in ${m.plc.tag} slot ${m.slot}` : "";
    const circuits = Object.entries(c.tripByPort ?? {}).map(([port, a]) => `${port} ${a} A`).join(", ");
    const trip = (c.tripA != null ? ` · trips at ${c.tripA} A` : "") + (circuits ? ` · fuses ${circuits}` : "");
    L.push(`| ${c.tag} | ${p ? `${partLabel(p)} [${p.id}]` : "NO PART"}${trip}${rack} | ${groupName(c.groupId)} | ${p?.part_ports.map((x) => x.port).join(", ") ?? ""} |`);
  }

  if (doc.pid?.items.length) {
    const pid = doc.pid;
    const printed = (id: string) => {
      const item = pid.items.find((i) => i.id === id);
      return item ? pidTagOf(doc, item) || id : `?${id}`;
    };
    L.push(`\n## P&ID (${pid.items.length} items, ${pid.lines.length} lines)`);
    if (pid.pages.length) L.push(`Sheets: ${pid.pages.map((p) => `${p.name} [${p.id}] at ${p.x},${p.y}`).join("; ")}`);
    L.push(`| Tag | Symbol | Component |`);
    L.push(`|---|---|---|`);
    for (const i of pid.items) {
      const comp = i.componentId ? (doc.components.find((c) => c.id === i.componentId)?.tag ?? `?${i.componentId}`) : "—";
      L.push(`| ${pidTagOf(doc, i) || "(no tag)"} [${i.id}] | ${i.symbol} (${pidSymbol(i.symbol).label})${i.location ? `, ${i.location}` : ""} | ${comp} |`);
    }
    if (pid.lines.length) {
      const end = (e: { itemId: string; port?: string }) => `${printed(e.itemId)}${e.port ? `:${e.port}` : ""}`;
      L.push(`\n| Line | Kind | From | To | Label |`);
      L.push(`|---|---|---|---|---|`);
      for (const l of pid.lines) L.push(`| ${l.id} | ${l.kind} | ${end(l.from)} | ${end(l.to)} | ${l.label ?? "—"} |`);
    }
  }

  if (stripNotes.length) {
    L.push(`\n## Strip parts (blocks + accessories)`);
    L.push(...stripNotes);
    if (stripNotes.length > 1) {
      const bom = projectStripBom(doc, cat);
      L.push(`\nAll strips: ${bom.lines.map((l) => `${l.qty} × ${cat.parts.get(l.partId)?.serial_number ?? l.partId}`).join(", ")}`);
    }
    if (doc.settings.stripReport === false) L.push("Strip report pages are off in the PDF (update_project strip_report).");
  if (doc.settings.pidSheets === false && doc.pid?.items.length) L.push("P&ID sheets are off in the PDF (update_project pid_sheets).");
  }

  if (doc.cables.length) {
    L.push(`\n## Cables (${doc.cables.length})`);
    for (const w of doc.cables) {
      const a = placedConnector(doc, cat, w.from);
      const b = placedConnector(doc, cat, w.to);
      const side = (c: typeof a, e: typeof w.from) =>
        `${tagOf(doc, e.componentId)}:${e.connector}${c ? ` (${[c.gender, c.coding && `${c.coding}-coded`, `${c.pins.length} pins`].filter(Boolean).join(", ")})` : " (missing)"}`;
      const landing = (c: Connection, e: "from" | "to") => endLabel(doc, c[e]);
      L.push(`### ${w.tag}  [cable ${w.id}] ${w.terminals ? "terminal-end cable (no connectors)" : `${side(a, w.from)} → ${side(b, w.to)}`}${w.spec ? ` · ${w.spec}` : ""}${w.awg || w.mm2 ? ` · gauge ${formatGauge(w, units)}` : ""}${w.length != null ? ` · ${formatLength(w.length, lenUnit)} ${lenUnit}` : ""}`);
      L.push(`| From pin | To pin | Signal | Gauge | Color | Id |`);
      L.push(`|---|---|---|---|---|---|`);
      const pin = (c: typeof a, port: string) => c?.pins.find((p) => p.port === port)?.pin ?? port;
      for (const c of conductorsOf(doc, w.id)) L.push(`| ${w.terminals ? landing(c, "from") : pin(a, c.from.port)} | ${w.terminals ? landing(c, "to") : pin(b, c.to.port)} | ${signalLabel(cat, c.signalTypeId)} | ${gaugeCell(c)} | ${c.color ?? "—"} | ${c.id} |`);
    }
  }

  const harnesses = harnessesOf(doc);
  if (harnesses.length) {
    L.push(`\n## Harnesses (${harnesses.length}, automatic at ${minWiresOf(doc)}+ wires)`);
    L.push(`| Tag | Name | Ends | Wires | Signals | Drawn | Key |`);
    L.push(`|---|---|---|---|---|---|---|`);
    for (const h of harnesses) {
      const signals = [...new Set(h.wires.map((c) => signalLabel(cat, c.signalTypeId)))].join(", ");
      const views = Object.entries(h.override?.views ?? {}).map(([k, v]) => `${k === "root" ? "top level" : groupName(k)}: ${v}`);
      L.push(`| ${h.tag} | ${h.name ?? "—"} | ${h.aName} ↔ ${h.bName} | ${h.wires.length} | ${signals} | ${harnessShown(h, null) ? "trunk" : "separate wires"}${views.length ? ` (${views.join(", ")})` : ""} | ${h.key} |`);
    }
  }
  const harnessOf = harnessOfWire(harnesses);

  const loose = doc.connections.filter((c) => !c.cableId);
  L.push(`\n## Wires / grid rows (${loose.length})${doc.cables.length ? " — cable conductors are listed under Cables" : ""}`);
  L.push(`| # | From | To | Signal | Gauge | Amps | Len (${lenUnit}) | Bundle | Harness | Note | Id |`);
  L.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
  loose.forEach((c, i) => {
    const draw = c.display ? ` [draw ${c.display}]` : "";
    L.push(
      `| ${i + 1} | ${endLabel(doc, c.from)} | ${endLabel(doc, c.to)} | ${signalLabel(cat, c.signalTypeId)} | ${gaugeCell(c)} | ${ampsCell(c)} | ${lenCell(c)} | ${c.bundle ?? "—"} | ${harnessOf.get(c.id)?.tag ?? "—"} | ${(c.note ?? "") + draw} | ${c.id} |`,
    );
  });

  const issues = findIssues(doc, cat);
  L.push(`\n## Issues (${issues.length})`);
  for (const i of issues) L.push(`- ${i}`);
  return L.join("\n");
}
