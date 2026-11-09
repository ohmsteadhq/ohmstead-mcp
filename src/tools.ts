// MCP tools. Transport-agnostic: stdio passes a client signed in from
// ~/.ohmstead; a future HTTP transport passes a per-request client.
// Policy: read + edit, no deleting projects or Codex parts.

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { nanoid } from "nanoid";
import { z } from "zod";
import { createStrip, epKey, fixAll, packAll, packStrip, setProjectBlock, setStripPartQty, setTerminalBlock, splitAll, splitStripBy, type SplitBy } from "@/lib/doc/strips";
import { GENERIC_BLOCK, levelsAt, ROLE_LABEL, stripParts } from "@/lib/doc/blocks";
import { devicesFromBom, planImport, reportText, wiresFromCsv, type ImportLevel, type ImportRows } from "@/lib/import";
import * as cables from "@/lib/doc/cables";
import { promoteHarness, updateHarness, withHarnessTags } from "@/lib/doc/harnesses";
import { addPidItem, addPidLine, addPidSheet, movePidItems, orderPidSheet, pidEndPoint, pidItemByRef, pidPortRef, pidPortToward, removePidItems, removePidLines, removePidSheet, resizePidItem, setPidItemSymbol, updatePidItem, updatePidLine, updatePidSheet } from "@/lib/pid/edit";
import { splitPidSheets } from "@/lib/pid/sheets";
import { FRAME } from "@/lib/schematic/pages";
import { linkPidItem, renamePidTag } from "@/lib/pid/link";
import { PID_LINE_STYLES, PID_SYMBOLS, pidShape, type PidSymbol, isPidAnnotation, pidSymbol } from "@/lib/pid/symbols";
import { pidTagOf } from "@/lib/pid/tags";
import { formatGauge, gaugePatch, normalizeAwg, parseGauge, unitsOf } from "@/lib/doc/gauge";
import { STANDARDS, newProjectDoc, standardOf } from "@/lib/sizing/standards";
import { ftToM, lengthUnitOf, RESISTANCE } from "@/lib/sizing/drop";
import { sizeProject } from "@/lib/sizing/suggest";
import { breakdownLines } from "@/lib/sizing/breakdown";
import { formatAmps } from "@/lib/sizing/current";
import { isModulePart, isPlcPart, mountModule } from "@/lib/doc/rack";
import { SAMPLE_PROJECT_ID } from "@/lib/sample";
import { diffSummary, importOver, parseProject, PROJECT_FILE_EXT, serializeProject, type DocDiff, type ParseProblem } from "@/lib/projectfile";
import { BLOCK_ACCESSORIES, BLOCK_KINDS, BLOCK_LEVELS, isBlockPart, isProtectivePart, levelsOf, connectorsOf, emptyDoc, PART_CATEGORIES, portKey, TERMINAL_TYPES, type Block, type BlockLevel, type Cable, type Connection, type ConnectorEnd, type Flow, type Part, type PartConnector, type PidItem, type PidLine, type ProjectRow, type SignalCategory, type SignalType, type TerminalType, type WireDoc } from "@/lib/types";
import {
  atLeast,
  check,
  type MyTeam,
  componentByTag,
  findIssues,
  parseEndpoint,
  renderPart,
  renderProject,
  resolvePort,
  roleLabel,
  endLabel,
  UserError,
  Ohmstead,
} from "./ohmstead.js";

const GAUGE_HELP = 'Wire gauge: AWG ("18", "14 AWG", "1/0") or mm² ("1.5 mm²"). A bare number follows the project\'s gauge units. Default: the signal type\'s gauge.';

export const INSTRUCTIONS = `Ohmstead builds control-panel wiring schematics without CAD.

Model:
- A project has components (device instances with a unique tag like PLC_MAIN, PSU1, K1), each linked to a Codex part.
- The Codex is the shared parts library. A part has a name, manufacturer, part number, category, description and terminals (each with a terminal type, a default signal type, and optional load_a / rated_a current in A; protective parts also list their allowed trip ratings). Parts are only created in the Codex (save_part), never invented inside a project. Signal types too (save_signal_type); check list_signal_types first. Search before creating; built-in and community parts can be forked.
- Wires are grid rows: "FROM_TAG:TERMINAL" → "TO_TAG:TERMINAL" with a signal type (e.g. 24VDC (+), 0VDC (-), Protective Earth). If no signal is given, the From terminal's Codex default is used.
- A device terminal takes one wire unless its Codex terminal allows more (max_wires), the user allowed it, or all wires are comms (daisy-chain). Extra wires are a "fan-out": route them through a terminal strip (TB1, TB2…) with fix_fanouts. Strips are project-level, not Codex parts; their terminals are created on demand.
- Terminal blocks: Codex parts with category terminal can carry block data (kind, width, wire range, ratings, jumper style, accessory parts) and per-terminal level (A/B/C) and side (in/out). End plates, end stops, jumper bars and markers are accessory parts (block.kind accessory, no terminals). On a strip, each terminal is a block (strip default, project default or a generic block); multi-level blocks are addressed with a level letter: TB1:4A, TB1:4B. Set the project's default block and PE block with update_project (default_block, default_pe_block); fix_fanouts and add_terminal_strip use them. Change blocks on existing terminals with set_strip_blocks. A block's wire range is enforced: validate_project flags wires whose gauge is too big or small for the clamp they land on, and packing leaves such nets where they are. Packing can append spare terminals: update_project spare_terminal_pct sets how many, as a % of each strip's used terminals.
- Subsystems group components; each has a signal flow (LR or TB).
- Connectors: a Codex part's terminals can be grouped into named connectors (X1, X2…), each pin with its own type and default signal, plus gender (male/female) and keying (e.g. M12 A). A pin is addressed "TAG:X1.3" in wires. Give terminals a connector in save_part / add_part_terminals.
- Harnesses (H1, H2…): all loose wires between the same two subsystems, or a subsystem and a terminal strip, draw as one trunk line once there are enough of them (update_project harness_min, default 3). They are worked out from the wiring; get_project lists them and update_harness sets overrides. A wire set to draw as a reference stays one.
- Cables (W1, W2…) join two connectors pin for pin (add_cable). Pins map 1:1 by default (same pin names, else pin order); each conductor is its own row with a signal and an optional conductor color (BN, WH, BU…). Edit with update_cable. Validation flags mated ends with the same gender or different keying. Loose wires may still land on single pins.
- PLC racks: a PLC part (category plc) can have module slots (slot_count). I/O modules are separate Codex parts (category io). In a project, put a module in a PLC slot with update_components (plc + slot).
- Sizing: projects pick a sizing standard (NEC by default, NFPA 79, ABYC E-11 DC for vehicles, vans and boats, or Low-voltage electronics for dev boards, breakouts and header pins), an ampacity column and an ambient temperature (update_project sizing_standard / sizing_column / ambient_c, default 40 °C); validate_project reports wires too small for their current, minimum sizes and fuse ratings with suggested values, from tables labelled "unverified tables" until the owner checks them. Ampacity is derated for bundling: the conductors of a cable count together, and loose wires sharing a bundle tag (add_connections / update_connection bundle) do too. Voltage drop (set lengths on wires and cables in the project's length unit, volts and phases on signal types, and the drop limits with update_project) is checked along each wire's run to the supply and flags wires over the branch or total limit; explain_sizing walks through any one wire's numbers (current, derating, drop, the fuse behind it, the suggestion).
- P&ID: a project can carry a process view of the same document. Items are symbols from list_pid_symbols (add_pid_items); process lines join them (add_process_lines); update_pid_items moves, resizes or retags a placed item and its lines stay on. Ports are named by angle in the symbol's own frame, clockwise from up: 0, 90, 180, 270, and 90.1, 90.2 on a side with several. link_instrument ties an item to a wiring component, and the project's tag rule decides which tag it prints. An instrument's signal lines are derived from the wiring, so never add them by hand: wire the component and they appear. A hand-drawn signal line is only for something not wired yet, and validate_project flags it once the wiring disagrees. For words on the drawing use symbols note.text and area.frame, with the words as the tag and an at position: a note wraps to its width, an area is a labelled outline behind the drawing (room boundaries, skids) that prints on every sheet it crosses, and neither takes lines. add_pid_sheet places a named print sheet: a fixed frame that prints the items whose centres it holds; everything else tiles onto automatic sheets.
- Import: import_wiring_list turns an existing design (a PDF you read page by page, a wire-list CSV, a BOM) into a new project; dry run first, then apply after the user agrees.
- Layout, routing and PDF are automatic in the app; the user opens the project in Ohmstead to see the drawing.

Workflow: list_projects / get_project → search_codex → add_components → add_connections → validate_project → fix_fanouts. Report issues to the user rather than guessing; ask before creating Codex parts with uncertain terminal data.
Changes are saved straight to the database. If the project is open in Ohmstead, the user should reload it to see them.
 - Teams and classes: whoami lists the user's teams and their role (classes say instructor / TA / student / viewer). list_projects, create_project, save_part and import_wiring_list take an optional team (name or id); every other tool follows the project's team. A team project is visible to its creator, the team's owner/admins and members it's shared with. Submitted / issued (locked) projects are read-only, and so is a project a teammate has open for editing in Ohmstead (whichever side — schematic or P&ID — they're on). Using one of your private parts in a team project copies it into the team Codex.
On the Free plan only the read-only tools are available; edits need Pro or Student (whoami shows the plan). A Free user who is an editor/student or up in an active team or class can still edit that team's projects and Codex.`;

type Ctx = { getClient: () => Promise<SupabaseClient> };
type Plan = "free" | "student" | "pro";

const PLAN_TTL = 5 * 60_000;
const UPGRADE_URL = "https://ohmstead.io/#pricing";
const UPGRADE = `Editing through the MCP needs Ohmstead Pro (or Student). The Free plan can read projects, search the Codex and validate. Upgrade: ${UPGRADE_URL}`;
const UPGRADE_TEAM = `On the Free plan the MCP edits only your teams' projects and Codex (pass team, or a team project / team part). Your personal workspace needs Pro (or Student): ${UPGRADE_URL}`;

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const fail = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });

const SIGNAL_CATEGORIES = ["power", "ground", "analog", "digital", "comms", "ac", "other"] as const satisfies readonly SignalCategory[];
const HEX = /^#[0-9a-fA-F]{6}$/;
const termTypes = TERMINAL_TYPES.map((t) => t.value) as [TerminalType, ...TerminalType[]];
const flow = z.enum(["LR", "TB"]);

const pidLocation = z.enum(["field", "panel", "panel_rear", "dcs", "plc"]);
const pidLineKinds = Object.keys(PID_LINE_STYLES) as [PidLine["kind"], ...PidLine["kind"][]];

/** Put a pure P&ID edit's result on the doc being saved; an emptied `pid` comes off it too. */
function applyPid(d: WireDoc, next: WireDoc) {
  Object.assign(d, next);
  if (!next.pid) delete d.pid;
}

function pidSymbolsByGroup() {
  const groups = new Map<string, PidSymbol[]>();
  for (const s of Object.values(PID_SYMBOLS)) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);
  return [...groups];
}

function pidSymbolOf(key: string) {
  const symbol = Object.hasOwn(PID_SYMBOLS, key) ? PID_SYMBOLS[key] : undefined;
  if (!symbol) throw new UserError(`Unknown P&ID symbol "${key}". ${pidSymbolGroups()}`);
  return symbol;
}

/** The valid symbol keys, for an error that names them. */
function pidSymbolGroups() {
  return `By group: ${pidSymbolsByGroup().map(([g, list]) => `${g}: ${list.map((s) => s.key).join(", ")}`).join("; ")}.`;
}

function pidItemRef(doc: WireDoc, ref: string) {
  const item = pidItemByRef(doc, ref);
  if (item) return item;
  throw new UserError(`P&ID item "${ref}": no item has that id or tag, or two items print that tag. Items: ${(doc.pid?.items ?? []).map((i) => `${pidTagOf(doc, i) || "(no tag)"} [${i.id}]`).join(", ") || "none"}.`);
}

/** "TAG:PORT" or "TAG" to a line end; the port is whatever follows the last colon. */
function pidEnd(doc: WireDoc, ref: string): { itemId: string; port?: string } {
  const at = ref.lastIndexOf(":");
  const item = pidItemRef(doc, at === -1 ? ref : ref.slice(0, at));
  if (isPidAnnotation(item.symbol)) throw new UserError(`"${ref}": a ${pidSymbol(item.symbol).label.toLowerCase()} has no ports, so no line lands on it.`);
  if (at === -1) return { itemId: item.id };
  const port = pidPortRef(item, ref.slice(at + 1));
  if (!port) throw new UserError(`"${ref}": ${pidTagOf(doc, item) || item.id} (${item.symbol}) has no such port. Ports: ${pidShape(item).ports.map((p) => p.id).join(", ") || "none"}.`);
  return { itemId: item.id, port };
}

/** A placed sheet by id or name; a name on two sheets has to go by id. */
function pidSheetRef(doc: WireDoc, ref: string) {
  const pages = doc.pid?.pages ?? [];
  const byId = pages.find((p) => p.id === ref);
  if (byId) return byId;
  const named = pages.filter((p) => p.name.toLowerCase() === ref.trim().toLowerCase());
  if (named.length > 1) throw new UserError(`${named.length} P&ID sheets are named "${ref}". Use the id: ${named.map((p) => p.id).join(", ")}.`);
  if (!named[0]) throw new UserError(`No P&ID sheet "${ref}". Sheets: ${pages.map((p) => p.name).join(", ") || "none"}.`);
  return named[0];
}

/** What each sheet holds, from stored positions: items the auto-layout hasn't placed count as unplaced. */
function pidSheetsText(doc: WireDoc) {
  const pid = doc.pid;
  if (!pid) return "No sheets.";
  const placed = pid.items.filter((i) => pid.positions[i.id]);
  const rows = splitPidSheets(placed, pid.lines, pid.positions, pid.pages).map(
    (s, n) => `${n + 1}. ${s.auto ? `${s.name} (automatic)` : `${s.name} [${s.id}] at ${s.frame.x},${s.frame.y}`}: ${s.itemIds.size} item(s)${s.overflow.size ? `, ${s.overflow.size} sticking out` : ""}`,
  );
  const unplaced = pid.items.length - placed.length;
  return [...rows, ...(unplaced ? [`${unplaced} item(s) have no position yet, so the auto-layout decides their sheet.`] : [])].join("\n");
}

/** A symbol's ports at a size, each with its offset from the item's centre: "270 (-12,0), 90 (12,0)". */
const portOffsets = (item: { symbol: string; size?: { w: number; h: number } }) =>
  pidShape(item).ports.map((p) => `${p.id} (${p.x},${p.y})`).join(", ");

/** A line end naming a side only ("TK-1:90"), not one port on it ("TK-1:90.2"). */
const isBareSide = (ref: string) => /:\d+$/.test(ref);

/** A line end as get_project prints it: the item's printed tag, then its port. */
function pidEndText(doc: WireDoc, end: { itemId: string; port?: string }) {
  const item = doc.pid?.items.find((i) => i.id === end.itemId);
  return `${(item && pidTagOf(doc, item)) || end.itemId}${end.port ? `:${end.port}` : ""}`;
}

function issuesFooter(doc: WireDoc, cat: Awaited<ReturnType<Ohmstead["catalog"]>>) {
  const issues = findIssues(doc, cat);
  return issues.length ? `\n\nIssues (${issues.length}):\n${issues.map((i) => `- ${i}`).join("\n")}` : "\n\nNo issues.";
}

export function registerTools(server: McpServer, ctx: Ctx): Promise<unknown> {
  /** Wrap a handler: fresh Ohmstead per call, errors as tool errors. */
  const run =
    <A>(fn: (wc: Ohmstead, args: A) => Promise<string>) =>
    async (args: A) => {
      try {
        return text(await fn(new Ohmstead(await ctx.getClient()), args));
      } catch (e) {
        return fail(e instanceof UserError ? e.message : `Error: ${(e as Error)?.message ?? String(e)}`);
      }
    };

  const ro = { readOnlyHint: true, openWorldHint: false };
  const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  // Plan gate. Soft: stdio runs on the user's machine, so this is a nudge, not enforcement
  // (ROADMAP 1.10 moves it server-side). Free gets the read-only tools; write tools are hidden
  // and, if a client calls one anyway, answer with UPGRADE. Re-checked every PLAN_TTL on any call.
  // A Free user who is an editor (student) or up in an active team or class keeps the write
  // tools, but only for that team's projects and Codex: the team seat covers them.
  const writeTools: RegisteredTool[] = [];
  let planNow: Plan | null = null;
  let teamWriter = false;
  let planAt = 0;
  const plan = async (): Promise<Plan | null> => {
    if (planNow && Date.now() - planAt < PLAN_TTL) return planNow;
    try {
      const db = await ctx.getClient();
      planNow = (check(await db.rpc("my_plan")) as { plan: Plan }).plan;
      const teams = (check(await db.rpc("my_teams")) ?? []) as MyTeam[];
      teamWriter = teams.some((t) => t.writable && atLeast(t, "editor"));
      planAt = Date.now();
    } catch {
      return null; // signed out or offline: the tool itself reports it
    }
    // Flip `enabled` directly so the client gets one list_changed, not one per tool.
    const off = planNow === "free" && !teamWriter;
    const flip = writeTools.filter((t) => t.enabled === off);
    for (const t of flip) t.enabled = !off;
    if (flip.length) server.sendToolListChanged();
    return planNow;
  };
  /** Free team members: does this write call land in a team (team arg, team project or team part)? */
  const teamTarget = async (args: unknown): Promise<boolean> => {
    const a = (args ?? {}) as { team?: unknown; project_id?: unknown; part_id?: unknown };
    try {
      const wc = new Ohmstead(await ctx.getClient());
      if (typeof a.team === "string" && a.team.trim()) return !!(await wc.team(a.team));
      if (typeof a.project_id === "string") return !!(await wc.project(a.project_id)).team_id;
      if (typeof a.part_id === "string") return !!(await wc.part(a.part_id)).team_id;
    } catch {
      return true; // unknown team / project / part: let the tool say so
    }
    return false;
  };
  const register = server.registerTool.bind(server);
  const tool: McpServer["registerTool"] = (name, config, cb) => {
    const readOnly = config.annotations?.readOnlyHint === true;
    const gated = (async (...a: unknown[]) => {
      if (!readOnly && (await plan()) === "free" && !(teamWriter && (await teamTarget(a[0])))) return fail(teamWriter ? UPGRADE_TEAM : UPGRADE);
      return (cb as (...a: unknown[]) => unknown)(...a);
    }) as typeof cb;
    const t = register(name, config, gated);
    if (!readOnly) writeTools.push(t);
    return t;
  };

  // -------------------------------------------------------------------------
  // Account
  // -------------------------------------------------------------------------
  tool(
    "whoami",
    { title: "Who am I", description: "The signed-in Ohmstead user, plan, and the teams and classes they're in (with their role).", inputSchema: {}, annotations: ro },
    run(async (wc) => {
      const uid = await wc.userId();
      const p = check(await wc.db.from("profiles").select("email, display_name").eq("id", uid).single()) as { email: string; display_name: string | null };
      const { plan } = check(await wc.db.rpc("my_plan")) as { plan: "free" | "student" | "pro" };
      const lines = [`${p.display_name ?? p.email} <${p.email}> · ${{ free: "Free", student: "Student", pro: "Pro" }[plan]} plan · user ${uid}`];
      const teams = await wc.teams();
      if (plan === "free")
        lines.push(
          teams.some((t) => t.writable && atLeast(t, "editor"))
            ? `Free plan: you can edit your teams' projects and Codex through the MCP; your personal workspace is read-only here. Upgrade: ${UPGRADE_URL}`
            : `Free plan: read-only tools. Upgrade to Pro to edit through the MCP: ${UPGRADE_URL}`,
        );
      if (teams.length) {
        lines.push("", "Teams (pass the name or id as `team` to list_projects, create_project, save_part):");
        for (const t of teams) {
          const state = t.archived_at ? "archived" : !t.active ? (t.kind === "class" ? "not verified yet" : "no active plan") : !t.writable ? "past term end, read-only" : "active";
          lines.push(`- ${t.name} [${t.id}] · ${t.kind} · ${roleLabel(t.kind, t.role)} · ${state}${t.term_ends_at ? ` · term ends ${t.term_ends_at.slice(0, 10)}` : ""}`);
        }
      }
      return lines.join("\n");
    }),
  );

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------
  tool(
    "list_projects",
    {
      title: "List projects",
      description: "The user's Ohmstead projects, newest first. Personal workspace by default; pass team (name or id, see whoami) for that team's projects you can see.",
      inputSchema: { team: z.string().optional().describe("Team or class name or id. Omit for your personal projects.") },
      annotations: ro,
    },
    run(async (wc, { team }: { team?: string }) => {
      const t = team ? await wc.team(team) : null;
      const q = wc.db.from("projects").select("id, title, status, visibility, locked_at, updated_at");
      const rows = check(
        await (t ? q.eq("team_id", t.id) : q.eq("user_id", await wc.userId())).order("updated_at", { ascending: false }),
      ) as Pick<ProjectRow, "id" | "title" | "status" | "visibility" | "locked_at" | "updated_at">[];
      if (!rows.length) return t ? `No projects in ${t.name} that you can see yet.` : "No projects yet. Create one with create_project.";
      const locked = t?.kind === "class" ? "submitted" : "issued";
      return rows.map((r) => `- ${r.title}  [${r.id}] · ${r.status} · ${r.visibility}${r.locked_at ? ` · ${locked} (locked)` : ""} · updated ${r.updated_at}`).join("\n");
    }),
  );

  tool(
    "get_project",
    {
      title: "Get project",
      description: "A project's subsystems, components (tag → Codex part), P&ID items and lines, wires (grid rows) and current issues. Set format=json for the raw document.",
      inputSchema: { project_id: z.string(), format: z.enum(["text", "json"]).default("text") },
      annotations: ro,
    },
    run(async (wc, { project_id, format }: { project_id: string; format: "text" | "json" }) => {
      const row = await wc.project(project_id);
      if (format === "json") return JSON.stringify(row.content, null, 2);
      const out = renderProject(row, await wc.catalog());
      if (!row.team_id && !row.locked_at) return out;
      const t = row.team_id ? (await wc.teams()).find((x) => x.id === row.team_id) : undefined;
      const where = row.team_id ? `Team project in ${t?.name ?? row.team_id}${t ? ` (you: ${roleLabel(t.kind, t.role)})` : ""}` : "Personal project";
      const lock = row.locked_at ? ` · ${t?.kind === "class" ? "submitted" : "issued"} ${row.locked_at}, read-only` : "";
      const [head, ...rest] = out.split("\n");
      return [head, `${where}${lock}`, ...rest].join("\n");
    }),
  );

  // ---- Project files (roadmap 7C): the .ohmstead text format, docs/design/project-file.md ----
  const problemText = (problems: ParseProblem[]) => `The file can't be imported:\n${problems.map((p) => `- ${p.line ? `line ${p.line}: ` : ""}${p.message}`).join("\n")}`;
  const diffText = (d: DocDiff) => [diffSummary(d), ...d.changes.map((c) => `- ${c.text}`), ...(d.layout.positions || d.layout.pages || d.layout.reordered ? [`- Layout: ${d.layout.positions} position(s), ${d.layout.pages} sheet(s)${d.layout.reordered ? ", list order" : ""}`] : [])].join("\n");

  tool(
    "export_project_file",
    {
      title: "Export project file",
      description: `The project as an Ohmstead project file (${PROJECT_FILE_EXT}): plain text, one line per part and wire, sorted, addressed by tag, with drag positions and draw order in the last section. Commit it to Git or edit it and bring it back with import_project_file. Lines starting with # at the top list references that were left out because what they point at no longer exists.`,
      inputSchema: { project_id: z.string() },
      annotations: ro,
    },
    run(async (wc, { project_id }: { project_id: string }) => {
      const row = await wc.project(project_id);
      const { text, dropped } = serializeProject(row.content, await wc.catalog());
      return dropped.length ? `${dropped.map((d) => `# Left out: ${d}`).join("\n")}\n${text}` : text;
    }),
  );

  tool(
    "import_project_file",
    {
      title: "Import project file",
      description: `Read an Ohmstead project file (${PROJECT_FILE_EXT} text). With project_id it goes over that project: components, subsystems and wires keep their ids by tag, so saved positions and embeds survive. Without apply it only reports what would change (always do that first and show the user); apply=true saves. Without project_id it makes a new project named title (Free plan: max 3). Parts resolve by id, then by maker and number; anything missing or ambiguous is named and nothing is saved.`,
      inputSchema: {
        text: z.string().min(1),
        project_id: z.string().optional(),
        title: z.string().optional().describe("Name for a new project (without project_id)."),
        team: z.string().optional().describe("Team or class for a new project. Omit for your personal workspace."),
        apply: z.boolean().default(false),
      },
      annotations: rw,
    },
    run(async (wc, a: { text: string; project_id?: string; title?: string; team?: string; apply: boolean }) => {
      const cat = await wc.catalog();
      if (!a.project_id) {
        const r = parseProject(a.text, cat);
        if (!r.ok) return problemText(r.problems);
        const notes = r.notes.length ? `\n${r.notes.map((n) => `Note: ${n}`).join("\n")}` : "";
        if (!a.apply) return `Ready to create "${a.title ?? "Imported project"}": ${r.doc.components.length} components, ${r.doc.connections.length} wires. Call again with apply=true to create it.${notes}`;
        const t = a.team ? await wc.writableTeam(a.team) : null;
        const title = a.title?.trim() || "Imported project";
        const row = check(
          await wc.db
            .from("projects")
            .insert(t ? { team_id: t.id, title, content: r.doc } : { user_id: await wc.userId(), title, content: r.doc })
            .select("id, title, visibility")
            .single(),
        ) as { id: string; title: string; visibility: string };
        return `Created "${row.title}" [${row.id}] (${row.visibility}${t ? `, in ${t.name}` : ""}) from the file.${notes}`;
      }
      if (!a.apply) {
        const row = await wc.project(a.project_id);
        const r = importOver(row.content, a.text, cat);
        if (!r.ok) return problemText(r.problems);
        return `${diffText(r.diff)}${r.notes.map((n) => `\nNote: ${n}`).join("")}\nNothing saved. Call again with apply=true to import it.`;
      }
      const { result } = await wc.edit(a.project_id, (d, c) => {
        const r = importOver(d, a.text, c);
        if (!r.ok) throw new UserError(problemText(r.problems));
        for (const k of Object.keys(d)) delete (d as Record<string, unknown>)[k];
        Object.assign(d, r.doc);
        return r.diff;
      });
      return `Imported. ${diffText(result)}`;
    }),
  );

  tool(
    "create_project",
    {
      title: "Create project",
      description:
        "Create a new project (Free plan: max 3, always public). sample=true starts from the sample project (the Arduino Parking Sensor template). Pass team (name or id) to create it in a team or class: it starts private to you and the team's owner/admins; share it from Ohmstead.",
      inputSchema: {
        title: z.string().min(1),
        sample: z.boolean().default(false),
        team: z.string().optional().describe("Team or class name or id (you must be an editor/student or up). Omit for your personal workspace."),
      },
      annotations: rw,
    },
    run(async (wc, { title, sample, team }: { title: string; sample: boolean; team?: string }) => {
      const t = team ? await wc.writableTeam(team) : null;
      let content = emptyDoc();
      if (sample) {
        const src = check(await wc.db.from("projects").select("content").eq("id", SAMPLE_PROJECT_ID).maybeSingle()) as { content: WireDoc } | null;
        if (!src) throw new Error("The sample project isn't available.");
        content = src.content;
      }
      const row = check(
        await wc.db
          .from("projects")
          .insert(t ? { team_id: t.id, title, content: newProjectDoc(content) } : { user_id: await wc.userId(), title, content: newProjectDoc(content) })
          .select("id, title, visibility")
          .single(),
      ) as { id: string; title: string; visibility: string };
      return `Created "${row.title}" [${row.id}] (${row.visibility}${t ? `, in ${t.name}` : ""}).`;
    }),
  );

  tool(
    "update_project",
    {
      title: "Update project settings",
      description:
        "Rename, change status/visibility (Pro/Student only for private), default signal flow, title block fields, the sizing standard and its ampacity column, the length unit, the voltage-drop limits, or the spare-terminal percentage. title_block keys are the PDF template's field ids (built-in: drawingNo, drawnBy, customer, rev; custom template fields have their own ids).",
      inputSchema: {
        project_id: z.string(),
        title: z.string().min(1).optional(),
        status: z.enum(["draft", "active", "archived"]).optional(),
        visibility: z.enum(["public", "private"]).optional(),
        flow: flow.optional(),
        title_block: z.record(z.string(), z.string()).optional(),
        default_block: z
          .string()
          .nullable()
          .optional()
          .describe("Terminal block part (id or part number) new strips and strip terminals use when none is picked. null = generic block."),
        default_pe_block: z.string().nullable().optional().describe("Same, for protective-earth strips. null = generic PE block."),
        strip_report: z.boolean().optional().describe("PDF: a terminal strip report page per strip (default true)."),
        sizing_report: z.boolean().optional().describe("PDF: a sizing report page, one section per fuse or breaker (default on when any wire has sizing data)."),
        pid_sheets: z.boolean().optional().describe("PDF: P&ID sheets after the schematic (default on when the project has P&ID items)."),
        strip_naming: z.enum(["tb", "iec"]).optional().describe("Tags for new strips: tb = TB1 / TB-PWR1 (default), iec = -X1, -X2. Existing strips keep their tags."),
        pack_on_fix: z.boolean().optional().describe("fix_fanouts / Fix all re-pack the strips they touch."),
        harness_report: z.boolean().optional().describe("PDF: a breakout table per harness (default true)."),
        harness_min: z.number().int().min(1).nullable().optional().describe("Fewest wires between two subsystems that make a harness (one trunk line). Default 3; null resets it."),
        spare_terminal_pct: z
          .number()
          .min(0)
          .max(50)
          .nullable()
          .optional()
          .describe("Packing (Clean up, fix_fanouts) appends this many spare terminals per strip, in % of its used terminals (0–50), empty and unlocked at the end. null = none."),
        gauge_units: z.enum(["awg", "mm2", "both"]).optional().describe("Wire gauge units in the grid, labels and PDF (default awg). In mm2 projects a bare gauge number means mm²."),
        gauge_on_labels: z.boolean().optional().describe('Printed wire labels include the gauge ("24VDC (+) 18 AWG BU"). Default false.'),
        sizing_standard: z.enum(["nfpa79", "nec", "dc12", "electronics"]).optional().describe("Sizing standard behind gauge and fuse suggestions (default nec). electronics: dev boards, breakouts and header pins, ampacity down to 30 AWG and no minimum size on DC or signal wires."),
        sizing_column: z
          .string()
          .nullable()
          .optional()
          .describe('Ampacity / insulation column of the standard (e.g. "75C", "105C-outside"); must be one of its columns. null = the standard\'s default.'),
        ambient_c: z
          .number()
          .min(0)
          .max(100)
          .nullable()
          .optional()
          .describe("Ambient temperature the ampacity is corrected for, in °C (0–100). null = the default 40 °C (inside the enclosure)."),
        length_unit: z.enum(["ft", "m"]).optional().describe("Unit lengths are entered and shown in (default ft). Stored lengths are metres either way."),
        drop_branch_pct: z
          .number()
          .min(0)
          .max(100)
          .nullable()
          .optional()
          .describe("Branch voltage-drop limit — from the last fuse or breaker to the load — in % of the signal's volts (0–100). null = the default 3 %."),
        drop_total_pct: z.number().min(0).max(100).nullable().optional().describe("Total voltage-drop limit to the supply, in % of the signal's volts (0–100). null = the default 5 %."),
      },
      annotations: rw,
    },
    run(
      async (
        wc,
        a: {
          project_id: string;
          title?: string;
          status?: ProjectRow["status"];
          visibility?: ProjectRow["visibility"];
          flow?: Flow;
          title_block?: Record<string, string>;
          default_block?: string | null;
          default_pe_block?: string | null;
          strip_report?: boolean;
          sizing_report?: boolean;
          pid_sheets?: boolean;
          strip_naming?: "tb" | "iec";
          pack_on_fix?: boolean;
          harness_min?: number | null;
          harness_report?: boolean;
          spare_terminal_pct?: number | null;
          gauge_units?: "awg" | "mm2" | "both";
          gauge_on_labels?: boolean;
          sizing_standard?: "nfpa79" | "nec" | "dc12" | "electronics";
          sizing_column?: string | null;
          ambient_c?: number | null;
          length_unit?: "ft" | "m";
          drop_branch_pct?: number | null;
          drop_total_pct?: number | null;
        },
      ) => {
        const meta = Object.fromEntries(Object.entries({ title: a.title, status: a.status, visibility: a.visibility }).filter(([, v]) => v !== undefined));
        if (Object.keys(meta).length) {
          await wc.assertEditable(await wc.project(a.project_id));
          check(await wc.db.from("projects").update(meta).eq("id", a.project_id).select("id").single());
        }
        const cat = await wc.catalog();
        const block = a.default_block ? blockRef(cat, a.default_block) : null;
        const pe = a.default_pe_block ? blockRef(cat, a.default_pe_block) : null;
        const notes: string[] = [];
        let sizingNote: string | null = null;
        if (a.flow || a.title_block || a.default_block !== undefined || a.default_pe_block !== undefined || a.strip_report !== undefined || a.sizing_report !== undefined || a.pid_sheets !== undefined || a.strip_naming !== undefined || a.pack_on_fix !== undefined || a.harness_min !== undefined || a.harness_report !== undefined || a.spare_terminal_pct !== undefined || a.gauge_units !== undefined || a.gauge_on_labels !== undefined || a.sizing_standard !== undefined || a.sizing_column !== undefined || a.ambient_c !== undefined || a.length_unit !== undefined || a.drop_branch_pct !== undefined || a.drop_total_pct !== undefined) {
          await wc.edit(a.project_id, (d) => {
            if (a.flow) d.settings.flow = a.flow;
            if (a.title_block) d.settings.titleBlock = { ...d.settings.titleBlock, ...a.title_block };
            if (a.strip_report === false) d.settings.stripReport = false;
            else if (a.strip_report) delete d.settings.stripReport;
            if (a.sizing_report === false) d.settings.sizingReport = false;
            else if (a.sizing_report) delete d.settings.sizingReport;
            if (a.pid_sheets === false) d.settings.pidSheets = false;
            else if (a.pid_sheets) delete d.settings.pidSheets;
            if (a.strip_naming === "iec") d.settings.stripNaming = "iec";
            else if (a.strip_naming === "tb") delete d.settings.stripNaming;
            if (a.pack_on_fix) d.settings.packOnFix = true;
            else if (a.pack_on_fix === false) delete d.settings.packOnFix;
            if (a.harness_min != null) d.settings.harnessMin = a.harness_min;
            else if (a.harness_min === null) delete d.settings.harnessMin;
            if (a.harness_report === false) d.settings.harnessReport = false;
            else if (a.harness_report) delete d.settings.harnessReport;
            if (a.spare_terminal_pct != null && a.spare_terminal_pct > 0) d.settings.spareTerminalPct = a.spare_terminal_pct;
            else if (a.spare_terminal_pct !== undefined) delete d.settings.spareTerminalPct;
            if (a.gauge_units === "awg") delete d.settings.gaugeUnits;
            else if (a.gauge_units) d.settings.gaugeUnits = a.gauge_units;
            if (a.gauge_on_labels) d.settings.gaugeOnLabels = true;
            else if (a.gauge_on_labels === false) delete d.settings.gaugeOnLabels;
            if (a.sizing_standard !== undefined || a.sizing_column !== undefined || a.ambient_c !== undefined || a.length_unit !== undefined || a.drop_branch_pct !== undefined || a.drop_total_pct !== undefined) {
              const std = STANDARDS[a.sizing_standard ?? d.settings.sizing?.standard ?? "nfpa79"];
              const next = { ...d.settings.sizing };
              if (a.sizing_standard !== undefined) next.standard = a.sizing_standard;
              if (a.sizing_column === null) next.column = undefined;
              else if (a.sizing_column !== undefined) {
                if (!std.columns.some((c) => c.id === a.sizing_column))
                  throw new UserError(`"${a.sizing_column}" isn't a column of ${std.name}. Columns: ${std.columns.map((c) => c.id).join(", ")}.`);
                next.column = a.sizing_column;
              } else if (a.sizing_standard !== undefined && next.column && !std.columns.some((c) => c.id === next.column)) next.column = undefined;
              if (a.ambient_c === null) next.ambientC = undefined;
              else if (a.ambient_c !== undefined) next.ambientC = a.ambient_c;
              if (a.length_unit === "ft") next.lengthUnit = undefined;
              else if (a.length_unit === "m") next.lengthUnit = "m";
              if (a.drop_branch_pct === null) next.dropBranchPct = undefined;
              else if (a.drop_branch_pct !== undefined) next.dropBranchPct = a.drop_branch_pct;
              if (a.drop_total_pct === null) next.dropTotalPct = undefined;
              else if (a.drop_total_pct !== undefined) next.dropTotalPct = a.drop_total_pct;
              if (next.standard || next.column || next.ambientC != null || next.lengthUnit || next.dropBranchPct != null || next.dropTotalPct != null) d.settings.sizing = next;
              else delete d.settings.sizing;
              sizingNote = `Sizing: ${std.name}, ${std.columns.find((c) => c.id === next.column)?.label ?? std.columns.find((c) => c.id === std.defaultColumn)?.label}${next.ambientC != null ? `, ambient ${next.ambientC} °C` : ""}${next.lengthUnit === "m" ? ", lengths in m" : ""}${next.dropBranchPct != null || next.dropTotalPct != null ? `, drop limits ${next.dropBranchPct ?? 3} % branch / ${next.dropTotalPct ?? 5} % total` : ""}.`;
            }
            // Terminals following the default move their wires to the new block's levels.
            for (const [which, given, part] of [
              ["default", a.default_block, block],
              ["pe", a.default_pe_block, pe],
            ] as const) {
              if (given === undefined) continue;
              const next = setProjectBlock(d, cat, which, part?.id ?? null);
              if (!next) throw new UserError(`Can't change the ${which === "pe" ? "PE " : ""}default block: wires on strip terminals use a level the new block doesn't have.`);
              Object.assign(d, next);
            }
          });
        }
        if (block) notes.unshift(`Default block: ${blockName(block)}.`);
        if (pe) notes.unshift(`Default PE block: ${blockName(pe)}.`);
        if (sizingNote) notes.unshift(sizingNote);
        return ["Project updated.", ...notes].join("\n");
      },
    ),
  );

  // -------------------------------------------------------------------------
  // Components & subsystems
  // -------------------------------------------------------------------------
  tool(
    "add_components",
    {
      title: "Add components",
      description:
        "Place Codex parts in a project under unique tags (e.g. PLC_MAIN, PSU1, K1). The part must already exist in the Codex (search_codex / save_part). subsystem = name or id of an existing subsystem.",
      inputSchema: {
        project_id: z.string(),
        components: z.array(z.object({ tag: z.string().min(1), part_id: z.string(), subsystem: z.string().optional() })).min(1),
      },
      annotations: rw,
    },
    run(async (wc, { project_id, components }: { project_id: string; components: { tag: string; part_id: string; subsystem?: string }[] }) => {
      const { team_id } = await wc.project(project_id);
      for (const c of components) c.part_id = await wc.forTeam(team_id, c.part_id);
      const { doc, result } = await wc.edit(project_id, async (d, cat) => {
        const added: string[] = [];
        for (const c of components) {
          const tag = c.tag.trim();
          if (componentByTag(d, tag)) throw new UserError(`Tag ${tag} is already used in this project.`);
          const part = cat.parts.get(c.part_id);
          if (!part) throw new UserError(`No Codex part ${c.part_id}. Find it with search_codex or create it with save_part.`);
          const groupId = c.subsystem ? groupRef(d, c.subsystem) : null;
          d.components.push({ id: nanoid(10), tag, partId: part.id, groupId });
          added.push(`${tag} → ${part.name}`);
        }
        return added;
      });
      return `Added ${result.length}: ${result.join(", ")}.` + issuesFooter(doc, await wc.catalog());
    }),
  );

  tool(
    "update_components",
    {
      title: "Update components",
      description:
        'Retag a component, relink it to another Codex part, move it into a subsystem (subsystem: name/id, or "" for top level), put an I/O module in a PLC slot (plc + slot; a module already in that slot is taken out), or set a fuse/breaker\'s trip rating (trip_a; must be one of the part\'s allowed ratings when it lists any). Identify by current tag.',
      inputSchema: {
        project_id: z.string(),
        changes: z
          .array(
            z.object({
              tag: z.string(),
              new_tag: z.string().optional(),
              part_id: z.string().optional(),
              subsystem: z.string().optional(),
              plc: z.string().optional().describe('I/O modules: tag of the PLC whose rack it goes in, or "" to take it out'),
              slot: z.number().int().min(1).max(64).optional().describe("I/O modules: 1-based slot (with plc)"),
              trip_a_by_terminal: z.record(z.string(), z.number().positive().nullable()).optional().describe('Fused circuits (a fuse block, a distributor): the fuse in A per terminal, e.g. {"1": 15, "2": 20}. null clears one.'),
              trip_a: z.number().positive().nullable().optional().describe("Fuse/breaker components: the trip rating in A chosen for this instance. null clears it."),
            }),
          )
          .min(1),
      },
      annotations: rw,
    },
    run(async (wc, { project_id, changes }: { project_id: string; changes: { tag: string; trip_a_by_terminal?: Record<string, number | null>; new_tag?: string; part_id?: string; subsystem?: string; plc?: string; slot?: number; trip_a?: number | null }[] }) => {
      const { team_id } = await wc.project(project_id);
      for (const ch of changes) if (ch.part_id) ch.part_id = await wc.forTeam(team_id, ch.part_id);
      const { doc } = await wc.edit(project_id, (d, cat) => {
        for (const ch of changes) {
          const comp = componentByTag(d, ch.tag);
          if (!comp) throw new UserError(`No component tagged ${ch.tag}.`);
          if (ch.new_tag !== undefined) {
            const other = componentByTag(d, ch.new_tag);
            if (other && other.id !== comp.id) throw new UserError(`Tag ${ch.new_tag} is already used.`);
            comp.tag = ch.new_tag.trim();
          }
          if (ch.part_id !== undefined) {
            if (comp.strip) throw new UserError(`${comp.tag} is a terminal strip; it has no Codex part.`);
            if (!cat.parts.has(ch.part_id)) throw new UserError(`No Codex part ${ch.part_id}.`);
            comp.partId = ch.part_id;
          }
          if (ch.subsystem !== undefined) comp.groupId = ch.subsystem === "" ? null : groupRef(d, ch.subsystem);
          if (ch.plc !== undefined) {
            if (!isModulePart(comp.partId ? cat.parts.get(comp.partId) : undefined)) throw new UserError(`${comp.tag} is not an I/O module (Codex category io).`);
            if (ch.plc === "") {
              Object.assign(d, mountModule(d, comp.id, null));
            } else {
              const plc = componentByTag(d, ch.plc);
              const pp = plc?.partId ? cat.parts.get(plc.partId) : undefined;
              if (!plc || !isPlcPart(pp)) throw new UserError(`${ch.plc} is not a PLC with module slots in this project.`);
              if (!ch.slot || ch.slot > pp.slot_count) throw new UserError(`${plc.tag} has slots 1–${pp.slot_count}; pass slot.`);
              Object.assign(d, mountModule(d, comp.id, plc.id, ch.slot));
            }
          }
          if (ch.trip_a_by_terminal !== undefined) {
            const part = comp.partId ? cat.parts.get(comp.partId) : undefined;
            const trips = { ...comp.tripByPort };
            for (const [port, amps] of Object.entries(ch.trip_a_by_terminal)) {
              if (!part?.part_ports.some((p) => p.port === port && p.through && p.through_fused)) throw new UserError(`${comp.tag}: ${port} isn't a fused circuit on ${part?.name ?? "this part"}.`);
              if (amps === null) delete trips[port];
              else if (part!.trip_ratings?.length && !part!.trip_ratings.includes(amps)) throw new UserError(`${comp.tag}: ${amps} A isn't an allowed rating for ${part!.name}. Allowed: ${part!.trip_ratings.join(", ")} A.`);
              else trips[port] = amps;
            }
            comp.tripByPort = Object.keys(trips).length ? trips : undefined;
          }
          if (ch.trip_a !== undefined) {
            const part = comp.partId ? cat.parts.get(comp.partId) : undefined;
            if (!isProtectivePart(part)) throw new UserError(`${comp.tag} is not a fuse or breaker, so it has no trip rating.`);
            if (ch.trip_a === null) {
              comp.tripA = undefined;
            } else if (part!.trip_ratings?.length && !part!.trip_ratings.includes(ch.trip_a)) {
              throw new UserError(`${comp.tag}: ${ch.trip_a} A isn't an allowed rating for ${part!.name}. Allowed: ${part!.trip_ratings.join(", ")} A.`);
            } else {
              comp.tripA = ch.trip_a;
            }
          }
        }
      });
      return "Components updated." + issuesFooter(doc, await wc.catalog());
    }),
  );

  tool(
    "add_subsystem",
    {
      title: "Add subsystem",
      description: "Create a subsystem (group) to organize components, optionally nested under a parent subsystem, with its own signal flow.",
      inputSchema: { project_id: z.string(), name: z.string().min(1), parent: z.string().optional(), flow: flow.optional() },
      annotations: rw,
    },
    run(async (wc, a: { project_id: string; name: string; parent?: string; flow?: Flow }) => {
      const { result } = await wc.edit(a.project_id, (d) => {
        if (d.groups.some((g) => g.name.toLowerCase() === a.name.toLowerCase())) throw new UserError(`Subsystem "${a.name}" already exists.`);
        const id = nanoid(8);
        d.groups.push({ id, name: a.name, parentId: a.parent ? groupRef(d, a.parent) : null, flow: a.flow ?? d.settings.flow, collapsed: false });
        return id;
      });
      return `Subsystem "${a.name}" created [${result}].`;
    }),
  );

  tool(
    "add_terminal_strip",
    {
      title: "Add terminal strip",
      description:
        "Add a terminal strip (auto-tagged TB1, TB2…). Usually fix_fanouts creates strips for you; use this for planned strips. Its terminals use `block` if given, else the project default block, else a generic block (terminal_type, clamps_per_side).",
      inputSchema: {
        project_id: z.string(),
        terminals: z.number().int().min(1).max(200).default(4),
        terminal_type: z.enum(termTypes).default("push"),
        clamps_per_side: z.number().int().min(1).max(8).default(1),
        block: z.string().optional().describe('Terminal block part for this strip: part id or part number, or "PE" for the project\'s PE block. Omit for the project default.'),
        subsystem: z.string().optional(),
      },
      annotations: rw,
    },
    run(async (wc, a: { project_id: string; terminals: number; terminal_type: TerminalType; clamps_per_side: number; block?: string; subsystem?: string }) => {
      const cat = await wc.catalog();
      const { doc } = await wc.edit(a.project_id, (d) => {
        const block = !a.block ? null : a.block.trim().toLowerCase() === "pe" ? (d.settings.defaultPeBlockPartId || GENERIC_BLOCK.pe) : blockRef(cat, a.block).id;
        const next = createStrip(d, a.subsystem ? groupRef(d, a.subsystem) : null, a.terminal_type, a.terminals, a.clamps_per_side, block);
        Object.assign(d, next);
      });
      const strip = doc.components.at(-1)!;
      const s = strip.strip!;
      const lv = levelsAt(doc, cat, s, s.terminals[0]).filter(Boolean);
      const id = s.blockPartId || doc.settings.defaultBlockPartId;
      const p = id ? cat.parts.get(id) : undefined;
      return (
        `Added ${strip.tag} with ${a.terminals} terminals (1…${a.terminals})` +
        (p ? `, blocks ${blockName(p)}` : ", generic blocks") +
        (lv.length ? `. Levels ${lv.join(", ")}: address them as ${strip.tag}:1${lv[0]}, ${strip.tag}:1${lv[1] ?? lv[0]}.` : ".")
      );
    }),
  );

  tool(
    "set_strip_blocks",
    {
      title: "Set strip terminal blocks",
      description:
        "Set the terminal block part of strip terminals (a range by label, or all). Wires keep their level: bare labels become level A on a multi-level block and back. Refused if wires sit on a level the new block doesn't have. block = part id or part number; omit (null) to return the terminals to the strip default.",
      inputSchema: {
        project_id: z.string(),
        strip: z.string().describe("Strip tag, e.g. TB1"),
        block: z.string().nullable().optional(),
        from: z.string().optional().describe("First terminal label (default: first)"),
        to: z.string().optional().describe("Last terminal label (default: last)"),
      },
      annotations: rw,
    },
    run(async (wc, a: { project_id: string; strip: string; block?: string | null; from?: string; to?: string }) => {
      const cat = await wc.catalog();
      const part = a.block ? blockRef(cat, a.block) : null;
      const { doc, result } = await wc.edit(a.project_id, (d) => {
        const comp = d.components.find((c) => c.strip && c.tag.toLowerCase() === a.strip.toLowerCase());
        if (!comp?.strip) throw new UserError(`No terminal strip ${a.strip}.`);
        const idx = (label: string | undefined, fallback: number) => {
          if (label === undefined) return fallback;
          const i = comp.strip!.terminals.findIndex((t) => t.label.toLowerCase() === label.toLowerCase());
          if (i < 0) throw new UserError(`${comp.tag} has no terminal ${label}.`);
          return i;
        };
        const from = idx(a.from, 0);
        const to = idx(a.to, comp.strip.terminals.length - 1);
        if (from > to) throw new UserError(`from (${a.from}) comes after to (${a.to}) on ${comp.tag}.`);
        const next = setTerminalBlock(d, cat, comp.id, from, to, part?.id ?? null);
        if (!next) throw new UserError(`Wires on ${comp.tag} use a level the new block doesn't have; move them first.`);
        Object.assign(d, next);
        return { tag: comp.tag, n: to - from + 1 };
      });
      return `Set ${result.n} terminal(s) on ${result.tag} to ${part ? blockName(part) : "the strip default"}.` + issuesFooter(doc, cat);
    }),
  );

  tool(
    "optimize_strips",
    {
      title: "Optimize terminal strips",
      description:
        "Re-pack terminal strips to the fewest terminals: each net becomes one jumpered run sized to its wires (block capacity), empty spares go, like signals sit together, unlocked terminals are renumbered 1..n (locked ones keep their numbers). Multi-level and diode/LED blocks, cabled nets, and nets whose wires don't fit a run's clamp range (block wire_mm2) are left as they are. With spare_terminal_pct set (update_project), each packed strip ends with that share of its used terminals as empty spare terminals. Device connections never change. apply=false (default) only reports the before/after counts; ask the user before applying, since terminal numbers change.",
      inputSchema: {
        project_id: z.string(),
        strip: z.string().optional().describe("Strip tag; omit for every strip"),
        apply: z.boolean().default(false),
      },
      annotations: rw,
    },
    run(async (wc, a: { project_id: string; strip?: string; apply: boolean }) => {
      const cat = await wc.catalog();
      const plan = (d: WireDoc) => {
        const targets = d.components.filter((c) => c.strip && (!a.strip || c.tag.toLowerCase() === a.strip.toLowerCase()));
        if (!targets.length) throw new UserError(a.strip ? `No terminal strip ${a.strip}.` : "This project has no terminal strips.");
        let cur = d;
        const rows: string[] = [];
        for (const c of targets) {
          const r = packStrip(cur, cat, c.id)!;
          if (r.refused) {
            rows.push(`- ${r.refused}`);
          } else {
            const locked = c.strip!.terminals.filter((t) => t.locked).length;
            rows.push(`- ${c.tag}: ${r.before} → ${r.after} terminals${locked ? ` (${locked} locked)` : ""}`);
          }
          cur = r.doc;
        }
        return { doc: cur, rows };
      };
      if (!a.apply) {
        const proj = await wc.project(a.project_id);
        const { rows } = plan(proj.content);
        return ["Dry run (nothing changed):", ...rows, "", "Call again with apply=true to re-pack. Terminal numbers change; lock them first if they're already on labels."].join("\n");
      }
      const { doc, result } = await wc.edit(a.project_id, (d) => {
        const r = plan(d);
        Object.assign(d, r.doc);
        return r.rows;
      });
      return ["Re-packed:", ...result].join("\n") + issuesFooter(doc, cat);
    }),
  );

  tool(
    "split_strips",
    {
      title: "Split terminal strips by subsystem / function",
      description:
        "Split strips so each serves one subsystem and/or one function: power (TB-PWR), PE (TB-PE), AC (TB-AC), field I/O per PLC module (TB-IO); the rest stays on plain TB strips. Everything tied together on a strip moves as one unit; a unit serving several subsystems goes to their common parent (shared distribution at the level above). Wires move with their terminals; device connections never change. apply=false (default) reports the plan; ask the user before applying. pack=true also re-packs the results (like optimize_strips).",
      inputSchema: {
        project_id: z.string(),
        strip: z.string().optional().describe("Strip tag; omit for every strip"),
        by: z.enum(["subsystem", "function", "both"]).default("both"),
        pack: z.boolean().default(false),
        apply: z.boolean().default(false),
      },
      annotations: rw,
    },
    run(async (wc, a: { project_id: string; strip?: string; by: SplitBy; pack: boolean; apply: boolean }) => {
      const cat = await wc.catalog();
      const plan = (d: WireDoc) => {
        const target = a.strip ? d.components.find((c) => c.strip && c.tag.toLowerCase() === a.strip!.toLowerCase()) : undefined;
        if (a.strip && !target) throw new UserError(`No terminal strip ${a.strip}.`);
        const r = target ? splitStripBy(d, cat, target.id, a.by) : splitAll(d, cat, a.by);
        const out = r?.doc ?? d;
        const packed = a.pack ? packAll(out, cat) : null;
        const group = (g: string | null) => (g ? (d.groups.find((x) => x.id === g)?.name ?? `?${g}`) : "project level");
        const rows = (r?.strips ?? []).map((x) => `- ${x.tag}${x.keeps ? " (kept strip)" : ""}: ${x.terminals} terminal(s), ${x.fn === "OTHER" ? "general" : x.fn}, in ${group(x.groupId)}`);
        return { doc: packed?.doc ?? out, rows: rows.length ? rows : ["- nothing to split"], packed };
      };
      const tail = (p: { before: number; after: number; refused?: string } | null) => (p ? `\nPacked: ${p.before} → ${p.after} terminals.${p.refused ? ` ${p.refused}` : ""}` : "");
      if (!a.apply) {
        const { rows, packed } = plan((await wc.project(a.project_id)).content);
        return ["Dry run (nothing changed):", ...rows].join("\n") + tail(packed) + "\n\nCall again with apply=true to split.";
      }
      const { doc, result } = await wc.edit(a.project_id, (d) => {
        const r = plan(d);
        Object.assign(d, r.doc);
        return r;
      });
      return ["Split:", ...result.rows].join("\n") + tail(result.packed) + issuesFooter(doc, cat);
    }),
  );

  tool(
    "set_strip_parts",
    {
      title: "Override strip part quantities",
      description:
        "Override how many of a part a strip needs (accessories: end plates, end stops, jumper bars, markers, or any extra part). Ohmstead works these out from the blocks; an override replaces that count (0 removes the part). qty null = back to the worked-out count. Block counts can't be overridden; change the terminals instead.",
      inputSchema: {
        project_id: z.string(),
        strip: z.string().describe("Strip tag, e.g. TB1"),
        parts: z.array(z.object({ part: z.string().describe("Part id or part number"), qty: z.number().int().min(0).nullable() })).min(1),
      },
      annotations: rw,
    },
    run(async (wc, a: { project_id: string; strip: string; parts: { part: string; qty: number | null }[] }) => {
      const cat = await wc.catalog();
      const { doc, result } = await wc.edit(a.project_id, (d) => {
        const comp = d.components.find((c) => c.strip && c.tag.toLowerCase() === a.strip.toLowerCase());
        if (!comp?.strip) throw new UserError(`No terminal strip ${a.strip}.`);
        const derived = stripParts(d, cat, comp.strip).lines;
        for (const x of a.parts) {
          const ref = x.part.trim();
          const hits = cat.parts.has(ref) ? [cat.parts.get(ref)!] : [...cat.parts.values()].filter((p) => p.serial_number.toLowerCase() === ref.toLowerCase());
          if (!hits.length) throw new UserError(`No Codex part "${x.part}".`);
          if (hits.length > 1) throw new UserError(`Several parts have part number ${x.part}: ${hits.map((p) => `${p.manufacturer} [${p.id}]`).join(", ")}. Pass the id.`);
          if (derived.some((l) => l.partId === hits[0].id && l.role === "block")) throw new UserError(`${hits[0].serial_number} is a block on ${comp.tag}; block counts come from the terminals.`);
          Object.assign(d, setStripPartQty(d, comp.id, hits[0].id, x.qty));
        }
        return comp.id;
      });
      const s = doc.components.find((c) => c.id === result)!.strip!;
      const { lines, missing } = stripParts(doc, cat, s);
      const list = lines.map((l) => {
        const p = cat.parts.get(l.partId);
        return `- ${l.qty} × ${p ? `${p.manufacturer} ${p.serial_number}` : l.partId} (${ROLE_LABEL[l.role].toLowerCase()}${l.overridden ? `, set by hand; worked out ${l.derived}` : ""})`;
      });
      return [`Parts for ${a.strip}:`, ...list, ...(missing.length ? [`Missing: ${missing.join("; ")}`] : [])].join("\n");
    }),
  );

  // -------------------------------------------------------------------------
  // Wires
  // -------------------------------------------------------------------------
  const wireInput = z.object({
    from: z.string().describe('"TAG:TERMINAL", e.g. "PSU1:+24V"'),
    to: z.string().describe('"TAG:TERMINAL", e.g. "PLC_MAIN:24V"'),
    signal: z.string().optional().describe("Signal type name or id. Default: the From terminal's Codex signal."),
    note: z.string().optional(),
    draw: z.enum(["auto", "wire", "ref"]).optional().describe("auto (default), force a drawn wire, or force reference flags"),
    gauge: z.string().optional().describe(GAUGE_HELP),
    bundle: z.string().optional().describe('Free tag for loose wires that run together ("duct-1"), so their count derates ampacity. Ignored on cable conductors (the cable is the bundle).'),
    length: z
      .number()
      .positive()
      .nullable()
      .optional()
      .describe(`Wire length in the project's length unit (ft default, or m; update_project length_unit), for the voltage-drop check. null clears it. Cable conductors inherit the cable's length.`),
  });
  type WireIn = z.infer<typeof wireInput>;

  tool(
    "add_connections",
    {
      title: "Add wires",
      description:
        "Append wires (grid rows) between component terminals. Terminals must exist on the Codex part; terminal strips accept new terminal labels. Returns the issues after the change.",
      inputSchema: { project_id: z.string(), wires: z.array(wireInput).min(1) },
      annotations: rw,
    },
    run(async (wc, { project_id, wires }: { project_id: string; wires: WireIn[] }) => {
      const { doc, result } = await wc.edit(project_id, async (d, cat) => {
        const out: string[] = [];
        for (const w of wires) {
          const conn = await buildConnection(wc, d, cat, w);
          d.connections.push(conn);
          out.push(`${w.from} → ${w.to} [${conn.id}]`);
        }
        return out;
      });
      return `Added ${result.length} wire(s):\n${result.join("\n")}` + issuesFooter(doc, await wc.catalog());
    }),
  );

  tool(
    "update_connection",
    {
      title: "Update wire",
      description:
        "Change one wire (grid row) by id: either end, signal, note, draw mode, gauge, bundle tag, or length (in the project's unit; null clears). Omitted fields stay the same; note \"\" clears it, gauge \"\" goes back to the signal type's gauge, bundle \"\" clears the tag.",
      inputSchema: { project_id: z.string(), connection_id: z.string(), ...wireInput.partial().shape },
      annotations: rw,
    },
    run(async (wc, a: { project_id: string; connection_id: string } & Partial<WireIn>) => {
      const { doc } = await wc.edit(a.project_id, async (d, cat) => {
        const c = d.connections.find((x) => x.id === a.connection_id);
        if (!c) throw new UserError(`No wire ${a.connection_id}. Get ids from get_project.`);
        for (const end of ["from", "to"] as const) {
          const ref = a[end];
          if (!ref) continue;
          const { comp, port } = parseEndpoint(d, ref);
          const r = resolvePort(comp, port, cat, d);
          addStripTerminalIfNew(d, comp.id, r.port, r.newStripTerminal);
          c[end] = { componentId: comp.id, port: r.port };
        }
        if (a.signal) c.signalTypeId = (await wc.signal(a.signal)).id;
        if (a.note !== undefined) c.note = a.note || undefined;
        if (a.draw) c.display = a.draw === "auto" ? undefined : a.draw;
        if (a.gauge !== undefined) Object.assign(c, gaugePatch(gaugeArg(a.gauge, d)));
        if (a.bundle !== undefined) c.bundle = a.bundle.trim() || undefined; // "" clears it
        if (a.length !== undefined) c.length = a.length === null ? undefined : lengthArgM(a.length, d);
      });
      return "Wire updated." + issuesFooter(doc, await wc.catalog());
    }),
  );

  tool(
    "remove_connections",
    {
      title: "Remove wires",
      description: "Remove wires (grid rows) from a project by id. This edits the project; it never deletes projects or Codex parts.",
      inputSchema: { project_id: z.string(), connection_ids: z.array(z.string()).min(1) },
      annotations: { ...rw, destructiveHint: true },
    },
    run(async (wc, { project_id, connection_ids }: { project_id: string; connection_ids: string[] }) => {
      const { doc, result } = await wc.edit(project_id, (d) => {
        const ids = new Set(connection_ids);
        const missing = connection_ids.filter((id) => !d.connections.some((c) => c.id === id));
        if (missing.length) throw new UserError(`No wires with ids: ${missing.join(", ")}.`);
        const before = d.connections.length;
        d.connections = d.connections.filter((c) => !ids.has(c.id));
        return before - d.connections.length;
      });
      return `Removed ${result} wire(s).` + issuesFooter(doc, await wc.catalog());
    }),
  );

  // -------------------------------------------------------------------------
  // Cables
  // -------------------------------------------------------------------------
  const conductorInput = z.object({
    from_pin: z.string().describe("Pin name on the From connector, e.g. \"1\""),
    to_pin: z.string().describe("Pin name on the To connector"),
    signal: z.string().optional().describe("Signal type name or id. Default: the From pin's Codex signal."),
    color: z.string().optional().describe("Conductor color, IEC code or name (BN, WH, BU, BK, GN/YE…)"),
    gauge: z.string().optional().describe(`Conductor gauge; default the cable's gauge, then the signal type's. ${GAUGE_HELP}`),
  });
  type ConductorIn = z.infer<typeof conductorInput>;

  tool(
    "add_cable",
    {
      title: "Add cable",
      description:
        'Add a multi-conductor cable between two connectors, e.g. from "B1:X1" to "IO1:X2". Pins are mapped 1:1 (same pin names, else pin order) unless conductors are given. Tag defaults to the next free W1, W2…',
      inputSchema: {
        project_id: z.string(),
        from: z.string().describe('"TAG:CONNECTOR"'),
        to: z.string().describe('"TAG:CONNECTOR"'),
        tag: z.string().optional(),
        spec: z.string().optional().describe('Printed on the bundle, e.g. "4×0.34 PUR 5m"'),
        gauge: z.string().optional().describe(`Default gauge for its conductors. ${GAUGE_HELP}`),
        length: z
          .number()
          .positive()
          .nullable()
          .optional()
          .describe(`Cable length in the project's length unit (ft default, or m; update_project length_unit). Its conductors inherit it. null = unset.`),
        conductors: z.array(conductorInput).optional().describe("Explicit pin map instead of 1:1"),
      },
      annotations: rw,
    },
    run(async (wc, a: { project_id: string; from: string; to: string; tag?: string; spec?: string; gauge?: string; length?: number | null; conductors?: ConductorIn[] }) => {
      const { doc, result } = await wc.edit(a.project_id, async (d, cat) => {
        const from = connectorRef(d, cat, a.from);
        const to = connectorRef(d, cat, a.to);
        if (a.tag && d.cables.some((w) => w.tag.toLowerCase() === a.tag!.trim().toLowerCase())) throw new UserError(`Cable tag ${a.tag} is already used.`);
        const r = cables.addCable(d, cat, from, to, a.spec?.trim() || undefined);
        Object.assign(d, r.doc);
        const cable = d.cables.find((w) => w.id === r.cable.id)!;
        if (a.tag) cable.tag = a.tag.trim();
        if (a.gauge) Object.assign(cable, gaugePatch(gaugeArg(a.gauge, d)));
        if (a.length != null) cable.length = lengthArgM(a.length, d);
        if (a.conductors) await setPinMap(wc, d, cat, cable, a.conductors);
        return cable;
      });
      return `Added ${result.tag} with ${cables.conductorsOf(doc, result.id).length} conductor(s).` + issuesFooter(doc, await wc.catalog());
    }),
  );

  tool(
    "update_harness",
    {
      title: "Update harness",
      description:
        "Overrides for a harness: all loose wires between the same two subsystems (or a subsystem and a terminal strip), worked out automatically and drawn as one trunk with a tag (H1, H2…). get_project lists them. Retag, name it, draw it as a trunk or as separate wires, everywhere or in one view, or change its minimum wire count. null clears a field back to automatic. The project-wide minimum is update_project harness_min.",
      inputSchema: {
        project_id: z.string(),
        harness: z.string().describe("Harness tag (H1) or key from get_project"),
        new_tag: z.string().optional(),
        name: z.string().nullable().optional(),
        show: z.enum(["harness", "wires"]).nullable().optional().describe("Trunk or separate wires, in every view."),
        view: z.string().nullable().optional().describe('With view_show: a subsystem name or id to set it for, or null for the top level.'),
        view_show: z.enum(["harness", "wires"]).nullable().optional().describe("Trunk or separate wires in that view; null goes back to `show`."),
        min_wires: z.number().int().min(1).nullable().optional().describe("Fewest wires for this pair to count as a harness."),
        promote: z.boolean().optional().describe("The harness really is one multi-core cable: its wires become conductors of a new W-tagged cable landing on their terminals. Edit it with update_cable; remove_cable puts the wires back."),
        spec: z.string().optional().describe('With promote: printed on the cable, e.g. "12×0.75 PUR".'),
      },
      annotations: rw,
    },
    run(
      async (
        wc,
        a: { project_id: string; harness: string; new_tag?: string; name?: string | null; show?: "harness" | "wires" | null; view?: string | null; view_show?: "harness" | "wires" | null; min_wires?: number | null; promote?: boolean; spec?: string },
      ) => {
        const { result } = await wc.edit(a.project_id, (d) => {
          const tagged = withHarnessTags(d);
          const ref = a.harness.trim().toLowerCase();
          const o = tagged.harnesses?.find((x) => x.key.toLowerCase() === ref || x.tag.toLowerCase() === ref);
          if (!o) throw new UserError(`No harness ${a.harness}. get_project lists them.`);
          let scope: string | null = null;
          if (a.view != null) {
            const g = d.groups.find((x) => x.id === a.view || x.name.toLowerCase() === a.view!.toLowerCase());
            if (!g) throw new UserError(`No subsystem ${a.view}.`);
            scope = g.id;
          }
          let next: WireDoc;
          try {
            next = updateHarness(tagged, o.key, {
              ...(a.new_tag !== undefined ? { tag: a.new_tag } : {}),
              ...(a.name !== undefined ? { name: a.name } : {}),
              ...(a.show !== undefined ? { show: a.show } : {}),
              ...(a.min_wires !== undefined ? { minWires: a.min_wires } : {}),
              ...(a.view_show !== undefined ? { view: { scope, show: a.view_show } } : {}),
            });
          } catch (e) {
            throw new UserError((e as Error).message);
          }
          d.harnesses = next.harnesses;
          const saved = next.harnesses!.find((x) => x.key === o.key)!;
          if (!a.promote) return { saved };
          let made: ReturnType<typeof promoteHarness>;
          try {
            made = promoteHarness(next, o.key, a.spec);
          } catch {
            throw new UserError(`${saved.tag} has too few wires to be a harness right now.`);
          }
          d.cables = made.doc.cables;
          d.connections = made.doc.connections;
          return { saved, cable: made.cable };
        });
        if (result.cable) return `${result.saved.tag} is now cable ${result.cable.tag}: its wires are that cable's conductors, drawn as one trunk.`;
        return `Updated harness ${result.saved.tag}${result.saved.name ? ` (${result.saved.name})` : ""}.`;
      },
    ),
  );

  tool(
    "update_cable",
    {
      title: "Update cable",
      description:
        "Change a cable by tag or id: retag, spec, gauge, length, either end (the pin map resets to 1:1), replace the whole pin map (conductors), reset it (reset_pin_map), or set the draw mode. Omitted fields stay the same.",
      inputSchema: {
        project_id: z.string(),
        cable: z.string().describe("Cable tag (W1) or id"),
        new_tag: z.string().optional(),
        spec: z.string().optional().describe('"" clears it'),
        gauge: z.string().optional().describe(`Default gauge for its conductors; "" clears it. ${GAUGE_HELP}`),
        length: z.number().positive().nullable().optional().describe(`Cable length in the project's length unit; its conductors inherit it. null clears it.`),
        from: z.string().optional().describe('"TAG:CONNECTOR"'),
        to: z.string().optional().describe('"TAG:CONNECTOR"'),
        conductors: z.array(conductorInput).optional().describe("Replaces the pin map"),
        reset_pin_map: z.boolean().optional(),
        draw: z.enum(["auto", "wire", "ref"]).optional(),
      },
      annotations: rw,
    },
    run(
      async (
        wc,
        a: {
          project_id: string;
          cable: string;
          new_tag?: string;
          spec?: string;
          gauge?: string;
          length?: number | null;
          from?: string;
          to?: string;
          conductors?: ConductorIn[];
          reset_pin_map?: boolean;
          draw?: "auto" | "wire" | "ref";
        },
      ) => {
        const { doc, result } = await wc.edit(a.project_id, async (d, cat) => {
          const cable = cableRef(d, a.cable);
          if (cable.terminals && (a.from || a.to || a.conductors || a.reset_pin_map)) throw new UserError(`${cable.tag} lands on terminals and has no connectors or pin map; change its wires with update_connection.`);
          for (const end of ["from", "to"] as const) {
            const ref = a[end];
            if (ref) Object.assign(d, cables.setCableEnd(d, cat, cable.id, end, connectorRef(d, cat, ref)));
          }
          if (a.reset_pin_map) Object.assign(d, cables.resetPinMap(d, cat, cable.id));
          const cur = d.cables.find((w) => w.id === cable.id)!;
          if (a.new_tag !== undefined) {
            const t = a.new_tag.trim();
            if (!t || d.cables.some((w) => w.id !== cur.id && w.tag.toLowerCase() === t.toLowerCase())) throw new UserError(`Cable tag "${t}" is empty or already used.`);
            cur.tag = t;
          }
          if (a.spec !== undefined) cur.spec = a.spec.trim() || undefined;
          if (a.gauge !== undefined) Object.assign(cur, gaugePatch(gaugeArg(a.gauge, d)));
          if (a.length !== undefined) cur.length = a.length === null ? undefined : lengthArgM(a.length, d);
          if (a.conductors) await setPinMap(wc, d, cat, cur, a.conductors);
          if (a.draw) for (const c of d.connections) if (c.cableId === cur.id) c.display = a.draw === "auto" ? undefined : a.draw;
          return cur.tag;
        });
        return `Cable ${result} updated.` + issuesFooter(doc, await wc.catalog());
      },
    ),
  );

  tool(
    "remove_cable",
    {
      title: "Remove cable",
      description: "Remove a cable and its conductors from a project (the connectors stay on their parts). A terminal-end cable's conductors stay as loose wires. This edits the project; it never deletes projects or Codex parts.",
      inputSchema: { project_id: z.string(), cable: z.string().describe("Cable tag (W1) or id") },
      annotations: { ...rw, destructiveHint: true },
    },
    run(async (wc, a: { project_id: string; cable: string }) => {
      const { doc, result } = await wc.edit(a.project_id, (d) => {
        const cable = cableRef(d, a.cable);
        Object.assign(d, cables.removeCable(d, cable.id));
        return cable.tag;
      });
      return `Removed ${result}.` + issuesFooter(doc, await wc.catalog());
    }),
  );

  // -------------------------------------------------------------------------
  // P&ID
  // -------------------------------------------------------------------------
  tool(
    "add_pid_items",
    {
      title: "Add P&ID items",
      description:
        "Add symbols to the project's P&ID (list_pid_symbols has the keys). With no tag an item gets the next free one (I-1, V-1, P-1, TK-1, E-1; actuators get none). With no position the auto-layout places it. size is for equipment only and snaps to the symbol's 10-unit steps. With component, the item links to that wiring component and the project's tag rule decides what it prints, so the result shows the printed tag.",
      inputSchema: {
        project_id: z.string(),
        items: z
          .array(
            z.object({
              symbol: z.string().describe('Symbol key from list_pid_symbols, e.g. "instr.field", "valve.globe"'),
              tag: z.string().optional().describe('ISA tag, e.g. "FT-101". On note.text and area.frame, the words it shows.'),
              at: z.object({ x: z.number(), y: z.number() }).optional().describe("Top-left of the item's box. A port sits at x + w/2 + its x offset, y + h/2 + its y offset (list_pid_symbols has the offsets), so level ports need different y on items of different heights."),
              size: z.object({ w: z.number().positive(), h: z.number().positive() }).optional(),
              component: z.string().optional().describe("Tag of the wiring component to link"),
              location: pidLocation.optional().describe("Where the instrument sits; sets its ISA bubble"),
              props: z.record(z.string(), z.string()).optional().describe("Free fields: size, range, set point, fail position…"),
            }).strict(),
          )
          .min(1),
      },
      annotations: rw,
    },
    run(
      async (
        wc,
        a: {
          project_id: string;
          items: {
            symbol: string;
            tag?: string;
            at?: { x: number; y: number };
            size?: { w: number; h: number };
            component?: string;
            location?: PidItem["location"];
            props?: Record<string, string>;
          }[];
        },
      ) => {
        const { doc, result } = await wc.edit(a.project_id, (d) => {
          let cur: WireDoc = d;
          const rows: string[] = [];
          for (const it of a.items) {
            const symbol = pidSymbolOf(it.symbol);
            if (it.size && !symbol.scalable) throw new UserError(`${it.symbol} keeps its ISA size; only equipment, notes and areas resize.`);
            const comp = it.component ? componentByTag(cur, it.component) : undefined;
            if (it.component && !comp) throw new UserError(`No component tagged "${it.component}" in this project.`);
            cur = addPidItem(cur, it.symbol, it.at);
            const id = cur.pid!.items.at(-1)!.id;
            cur = updatePidItem(cur, id, {
              ...(it.tag !== undefined ? { tag: it.tag.trim() } : {}),
              ...(it.location ? { location: it.location } : {}),
              ...(it.props ? { props: it.props } : {}),
            });
            if (it.size) cur = resizePidItem(cur, id, it.size.w, it.size.h);
            if (comp) cur = linkPidItem(cur, id, comp.id);
            const item = cur.pid!.items.at(-1)!;
            const sized = it.size ? ` · ports ${portOffsets(item)}` : "";
            rows.push(`- ${pidTagOf(cur, item) || "(no tag)"} [${id}] ${it.symbol}${comp ? ` → ${comp.tag}` : ""}${sized}`);
          }
          applyPid(d, cur);
          return rows;
        });
        return [`Added ${result.length} P&ID item(s):`, ...result].join("\n") + issuesFooter(doc, await wc.catalog());
      },
    ),
  );

  tool(
    "update_pid_items",
    {
      title: "Update P&ID items",
      description:
        "Change placed P&ID items without touching their lines: position, size, symbol, tag, location, props. Lines keep their spot through a resize or symbol change. A tag follows the project's tag rule: renaming an item linked under the \"same\" rule renames its wiring component too. A blank location unsets it, and so does a blank props field.",
      inputSchema: {
        project_id: z.string(),
        items: z
          .array(
            z.object({
              item: z.string().describe("P&ID item tag or id"),
              at: z.object({ x: z.number(), y: z.number() }).optional(),
              size: z.object({ w: z.number().positive(), h: z.number().positive() }).optional(),
              symbol: z.string().optional().describe("New symbol key from list_pid_symbols"),
              tag: z.string().optional(),
              location: pidLocation.or(z.literal("")).optional(),
              props: z.record(z.string(), z.string()).optional(),
            }).strict(),
          )
          .min(1),
      },
      annotations: rw,
    },
    run(
      async (
        wc,
        a: {
          project_id: string;
          items: {
            item: string;
            at?: { x: number; y: number };
            size?: { w: number; h: number };
            symbol?: string;
            tag?: string;
            location?: PidItem["location"] | "";
            props?: Record<string, string>;
          }[];
        },
      ) => {
        const { doc, result } = await wc.edit(a.project_id, (d) => {
          let cur: WireDoc = d;
          const rows: string[] = [];
          for (const it of a.items) {
            const { id } = pidItemRef(cur, it.item);
            if (it.symbol) {
              pidSymbolOf(it.symbol);
              if (isPidAnnotation(it.symbol) !== isPidAnnotation(pidItemRef(cur, it.item).symbol)) throw new UserError(`"${it.item}": notes and areas can only change into each other.`);
              cur = setPidItemSymbol(cur, id, it.symbol);
            }
            const now = () => cur.pid!.items.find((i) => i.id === id)!;
            if (it.size) {
              if (!pidSymbolOf(now().symbol).scalable) throw new UserError(`${now().symbol} keeps its ISA size; only equipment resizes.`);
              cur = resizePidItem(cur, id, it.size.w, it.size.h);
            }
            if (it.at) cur = movePidItems(cur, { [id]: it.at });
            cur = updatePidItem(cur, id, {
              ...(it.location !== undefined ? { location: it.location || undefined } : {}),
              ...(it.props ? { props: it.props } : {}),
            });
            if (it.tag !== undefined) {
              cur = renamePidTag(cur, id, it.tag);
              if (it.tag.trim() && pidTagOf(cur, now()) !== it.tag.trim()) throw new UserError(`${pidTagOf(cur, now()) || id}: can't rename it to "${it.tag}". Another component already uses that tag.`);
            }
            rows.push(`- ${pidTagOf(cur, now()) || "(no tag)"} [${id}] ${now().symbol}`);
          }
          applyPid(d, cur);
          return rows;
        });
        return [`Updated ${result.length} P&ID item(s):`, ...result].join("\n") + issuesFooter(doc, await wc.catalog());
      },
    ),
  );

  tool(
    "add_process_lines",
    {
      title: "Add process lines",
      description:
        'Draw lines between P&ID items. from and to are "TAG:PORT" or "TAG" (tag or item id; list_pid_symbols has each symbol\'s ports, and a bare side like 90 on a side with several ports takes the one closest to the other end, so the line runs straight when a port lines up; with no positions, the one closest to the side\'s centre). kind defaults to process. Signal lines come from the wiring, so draw one only for something not wired yet. A line from an item to itself or an exact duplicate is skipped.',
      inputSchema: {
        project_id: z.string(),
        lines: z
          .array(
            z.object({
              from: z.string(),
              to: z.string(),
              kind: z.enum(pidLineKinds).default("process"),
              label: z.string().optional().describe('Line number or pipe spec, e.g. 2"-CW-101-A1'),
            }),
          )
          .min(1),
      },
      annotations: rw,
    },
    run(async (wc, a: { project_id: string; lines: { from: string; to: string; kind: PidLine["kind"]; label?: string }[] }) => {
      const { doc, result } = await wc.edit(a.project_id, (d) => {
        let cur: WireDoc = d;
        const rows: string[] = [];
        for (const l of a.lines) {
          let from = pidEnd(cur, l.from);
          let to = pidEnd(cur, l.to);
          if (isBareSide(l.from)) from = pidPortToward(cur, from, pidEndPoint(cur, to));
          if (isBareSide(l.to)) to = pidPortToward(cur, to, pidEndPoint(cur, from));
          const before = cur;
          cur = addPidLine(cur, from, to, l.kind);
          if (cur === before) {
            rows.push(`- skipped ${pidEndText(cur, from)} → ${pidEndText(cur, to)} (same item, or already drawn)`);
            continue;
          }
          const id = cur.pid!.lines.at(-1)!.id;
          if (l.label) cur = updatePidLine(cur, id, { label: l.label });
          rows.push(`- [${id}] ${pidEndText(cur, from)} → ${pidEndText(cur, to)} (${l.kind})`);
        }
        applyPid(d, cur);
        return rows;
      });
      return ["P&ID lines:", ...result].join("\n") + issuesFooter(doc, await wc.catalog());
    }),
  );

  tool(
    "link_instrument",
    {
      title: "Link instrument",
      description: "Link a P&ID item to a wiring component by tag, or clear the link with component null. The project's tag rule decides which tag the item prints, and the result shows it.",
      inputSchema: {
        project_id: z.string(),
        item: z.string().describe("P&ID item tag or id"),
        component: z.string().nullable().describe("Wiring component tag, or null to clear the link"),
      },
      annotations: rw,
    },
    run(async (wc, a: { project_id: string; item: string; component: string | null }) => {
      const { doc, result } = await wc.edit(a.project_id, (d) => {
        const item = pidItemRef(d, a.item);
        if (isPidAnnotation(item.symbol) && a.component !== null) throw new UserError(`"${a.item}": a note or area doesn't link to wiring.`);
        const comp = a.component === null ? null : componentByTag(d, a.component);
        if (comp === undefined) throw new UserError(`No component tagged "${a.component}" in this project.`);
        const next = linkPidItem(d, item.id, comp?.id ?? null);
        applyPid(d, next);
        const printed = pidTagOf(next, next.pid!.items.find((i) => i.id === item.id)!) || "(no tag)";
        return comp ? `${printed} [${item.id}] linked to ${comp.tag}.` : `${printed} [${item.id}] has no link now.`;
      });
      return result + issuesFooter(doc, await wc.catalog());
    }),
  );

  tool(
    "remove_pid_items",
    {
      title: "Remove P&ID items",
      description: "Remove items from the P&ID, and every line touching them. Linked wiring components stay in the schematic.",
      inputSchema: { project_id: z.string(), items: z.array(z.string()).min(1).describe("Item tags or ids") },
      annotations: { ...rw, destructiveHint: true },
    },
    run(async (wc, a: { project_id: string; items: string[] }) => {
      const { doc, result } = await wc.edit(a.project_id, (d) => {
        const gone = a.items.map((ref) => pidItemRef(d, ref));
        const before = d.pid!.lines.length;
        const next = removePidItems(d, gone.map((i) => i.id));
        const tags = [...new Set(gone.map((i) => `${pidTagOf(d, i) || "(no tag)"} [${i.id}]`))];
        applyPid(d, next);
        return { tags, lines: before - (next.pid?.lines.length ?? 0) };
      });
      return `Removed ${result.tags.join(", ")} and ${result.lines} line(s).` + issuesFooter(doc, await wc.catalog());
    }),
  );

  tool(
    "remove_process_lines",
    {
      title: "Remove process lines",
      description: "Remove lines from the P&ID by id (get_project lists them). Signal lines derived from the wiring aren't stored here; change the wiring to change them.",
      inputSchema: { project_id: z.string(), lines: z.array(z.string()).min(1).describe("Line ids") },
      annotations: { ...rw, destructiveHint: true },
    },
    run(async (wc, a: { project_id: string; lines: string[] }) => {
      const { doc, result } = await wc.edit(a.project_id, (d) => {
        const have = new Set(d.pid?.lines.map((l) => l.id));
        const missing = a.lines.filter((id) => !have.has(id));
        if (missing.length) throw new UserError(`No P&ID line ${missing.join(", ")}. get_project lists the line ids.`);
        applyPid(d, removePidLines(d, a.lines));
        return new Set(a.lines).size;
      });
      return `Removed ${result} line(s).` + issuesFooter(doc, await wc.catalog());
    }),
  );

  tool(
    "add_pid_sheet",
    {
      title: "Add P&ID sheet",
      description: `Add a named print sheet to the P&ID: a frame of ${FRAME.w} × ${FRAME.h} units with its top-left at x,y. An item prints on the sheet holding its centre, sheets print in the order listed, and items outside every sheet tile onto automatic sheets after them. The result lists what each sheet holds.`,
      inputSchema: { project_id: z.string(), name: z.string().min(1), x: z.number(), y: z.number() },
      annotations: rw,
    },
    run(async (wc, a: { project_id: string; name: string; x: number; y: number }) => {
      const { doc } = await wc.edit(a.project_id, (d) => {
        const name = a.name.trim();
        if (!name) throw new UserError("A sheet needs a name.");
        if (d.pid?.pages.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new UserError(`A P&ID sheet is already named "${name}".`);
        applyPid(d, addPidSheet(d, name, { x: a.x, y: a.y }));
      });
      return `Added sheet "${a.name.trim()}".\n\n${pidSheetsText(doc)}`;
    }),
  );

  tool(
    "update_pid_sheet",
    {
      title: "Update P&ID sheet",
      description: "Rename a placed P&ID sheet, move its frame (x,y is the top-left), or change where it prints (position, 1 = first). sheet is its id or name. The result lists what each sheet holds.",
      inputSchema: {
        project_id: z.string(),
        sheet: z.string(),
        name: z.string().min(1).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        position: z.number().int().min(1).optional().describe("Place in print order among the placed sheets"),
      },
      annotations: rw,
    },
    run(async (wc, a: { project_id: string; sheet: string; name?: string; x?: number; y?: number; position?: number }) => {
      const { doc } = await wc.edit(a.project_id, (d) => {
        const page = pidSheetRef(d, a.sheet);
        const name = a.name?.trim();
        if (a.name !== undefined && !name) throw new UserError("A sheet needs a name.");
        if (name && d.pid!.pages.some((p) => p.id !== page.id && p.name.toLowerCase() === name.toLowerCase())) throw new UserError(`A P&ID sheet is already named "${name}".`);
        let cur = updatePidSheet(d, page.id, { ...(name ? { name } : {}), ...(a.x !== undefined ? { x: a.x } : {}), ...(a.y !== undefined ? { y: a.y } : {}) });
        if (a.position !== undefined) cur = orderPidSheet(cur, page.id, a.position - 1);
        applyPid(d, cur);
      });
      return `Updated.\n\n${pidSheetsText(doc)}`;
    }),
  );

  tool(
    "remove_pid_sheet",
    {
      title: "Remove P&ID sheet",
      description: "Remove a placed P&ID sheet by id or name. Its items stay on the drawing and move to the automatic sheets.",
      inputSchema: { project_id: z.string(), sheet: z.string() },
      annotations: rw,
    },
    run(async (wc, a: { project_id: string; sheet: string }) => {
      const { doc } = await wc.edit(a.project_id, (d) => {
        applyPid(d, removePidSheet(d, pidSheetRef(d, a.sheet).id));
      });
      return `Removed.\n\n${pidSheetsText(doc)}`;
    }),
  );

  tool(
    "list_pid_symbols",
    { title: "List P&ID symbols", description: "P&ID symbols by group: key, label, base size, whether it resizes, and its ports with their x,y offset from the item's centre at that size. A resized item's ports are listed when it is added.", inputSchema: {}, annotations: ro },
    run(async () => {
      const L: string[] = [];
      for (const [group, list] of pidSymbolsByGroup()) {
        L.push(`## ${group}`);
        for (const s of list) L.push(`- ${s.key} · ${s.label} · ${s.w}×${s.h}${s.scalable ? " · resizes" : ""} · ports ${portOffsets({ symbol: s.key }) || "none"}`);
      }
      return L.join("\n");
    }),
  );

  // -------------------------------------------------------------------------
  // Checks & fixes
  // -------------------------------------------------------------------------
  tool(
    "validate_project",
    {
      title: "Validate project",
      description:
        "Check a project for fan-outs (too many wires on a terminal), signal clashes (different signal types on one net), incomplete rows, missing signals, and terminals/parts that don't exist. Also reports supply overloads, wires outside their terminal block's clamp wire range, and sizing findings (wire too small, below the minimum size, fuse too big, missing fuse rating, voltage drop over the limit) with suggested values from the project's sizing standard.",
      inputSchema: { project_id: z.string() },
      annotations: ro,
    },
    run(async (wc, { project_id }: { project_id: string }) => {
      const row = await wc.project(project_id);
      const issues = findIssues(row.content, await wc.catalog());
      return issues.length ? `${issues.length} issue(s):\n${issues.map((i) => `- ${i}`).join("\n")}` : "No issues found.";
    }),
  );

  tool(
    "explain_sizing",
    {
      title: "Explain sizing",
      description:
        "One wire's sizing breakdown — current, design current, gauge, ampacity and its derating, voltage drop, the fuse or breaker behind it, and the suggested gauge — the same numbers the wire's details show in Ohmstead. Find the wire by id, or by its ends like update_connection takes them.",
      inputSchema: {
        project_id: z.string(),
        connection_id: z.string().optional().describe("Wire id from get_project."),
        from: z.string().optional().describe('"TAG:TERMINAL", e.g. "PSU1:+24V"'),
        to: z.string().optional().describe('"TAG:TERMINAL", e.g. "K1:A1"'),
      },
      annotations: ro,
    },
    run(async (wc, a: { project_id: string; connection_id?: string; from?: string; to?: string }) => {
      const row = await wc.project(a.project_id);
      const doc = row.content;
      const cat = await wc.catalog();
      let c: Connection | undefined;
      if (a.connection_id) {
        c = doc.connections.find((x) => x.id === a.connection_id);
        if (!c) throw new UserError(`No wire ${a.connection_id}. Get ids from get_project.`);
      } else {
        if (!a.from || !a.to) throw new UserError("Pass connection_id, or both from and to (TAG:TERMINAL).");
        const f = parseEndpoint(doc, a.from);
        const t = parseEndpoint(doc, a.to);
        // Either direction: a flipped wire is the same run.
        const hit = (x: Connection) =>
          (x.from.componentId === f.comp.id && x.from.port === f.port && x.to.componentId === t.comp.id && x.to.port === t.port) ||
          (x.from.componentId === t.comp.id && x.from.port === t.port && x.to.componentId === f.comp.id && x.to.port === f.port);
        const wires = doc.connections.filter(hit);
        if (!wires.length) throw new UserError(`No wire ${a.from} → ${a.to}.`);
        if (wires.length > 1) throw new UserError(`${wires.length} wires run ${a.from} → ${a.to}; pass connection_id (${wires.map((x) => x.id).join(", ")}).`);
        c = wires[0];
      }
      const { details } = sizeProject(doc, cat);
      const d = details.get(c.id);
      const head = `${endLabel(doc, c.from)} → ${endLabel(doc, c.to)} [${c.id}]`;
      if (!d) return `${head}: no sizing data (its current is unknown and its signal has no volts, so there is no drop check either).`;
      const std = standardOf(doc);
      const un = std.verified ? "" : " (unverified tables)";
      const unDrop = RESISTANCE.verified && std.verified ? "" : " (unverified tables)";
      const out = [head + ":", ...breakdownLines(d, unitsOf(doc), lengthUnitOf(doc)).map((l) => `${l.label}: ${l.value}`)];
      if (d.findings.length) {
        out.push("", "Findings:");
        for (const f of d.findings) {
          const sug = f.suggested?.awg
            ? ` Suggested: ${f.suggested.awg} AWG.`
            : f.suggested?.tripA != null
              ? ` Suggested: ${formatAmps(f.suggested.tripA)} A.`
              : "";
          out.push(`- ${f.message}${sug} ${f.why}${f.kind === "voltage_drop" ? unDrop : un}`);
        }
      }
      return out.join("\n");
    }),
  );

  tool(
    "fix_fanouts",
    {
      title: "Fix fan-outs",
      description:
        "Route every fan-out through terminal strips (one strip per electrical net, jumpered as needed), same as the app's \"Fix all\". New strips use the project default block (update_project default_block); protective-earth fan-outs get the PE block (default_pe_block, else a generic PE block). terminal_type only applies to generic blocks.",
      inputSchema: { project_id: z.string(), terminal_type: z.enum(termTypes).default("push") },
      annotations: rw,
    },
    run(async (wc, { project_id, terminal_type }: { project_id: string; terminal_type: TerminalType }) => {
      const { doc, result } = await wc.edit(project_id, (d, cat) => {
        const r = fixAll(d, cat, terminal_type);
        Object.assign(d, r.doc);
        return { fixed: r.fixed, refused: r.refused };
      });
      return (result.fixed ? `Routed ${result.fixed} fan-out(s) through terminal strips.` : "No fan-outs to fix.") + (result.refused ? `\n${result.refused}` : "") + issuesFooter(doc, await wc.catalog());
    }),
  );

  tool(
    "allow_multiple_wires",
    {
      title: "Allow multiple wires on a terminal",
      description: "Let one device terminal take several wires in this project (e.g. a two-level terminal), silencing its fan-out. allow=false reverts.",
      inputSchema: { project_id: z.string(), terminal: z.string().describe('"TAG:TERMINAL"'), allow: z.boolean().default(true) },
      annotations: rw,
    },
    run(async (wc, a: { project_id: string; terminal: string; allow: boolean }) => {
      await wc.edit(a.project_id, (d) => {
        const { comp, port } = parseEndpoint(d, a.terminal);
        const k = epKey(comp.id, port);
        d.allowMulti = d.allowMulti.filter((x) => x !== k);
        if (a.allow) d.allowMulti.push(k);
      });
      return `${a.terminal}: multiple wires ${a.allow ? "allowed" : "no longer allowed"}.`;
    }),
  );

  // -------------------------------------------------------------------------
  // Codex
  // -------------------------------------------------------------------------
  tool(
    "search_codex",
    {
      title: "Search Codex",
      description: "Search the parts library (built-in, community and yours) by name, part number, manufacturer, description or terminal name.",
      inputSchema: {
        query: z.string().default(""),
        category: z.string().optional().describe(`One of: ${PART_CATEGORIES.join(", ")}`),
        manufacturer: z.string().optional(),
        mine_only: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: ro,
    },
    run(async (wc, a: { query: string; category?: string; manufacturer?: string; mine_only: boolean; limit: number }) => {
      const uid = await wc.userId();
      const cat = await wc.catalog();
      const words = a.query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = [...cat.parts.values()].filter((p) => {
        if (a.mine_only && p.owner_id !== uid) return false;
        if (a.category && p.category.toLowerCase() !== a.category.toLowerCase()) return false;
        if (a.manufacturer && !p.manufacturer.toLowerCase().includes(a.manufacturer.toLowerCase())) return false;
        const hay = [p.name, p.serial_number, p.manufacturer, p.category, p.description, ...p.part_ports.map((t) => t.port)].join(" ").toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      if (!hits.length) return "No matching parts. Create one with save_part (ask the user for terminal details if unsure).";
      const shown = hits.slice(0, a.limit);
      return `${hits.length} match(es)${hits.length > shown.length ? `, showing ${shown.length}` : ""}:\n\n${shown.map((p) => renderPart(p, cat, uid)).join("\n\n")}`;
    }),
  );

  tool(
    "list_signal_types",
    { title: "List signal types", description: "Signal types (name, category, wire color, gauge, volts) available for terminals and wires.", inputSchema: {}, annotations: ro },
    run(async (wc) => {
      const cat = await wc.catalog();
      return [...cat.signals.values()]
        .map((s) => `- ${s.name} · ${s.category} · ${s.color_name ?? s.color}${s.awg || s.mm2 ? ` · ${formatGauge(s, "both")}` : ""}${s.volts != null ? ` · ${s.volts} V` : ""}${s.phases === 3 ? " · 3-phase" : ""}${s.dashed ? " · dashed" : ""}${s.owner_id ? "" : " · built-in"}  [${s.id}]`)
        .join("\n");
    }),
  );

  tool(
    "save_signal_type",
    {
      title: "Create or update a signal type",
      description:
        "Create a signal type (what a wire carries and the color it draws in), or update one you own (pass signal_id). Comms types draw dashed and let a terminal take several wires without a fan-out. Free users' signal types are always public; Pro ones default to private. Built-in types are read-only.",
      inputSchema: {
        signal_id: z.string().optional(),
        name: z.string().min(1),
        category: z.enum(SIGNAL_CATEGORIES).default("other"),
        color: z.string().regex(HEX, "Hex color, e.g. #7C3AED").describe("Insulation color as hex, e.g. #7C3AED"),
        stripe_color: z.string().regex(HEX, "Hex color, e.g. #FFFFFF").nullable().optional().describe("Tracer stripe as hex, or null for none"),
        color_name: z.string().optional().describe('Readable color name, e.g. "Violet" or "White/Blue"'),
        dashed: z.boolean().optional().describe("Draw dashed (cables / comms). Default: true for comms"),
        awg: z.string().nullable().optional().describe('Default wire gauge, AWG: "18", "14", "1/0". null clears it.'),
        mm2: z.number().positive().nullable().optional().describe("Default wire gauge as a cross-section in mm², e.g. 0.75. null clears it. Set either or both."),
        volts: z.number().positive().nullable().optional().describe("Nominal voltage of this signal, e.g. 24 or 120; the voltage-drop check divides by it. null clears it (no drop check)."),
        phases: z
          .union([z.literal(1), z.literal(3)])
          .nullable()
          .optional()
          .describe("1 for DC and single-phase (the default), 3 for three-phase (√3 in the drop formula). null clears it (treated as 1)."),
        public: z.boolean().optional(),
      },
      annotations: rw,
    },
    run(
      async (
        wc,
        a: {
          signal_id?: string;
          name: string;
          category: SignalCategory;
          color: string;
          stripe_color?: string | null;
          color_name?: string;
          dashed?: boolean;
          awg?: string | null;
          mm2?: number | null;
          volts?: number | null;
          phases?: 1 | 3 | null;
          public?: boolean;
        },
      ) => {
      const uid = await wc.userId();
      const cat = await wc.catalog();
      const name = a.name.trim();
      const clash = [...cat.signals.values()].find((s) => s.id !== a.signal_id && s.name.toLowerCase() === name.toLowerCase() && (s.owner_id === uid || !s.owner_id));
      if (clash) throw new UserError(`A signal type named "${clash.name}" already exists [${clash.id}].`);
      const row = {
        name,
        category: a.category,
        color: a.color,
        ...(a.stripe_color !== undefined ? { stripe_color: a.stripe_color } : {}),
        ...(a.color_name !== undefined ? { color_name: a.color_name.trim() || null } : {}),
        dashed: a.dashed ?? a.category === "comms",
        ...(a.awg !== undefined ? { awg: awgArg(a.awg) } : {}),
        ...(a.mm2 !== undefined ? { mm2: a.mm2 } : {}),
        ...(a.volts !== undefined ? { volts: a.volts } : {}),
        ...(a.phases !== undefined ? { phases: a.phases } : {}),
        ...(a.public !== undefined ? { is_public: a.public } : {}),
      };
      let saved: SignalType;
      if (a.signal_id) {
        const s = cat.signals.get(a.signal_id);
        if (!s) throw new UserError(`Unknown signal type ${a.signal_id}.`);
        if (s.owner_id !== uid) throw new UserError(`"${s.name}" isn't yours to edit${s.owner_id ? "" : " (built-in)"}.`);
        saved = check(await wc.db.from("signal_types").update(row).eq("id", s.id).select("*").single()) as SignalType;
      } else {
        saved = check(await wc.db.from("signal_types").insert({ ...row, owner_id: uid }).select("*").single()) as SignalType;
      }
      wc.invalidate();
      const s = saved;
      return `${a.signal_id ? "Updated" : "Created"} signal type: ${s.name} · ${s.category} · ${s.color_name ?? s.color}${s.awg || s.mm2 ? ` · ${formatGauge(s, "both")}` : ""}${s.volts != null ? ` · ${s.volts} V` : ""}${s.phases === 3 ? " · 3-phase" : ""}${s.dashed ? " · dashed" : ""} · ${s.is_public ? "public" : "private"}  [${s.id}]`;
    }),
  );

  tool(
    "list_manufacturers",
    { title: "List manufacturers", description: "Manufacturers available for Codex parts.", inputSchema: {}, annotations: ro },
    run(async (wc) => {
      const cat = await wc.catalog();
      return [...cat.manufacturers.values()].map((m) => `- ${m.name} (${m.short_code})  [${m.id}]`).join("\n");
    }),
  );

  const terminalInput = z.object({
    name: z.string().min(1).describe("Terminal name, or the pin name when connector is set (\"1\" in X1)"),
    connector: z.string().optional().describe('Connector this terminal is a pin of, e.g. "X1". Omit for a loose terminal.'),
    type: z.enum(termTypes),
    signal: z.string().describe("Default signal type name or id"),
    max_wires: z.number().int().min(1).max(8).default(1),
    load_a: z.number().min(0).nullable().optional().describe("Current this terminal draws in A (coil, sensor, motor FLA, VFD input). null clears it; omit to keep what's stored."),
    rated_a: z.number().min(0).nullable().optional().describe("The most this terminal supplies or carries in A (PSU output, contact rating). null clears it; omit to keep what's stored."),
    through: z.string().nullable().optional().describe('The terminal this one is joined to inside the part, so current passes between them: a switch\'s other stud, a shunt\'s other side, a bus bar\'s other end, a fuse block\'s common. null clears it; omit to keep what\'s stored.'),
    through_fused: z.boolean().optional().describe("The through link has its own fuse, sized per circuit (update_components trip_a_by_terminal): a fuse block circuit, a distributor's fused output. Omit to keep what's stored."),
    fuse_a: z.number().positive().nullable().optional().describe("The fuse the maker specifies for the wire feeding this terminal, in A (datasheet value). Sizing suggests it ahead of any calculation. null clears it; omit to keep what's stored."),
    charge_a: z.number().min(0).nullable().optional().describe("Current a charger pushes into this terminal's net in A (solar controller or DC-DC output, both polarities). Sizes its wires; never a load on the supply. null clears it; omit to keep what's stored."),
    level: z.enum(BLOCK_LEVELS as [BlockLevel, ...BlockLevel[]]).optional().describe("Terminal blocks: level A/B/C on a multi-level block. Terminals on one level are one conductor. Omit to keep what's stored."),
    side: z.enum(["in", "out"]).optional().describe("Terminal blocks: which side of the block this clamp is on. Omit to keep what's stored."),
  });
  type TerminalIn = z.infer<typeof terminalInput>;
  const connectorInput = z.object({
    name: z.string().min(1).describe('Connector name used by the terminals, e.g. "X1"'),
    gender: z.enum(["male", "female"]).optional(),
    coding: z.string().optional().describe('Keying / coding, e.g. "A" for M12 A-coded'),
  });
  type ConnectorIn = z.infer<typeof connectorInput>;
  const blockInput = z
    .object({
      kind: z.enum(BLOCK_KINDS.map((k) => k.value) as [Block["kind"], ...Block["kind"][]]).describe("feedthrough, pe, fuse, disconnect, diode, led, sensor, other; or accessory for end plates, end stops, jumper bars, markers"),
      pitch_mm: z.number().positive().optional().describe("Block width on the DIN rail"),
      wire_mm2: z.tuple([z.number().positive(), z.number().positive()]).optional().describe("Wire range per clamp [min, max] in mm²"),
      max_conductors: z.number().int().positive().optional().describe("Wires per clamp (2 = twin ferrule)"),
      rated_a: z.number().positive().optional(),
      rated_v: z.number().positive().optional(),
      jumper: z.enum(["plugin", "screw", "none"]).optional().describe("plugin = center-slot jumper (uses no clamp), screw = uses a clamp"),
      accessory: z.enum(BLOCK_ACCESSORIES.map((a) => a.value) as [NonNullable<Block["accessory"]>, ...NonNullable<Block["accessory"]>[]]).optional().describe("kind accessory only"),
      poles: z.number().int().min(2).optional().describe("Jumper bar accessories: pole count"),
      accessories: z
        .object({
          end_plate: z.string().optional(),
          end_stop: z.string().optional(),
          marker: z.string().optional(),
          jumpers: z.record(z.string(), z.string()).optional().describe('Pole count → jumper part id, e.g. {"2": "<id>", "10": "<id>"}'),
        })
        .optional()
        .describe("Accessory part ids this block uses"),
    })
    .describe("Terminal blocks only (category terminal). Pass null to clear; omit to keep what's stored.");

  const toConnectors = (list: ConnectorIn[]): PartConnector[] => list.map((c) => ({ name: c.name.trim(), gender: c.gender ?? null, coding: c.coding?.trim() || null }));

  tool(
    "save_part",
    {
      title: "Create or update Codex part",
      description:
        "Create a Codex part, or update one you own (pass part_id). A part must be complete: name, manufacturer, part number, category, description and at least one terminal (accessory parts, block.kind accessory, need none). Terminal blocks (category terminal) carry block data and per-terminal level/side; terminals can carry load_a / rated_a current data, and protective parts (fuse, breaker) list their allowed trip_ratings. Passive parts (category resistor, capacitor, inductor or diode) with exactly two terminals and no connectors draw on the schematic as inline glyphs, not blocks. Ask the user for datasheet values rather than guessing. On update the terminal list REPLACES the existing one, so include every terminal (use add_part_terminals to just add some). Free users' parts are always public; Pro parts default to private. Pass team (name or id) to create it in that team's Codex (team-only; any editor in the team can edit it later). A part using one of your own signal types in a team needs that signal type in the team too.",
      inputSchema: {
        part_id: z.string().optional(),
        team: z.string().optional().describe("New parts: team or class whose Codex it goes in. Ignored on update (a part stays where it is)."),
        name: z.string().min(1),
        manufacturer: z.string().describe("Manufacturer name, short code or id (see list_manufacturers)"),
        part_number: z.string().min(1),
        category: z.string().describe(`One of: ${PART_CATEGORIES.join(", ")}`),
        description: z.string().min(1),
        public: z.boolean().optional(),
        slot_count: z.number().int().min(0).max(64).optional().describe("PLCs: number of I/O module slots"),
        trip_ratings: z.array(z.number().positive()).nullable().optional().describe("Protective parts (fuse, breaker): trip ratings in A it can be set to, e.g. [1, 2, 4, 6, 10]. null or [] clears it; omit to keep what's stored."),
        terminals: z.array(terminalInput).default([]),
        connectors: z.array(connectorInput).optional().describe("Gender / keying per connector named by the terminals. Omit to keep what's stored."),
        block: blockInput.nullable().optional(),
      },
      annotations: rw,
    },
    run(async (wc, a: { part_id?: string; team?: string; name: string; manufacturer: string; part_number: string; category: string; description: string; public?: boolean; slot_count?: number; trip_ratings?: number[] | null; terminals: TerminalIn[]; connectors?: ConnectorIn[]; block?: Block | null }) => {
      const existing = a.part_id ? await wc.part(a.part_id) : undefined;
      const team = !a.part_id && a.team ? await wc.writableTeam(a.team) : null;
      if (team && a.public) throw new UserError("Team parts start team-only. A team owner or admin can publish one to the public Codex from Ohmstead.");
      const id = await savePart(wc, {
        id: a.part_id,
        ...(team ? { team_id: team.id } : {}),
        name: a.name,
        manufacturer_id: (await wc.manufacturer(a.manufacturer)).id,
        serial_number: a.part_number,
        category: a.category,
        description: a.description,
        is_public: a.public,
        ...(a.slot_count !== undefined ? { slot_count: a.slot_count } : {}),
        ...(a.trip_ratings !== undefined ? { trip_ratings: a.trip_ratings && [...new Set(a.trip_ratings)].sort((x, y) => x - y) } : {}),
        ...(a.connectors ? { connectors: toConnectors(a.connectors) } : {}),
        ...(a.block !== undefined ? { block: a.block } : {}),
        ports: await toPorts(wc, a.terminals, existing),
      });
      const cat = await wc.catalog(true);
      return `${a.part_id ? "Updated" : "Created"} part:\n\n${renderPart(cat.parts.get(id)!, cat, await wc.userId())}`;
    }),
  );

  tool(
    "add_part_terminals",
    {
      title: "Add terminals to a Codex part",
      description:
        "Add terminals to a Codex part. Terminals can carry load_a / rated_a current data (datasheet values, not guesses); the part's other data stays as it is. Your own parts, and team parts in a team where you're an editor or up, are changed in place; anything else is forked into your Codex first (into the team's Codex when project_id is a team project). Pass project_id to relink that project's components to the fork.",
      inputSchema: { part_id: z.string(), terminals: z.array(terminalInput).min(1), project_id: z.string().optional() },
      annotations: rw,
    },
    run(async (wc, a: { part_id: string; terminals: TerminalIn[]; project_id?: string }) => {
      const uid = await wc.userId();
      let part = await wc.part(a.part_id);
      const notes: string[] = [];
      const partTeam = part.team_id ? (await wc.teams()).find((t) => t.id === part.team_id) : undefined;
      const editable = part.owner_id === uid || (partTeam && atLeast(partTeam, "editor") && partTeam.writable);
      if (!editable) {
        const projectTeam = a.project_id ? (await wc.project(a.project_id)).team_id : null;
        const forkId = check(
          await wc.db.rpc(projectTeam ? "copy_part_to_team" : "fork_part", projectTeam ? { source_id: part.id, tid: projectTeam } : { source_id: part.id }),
        ) as string;
        part = await wc.catalog(true).then((c) => c.parts.get(forkId)!);
        notes.push(`Forked into ${projectTeam ? "the team's" : "your"} Codex as ${part.id}.`);
      }
      const addr = (t: TerminalIn) => portKey(t.connector?.trim() || null, t.name.trim()).toLowerCase();
      const dupes = a.terminals.filter((t) => part.part_ports.some((p) => p.port.toLowerCase() === addr(t)));
      if (dupes.length) throw new UserError(`${part.name} already has: ${dupes.map((d) => portKey(d.connector, d.name)).join(", ")}.`);
      const keep: TerminalIn[] = part.part_ports.map((p) => ({ name: p.pin, connector: p.connector ?? undefined, type: p.type, signal: p.signal_type_id ?? "", max_wires: p.max_wires }));
      await savePart(wc, {
        id: part.id,
        name: part.name,
        manufacturer_id: part.manufacturer_id ?? (await wc.manufacturer(part.manufacturer)).id,
        serial_number: part.serial_number,
        category: part.category,
        description: part.description,
        ports: await toPorts(wc, [...keep, ...a.terminals], part),
      });
      if (a.project_id && part.id !== a.part_id) {
        const { result } = await wc.edit(a.project_id, (d) => {
          const hit = d.components.filter((c) => c.partId === a.part_id);
          for (const c of hit) c.partId = part.id;
          return hit.map((c) => c.tag);
        });
        notes.push(result.length ? `Relinked ${result.join(", ")} to the fork.` : "No components in the project used the original part.");
      }
      const cat = await wc.catalog(true);
      return [...notes, "", renderPart(cat.parts.get(part.id)!, cat, uid)].join("\n");
    }),
  );

  tool(
    "fork_part",
    {
      title: "Fork Codex part",
      description: "Copy a built-in or community part into your own Codex so you can edit it.",
      inputSchema: { part_id: z.string() },
      annotations: rw,
    },
    run(async (wc, { part_id }: { part_id: string }) => {
      const id = check(await wc.db.rpc("fork_part", { source_id: part_id })) as string;
      const cat = await wc.catalog(true);
      return `Forked:\n\n${renderPart(cat.parts.get(id)!, cat, await wc.userId())}`;
    }),
  );

  // -------------------------------------------------------------------------
  // Import (roadmap 1.6, docs/design/import.md)
  // -------------------------------------------------------------------------
  const importDevice = z.object({
    tag: z.string().min(1).describe("Device tag as drawn; IEC designations allowed (=PUMP+CP1-K1)"),
    part_number: z.string().optional(),
    manufacturer: z.string().optional(),
    description: z.string().optional(),
    subsystem: z.string().optional().describe("Subsystem hint: IEC function, BOM section, page group"),
  });
  const importWire = z.object({
    from: z.string().describe('"TAG:TERMINAL"'),
    to: z.string().describe('"TAG:TERMINAL"'),
    signal: z.string().optional().describe("Potential / signal name as drawn (24VDC, 0V, PE, L1…)"),
    color: z.string().optional(),
    gauge: z.string().optional(),
    wire_no: z.string().optional(),
    page: z.string().optional(),
  });
  tool(
    "import_wiring_list",
    {
      title: "Import a design (wire list, BOM, or a drawing you read)",
      description:
        "Import an existing design into a NEW Ohmstead project. Sources: rows you extracted yourself (read an EPLAN / SKYCAD / AutoCAD Electrical / SolidWorks Electrical PDF page by page: devices with tags + part numbers from the parts list, wires as TAG:TERMINAL pairs from the cross-references / wire numbers, strips with their terminal order from the terminal diagrams), and/or CSV text: wire_csv (connection / wire list export) and bom_csv (BOM / parts list). Devices are matched to the Codex by part number; unknown part numbers are PROPOSED, never created unless listed in accept_parts. BOM lines no wire touches and no Codex part matches (enclosure, hardware) are listed, not placed. Strip numbers are imported locked. level: as-drawn (strips exactly as imported), light (pack, numbers kept), split-pack (split by subsystem + function, pack, numbers kept), full (split, pack, renumber). Device connections are checked to stay identical. Devices with no subsystem hint get PROPOSED subsystems from strip function and how they connect (Power, Control, field groups, areas from numbered tags), never applied unless listed in accept_subsystems; to change one, set subsystem on those device rows and run the dry run again. apply=false (default) returns the report only; show it to the user and ask before applying.",
      inputSchema: {
        title: z.string().min(1),
        team: z.string().optional().describe("Team or class name or id to create the project in. Omit for your personal workspace."),
        devices: z.array(importDevice).optional(),
        wires: z.array(importWire).optional(),
        strips: z.array(z.object({ tag: z.string(), terminals: z.array(z.string()) })).optional().describe("Terminal order per strip from terminal diagrams"),
        wire_csv: z.string().optional().describe("Wire / connection list CSV text (EPLAN, AutoCAD Electrical, SolidWorks Electrical exports; columns found by name)"),
        bom_csv: z.string().optional().describe("BOM / parts list CSV text (tag, part number, manufacturer, description, section)"),
        column_map: z.record(z.string(), z.string()).optional().describe("Override column names, e.g. {\"fromTag\": \"Start device\", \"partNumber\": \"Order no\"}"),
        source: z.enum(["eplan-pdf", "skycad", "bom", "wire-list", "acad", "swe", "other"]).default("other"),
        level: z.enum(["as-drawn", "light", "split-pack", "full"]).default("as-drawn"),
        accept_parts: z.array(z.string()).optional().describe('Proposed part numbers to create in the user\'s Codex before importing (["all"] for every proposal whose manufacturer exists)'),
        accept_subsystems: z.array(z.string()).optional().describe('Proposed subsystem names to apply (["all"] for every one). Devices left out stay at project level.'),
        apply: z.boolean().default(false),
      },
      annotations: rw,
    },
    run(
      async (
        wc,
        a: {
          title: string;
          team?: string;
          devices?: z.infer<typeof importDevice>[];
          wires?: z.infer<typeof importWire>[];
          strips?: { tag: string; terminals: string[] }[];
          wire_csv?: string;
          bom_csv?: string;
          column_map?: Record<string, string>;
          source: ImportRows["source"]["kind"];
          level: ImportLevel;
          accept_parts?: string[];
          accept_subsystems?: string[];
          apply: boolean;
        },
      ) => {
        const notes: string[] = [];
        const rows: ImportRows = {
          source: { kind: a.source },
          devices: (a.devices ?? []).map((d) => ({
            tag: d.tag,
            ...(d.part_number ? { partNumber: d.part_number } : {}),
            ...(d.manufacturer ? { manufacturer: d.manufacturer } : {}),
            ...(d.description ? { description: d.description } : {}),
            ...(d.subsystem ? { subsystem: d.subsystem } : {}),
          })),
          wires: (a.wires ?? []).map((w) => ({
            from: w.from,
            to: w.to,
            ...(w.signal ? { signal: w.signal } : {}),
            ...(w.color ? { color: w.color } : {}),
            ...(w.gauge ? { gauge: w.gauge } : {}),
            ...(w.wire_no ? { wireNo: w.wire_no } : {}),
            ...(w.page ? { page: w.page } : {}),
          })),
          ...(a.strips ? { strips: a.strips } : {}),
        };
        if (a.wire_csv) {
          const r = wiresFromCsv(a.wire_csv, a.column_map);
          rows.wires.push(...r.wires);
          if (r.issues.length) notes.push(`Wire CSV: ${r.issues.length} row(s) skipped (${r.issues.slice(0, 3).map((i) => `row ${i.row}: ${i.message}`).join("; ")})`);
        }
        if (a.bom_csv) {
          const r = devicesFromBom(a.bom_csv, a.column_map);
          rows.devices.push(...r.devices);
          if (r.issues.length) notes.push(`BOM CSV: ${r.issues.length} row(s) skipped`);
        }
        if (!rows.wires.length && !rows.devices.length) throw new UserError("Nothing to import: pass devices/wires rows, wire_csv or bom_csv.");

        let cat = await wc.catalog();
        let plan = planImport(rows, cat, { level: a.level, title: a.title, acceptSubsystems: a.accept_subsystems });

        // Accepted proposals become Codex parts (only on apply).
        if (a.apply && a.accept_parts?.length) {
          const all = a.accept_parts.some((x) => x.toLowerCase() === "all");
          const want = plan.report.proposed.filter((p) => all || a.accept_parts!.some((x) => x.trim().toLowerCase() === p.partNumber.trim().toLowerCase()));
          const fallback = [...cat.signals.values()].find((x) => x.name.toLowerCase().startsWith("digital i/o (24")) ?? [...cat.signals.values()][0];
          for (const p of want) {
            let mfr;
            try {
              mfr = await wc.manufacturer(p.manufacturer ?? "");
            } catch {
              notes.push(`Not created: ${p.partNumber} (manufacturer "${p.manufacturer ?? "?"}" isn't in the Codex; add it, then import again).`);
              continue;
            }
            if (!p.terminals.length) {
              notes.push(`Not created: ${p.partNumber} (no terminals seen on the wires).`);
              continue;
            }
            await savePart(wc, {
              name: p.description?.slice(0, 80) || p.partNumber,
              manufacturer_id: mfr.id,
              serial_number: p.partNumber,
              category: "device",
              description: p.description || `Imported from ${a.title}`,
              ports: p.terminals.map((t) => ({ port: t, connector: null, type: "screw", signal_type_id: fallback.id, max_wires: 1 })),
            });
            notes.push(`Created Codex part ${p.manufacturer} ${p.partNumber} (${p.terminals.length} terminals; check terminal types and signals).`);
          }
          cat = await wc.catalog(true);
          plan = planImport(rows, cat, { level: a.level, title: a.title, acceptSubsystems: a.accept_subsystems });
        }

        const head = [`Import "${a.title}" — ${a.apply ? "applied" : "dry run (nothing saved)"}`, ...notes.map((n) => `- ${n}`), "", reportText(plan.report, cat)];
        if (!a.apply) return [...head, "", "Show this to the user. To create the project: apply=true (and accept_parts for any proposed parts they want in their Codex, accept_subsystems for any proposed subsystems they want)."].join("\n");

        const team = a.team ? await wc.writableTeam(a.team) : null;
        const doc = plan.doc;
        if (team) for (const c of doc.components) if (c.partId) c.partId = await wc.forTeam(team.id, c.partId);
        const row = check(
          await wc.db
            .from("projects")
            .insert(team ? { team_id: team.id, title: a.title, content: doc } : { user_id: await wc.userId(), title: a.title, content: doc })
            .select("id, title")
            .single(),
        ) as { id: string; title: string };
        return [...head, "", `Created project "${row.title}" [${row.id}]. Open it in Ohmstead; run validate_project / fix_fanouts next.`].join("\n");
      },
    ),
  );

  // Resolves once write tools are hidden for Free; stdio waits for it before connecting.
  return plan();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** A terminal block part by id or part number (case-insensitive). */
function blockRef(cat: Awaited<ReturnType<Ohmstead["catalog"]>>, ref: string): Part {
  const r = ref.trim();
  const byId = cat.parts.get(r);
  const hits = byId ? [byId] : [...cat.parts.values()].filter((p) => p.serial_number.toLowerCase() === r.toLowerCase() && isBlockPart(p));
  if (!hits.length) {
    const any = byId ?? [...cat.parts.values()].find((p) => p.serial_number.toLowerCase() === r.toLowerCase());
    throw new UserError(
      any
        ? `${any.manufacturer} ${any.serial_number} isn't a terminal block (category terminal with block data). Add block data with save_part.`
        : `No terminal block "${ref}" in the Codex. search_codex category terminal lists blocks.`,
    );
  }
  if (!isBlockPart(hits[0])) throw new UserError(`${hits[0].manufacturer} ${hits[0].serial_number} isn't a terminal block (category terminal with block data).`);
  if (hits.length > 1) throw new UserError(`Several blocks have part number ${ref}: ${hits.map((p) => `${p.manufacturer} [${p.id}]`).join(", ")}. Pass the id.`);
  return hits[0];
}

const blockName = (p: Part) => {
  const lv = levelsOf(p);
  return `${p.manufacturer} ${p.serial_number}${lv.length ? ` (${lv.length} levels)` : ""} [${p.id}]`;
};

function groupRef(d: WireDoc, ref: string): string {
  const g = d.groups.find((x) => x.id === ref) ?? d.groups.find((x) => x.name.toLowerCase() === ref.trim().toLowerCase());
  if (!g) throw new UserError(`No subsystem "${ref}". Create it with add_subsystem (existing: ${d.groups.map((x) => x.name).join(", ") || "none"}).`);
  return g.id;
}

function addStripTerminalIfNew(d: WireDoc, componentId: string, label: string, isNew: boolean) {
  if (!isNew) return;
  const comp = d.components.find((c) => c.id === componentId);
  comp?.strip?.terminals.push({ id: nanoid(8), label, jumperNext: false });
}

async function buildConnection(
  wc: Ohmstead,
  d: WireDoc,
  cat: Awaited<ReturnType<Ohmstead["catalog"]>>,
  w: { from: string; to: string; signal?: string; note?: string; draw?: "auto" | "wire" | "ref"; gauge?: string; bundle?: string; length?: number | null },
): Promise<Connection> {
  const a = parseEndpoint(d, w.from);
  const b = parseEndpoint(d, w.to);
  const ra = resolvePort(a.comp, a.port, cat, d);
  const rb = resolvePort(b.comp, b.port, cat, d);
  if (a.comp.id === b.comp.id && ra.port === rb.port) throw new UserError(`${w.from} → ${w.to}: a wire can't start and end on the same terminal.`);
  addStripTerminalIfNew(d, a.comp.id, ra.port, ra.newStripTerminal);
  addStripTerminalIfNew(d, b.comp.id, rb.port, rb.newStripTerminal);
  const signalTypeId = w.signal ? (await wc.signal(w.signal)).id : (ra.signalTypeId ?? rb.signalTypeId);
  return {
    id: nanoid(10),
    from: { componentId: a.comp.id, port: ra.port },
    to: { componentId: b.comp.id, port: rb.port },
    signalTypeId,
    ...(w.note ? { note: w.note } : {}),
    ...(w.draw && w.draw !== "auto" ? { display: w.draw } : {}),
    ...(w.gauge ? gaugePatch(gaugeArg(w.gauge, d)) : {}),
    ...(w.bundle?.trim() ? { bundle: w.bundle.trim() } : {}),
    ...(w.length != null ? { length: lengthArgM(w.length, d) } : {}),
  };
}

/** A length argument in the project's unit, converted to metres (how lengths are stored). */
function lengthArgM(n: number, d: WireDoc) {
  return lengthUnitOf(d) === "m" ? n : ftToM(n);
}

/** Parse a gauge argument in the project's units; "" = clear (inherit). */
function gaugeArg(text: string, d: WireDoc) {
  const v = parseGauge(text, unitsOf(d));
  if (!v) throw new UserError(`"${text}" isn't a wire gauge. Use an AWG size (18, 14, 1/0) or mm² ("1.5 mm²").`);
  return v;
}

function awgArg(text: string | null): string | null {
  if (text === null || !text.trim()) return null;
  const v = normalizeAwg(text);
  if (!v) throw new UserError(`"${text}" isn't an AWG size. Use e.g. 18, 14 or 1/0.`);
  return v;
}

/** "TAG:X1" → a connector end that exists on that component's Codex part. */
function connectorRef(d: WireDoc, cat: Awaited<ReturnType<Ohmstead["catalog"]>>, ref: string): ConnectorEnd {
  const { comp, port } = parseEndpoint(d, ref);
  const part = comp.partId ? cat.parts.get(comp.partId) : undefined;
  const conns = connectorsOf(part);
  const hit = conns.find((c) => c.name === port) ?? conns.find((c) => c.name.toLowerCase() === port.toLowerCase());
  if (!hit)
    throw new UserError(
      `${comp.tag} has no connector "${port}". ${conns.length ? `Connectors: ${conns.map((c) => c.name).join(", ")}.` : "Its Codex part has no connectors; group terminals into one with save_part (terminal.connector)."}`,
    );
  return { componentId: comp.id, connector: hit.name };
}

function cableRef(d: WireDoc, ref: string): Cable {
  const w = d.cables.find((x) => x.id === ref) ?? d.cables.find((x) => x.tag.toLowerCase() === ref.trim().toLowerCase());
  if (!w) throw new UserError(`No cable "${ref}" (cables: ${d.cables.map((x) => x.tag).join(", ") || "none"}).`);
  return w;
}

/** Replace a cable's conductors with an explicit pin map. */
async function setPinMap(wc: Ohmstead, d: WireDoc, cat: Awaited<ReturnType<Ohmstead["catalog"]>>, cable: Cable, list: { from_pin: string; to_pin: string; signal?: string; color?: string; gauge?: string }[]) {
  const a = cables.placedConnector(d, cat, cable.from);
  const b = cables.placedConnector(d, cat, cable.to);
  if (!a || !b) throw new UserError(`${cable.tag}: a connector on this cable no longer exists on its part.`);
  const pin = (pins: typeof a.pins, name: string, where: string) => {
    const p = pins.find((x) => x.pin === name) ?? pins.find((x) => x.pin.toLowerCase() === name.trim().toLowerCase());
    if (!p) throw new UserError(`${where} has no pin "${name}" (pins: ${pins.map((x) => x.pin).join(", ")}).`);
    return p;
  };
  const next: Connection[] = [];
  for (const c of list) {
    const p = pin(a.pins, c.from_pin, `${a.comp.tag}:${a.name}`);
    const q = pin(b.pins, c.to_pin, `${b.comp.tag}:${b.name}`);
    next.push({
      id: nanoid(10),
      from: { componentId: a.comp.id, port: p.port },
      to: { componentId: b.comp.id, port: q.port },
      signalTypeId: c.signal ? (await wc.signal(c.signal)).id : (p.signal_type_id ?? q.signal_type_id ?? null),
      cableId: cable.id,
      ...(c.color?.trim() ? { color: c.color.trim().toUpperCase() } : {}),
      ...(c.gauge?.trim() ? gaugePatch(gaugeArg(c.gauge, d)) : {}),
    });
  }
  d.connections = [...d.connections.filter((c) => c.cableId !== cable.id), ...next];
}

type PortDraft = { id?: string; port: string; connector: string | null; type: TerminalType; signal_type_id: string; max_wires: number; load_a?: number | null; rated_a?: number | null; through?: string | null; through_fused?: boolean; charge_a?: number | null; fuse_a?: number | null; level?: BlockLevel | null; side?: "in" | "out" | null };

/**
 * Resolve signal names and keep existing terminal ids (matched by address) so the RPC
 * updates in place. A name written as an address ("X1.3") of an existing pin keeps its connector.
 */
async function toPorts(
  wc: Ohmstead,
  terms: { name: string; connector?: string; type: TerminalType; signal: string; max_wires: number; load_a?: number | null; rated_a?: number | null; through?: string | null; through_fused?: boolean; charge_a?: number | null; fuse_a?: number | null; level?: BlockLevel; side?: "in" | "out" }[],
  existing?: Part,
): Promise<PortDraft[]> {
  const out: PortDraft[] = [];
  for (const t of terms) {
    const name = t.name.trim();
    const byAddr = !t.connector ? existing?.part_ports.find((p) => p.connector && p.port === name) : undefined;
    const connector = t.connector?.trim() || byAddr?.connector || null;
    const pin = byAddr ? byAddr.pin : name;
    const prev = existing?.part_ports.find((p) => p.port === portKey(connector, pin));
    // Level / side only when given, so the RPC keeps what's stored otherwise.
    // Current: omitted keeps the stored value (the RPC would null it), null clears it.
    out.push({
      id: prev?.id,
      port: pin,
      connector,
      type: t.type,
      signal_type_id: (await wc.signal(t.signal)).id,
      max_wires: t.max_wires ?? 1,
      load_a: t.load_a !== undefined ? t.load_a : (prev?.load_a ?? null),
      rated_a: t.rated_a !== undefined ? t.rated_a : (prev?.rated_a ?? null),
      through: t.through !== undefined ? t.through : (prev?.through ?? null),
      through_fused: t.through_fused !== undefined ? t.through_fused : (prev?.through_fused ?? false),
      charge_a: t.charge_a !== undefined ? t.charge_a : (prev?.charge_a ?? null),
      fuse_a: t.fuse_a !== undefined ? t.fuse_a : (prev?.fuse_a ?? null),
      ...(t.level ? { level: t.level } : {}),
      ...(t.side ? { side: t.side } : {}),
    });
  }
  return out;
}

async function savePart(
  wc: Ohmstead,
  p: {
    id?: string;
    team_id?: string;
    name: string;
    manufacturer_id: string;
    serial_number: string;
    category: string;
    description: string;
    is_public?: boolean;
    slot_count?: number;
    trip_ratings?: number[] | null;
    connectors?: PartConnector[];
    block?: Block | null;
    ports: PortDraft[];
  },
): Promise<string> {
  const id = check(await wc.db.rpc("save_part", { p })) as string;
  wc.invalidate();
  return id;
}
