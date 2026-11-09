# Ohmstead MCP server

[Ohmstead](https://ohmstead.io?ref=mcp) builds wiring schematics without CAD: you type the wires as rows,
it draws the schematic, terminal strips and PDF drawing set. This package lets Claude (and other MCP
clients) do the typing: add parts from the Codex, wire components, run checks and fix fan-outs in your
Ohmstead projects, as you.

You need an Ohmstead account: download the app and sign in with your email. Pro and Student get every tool. Free accounts can read projects, search the Codex and run checks
([plans](https://ohmstead.io/?ref=mcp#pricing)).

## Why it's different

Most schematic MCP servers drive a CAD program: they click, place symbols and draw lines in EPLAN, AutoCAD
Electrical, Altium or KiCad while it runs on your machine. Ohmstead has no drawing to drive. A project is data
(parts, wire rows, strips, cables), so the assistant edits the design itself and Ohmstead draws the result.

- **Official.** Made by Ohmstead and listed in the MCP Registry as `io.ohmstead/mcp`.
- **Wires, not coordinates.** `PSU1:+ → TB1:3` is the whole instruction. Forty I/O points are one call.
- **It checks its own work.** `validate_project` sizes wires and fuses (NEC, NFPA 79, ABYC E-11), finds
  fan-outs, wrong clamps and mismatched connectors, and `fix_fanouts` / `optimize_strips` repair them.
- **Real parts.** The Codex is a shared library of parts with their terminals, ratings and connectors.
  The assistant searches it before it adds anything.
- **From a PDF to a project.** The assistant reads a vendor or EPLAN wiring list and `import_wiring_list`
  builds the project, parts and wires.
- **No CAD seat.** One `npx` command on macOS, Windows or Linux.

## Set up

Install the [Ohmstead app](https://ohmstead.io/?ref=mcp#start) and open it once, then sign in here with
the same email (you'll get a code):

```bash
npx -y ohmstead login --desktop
```

**Claude Code**

```bash
claude mcp add ohmstead -s user -- npx -y ohmstead
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "ohmstead": { "command": "npx", "args": ["-y", "ohmstead"] }
  }
}
```

Then ask for something real: *"Make a project for a 3-phase motor starter with an E-stop, wire it, and fix
any fan-outs."* Open the project in Ohmstead (reload if it's already open) to see the drawing.

`npx -y ohmstead whoami` shows who is signed in, `logout` signs out. The session is kept in `~/.ohmstead/`.
Company or on-prem server: `npx -y ohmstead login --server https://… --key <anon key>`.

## What it can do

| Area | Tools |
|---|---|
| Projects | `list_projects`, `get_project`, `create_project`, `update_project`, `import_wiring_list`, `export_project_file`, `import_project_file` |
| Components | `add_components`, `update_components`, `add_subsystem` |
| Wires and cables | `add_connections`, `update_connection`, `remove_connections`, `add_cable`, `update_cable`, `remove_cable` |
| Terminal strips | `add_terminal_strip`, `fix_fanouts`, `optimize_strips`, `split_strips`, `set_strip_blocks`, `set_strip_parts` |
| P&ID | `add_pid_items`, `update_pid_items`, `add_process_lines`, `link_instrument`, `remove_pid_items`, `remove_process_lines`, `list_pid_symbols`, `add_pid_sheet`, `update_pid_sheet`, `remove_pid_sheet` |
| Checks | `validate_project`, `allow_multiple_wires` |
| Codex (parts library) | `search_codex`, `save_part`, `add_part_terminals`, `fork_part`, `list_signal_types`, `save_signal_type`, `list_manufacturers` |

Everything runs under your account's permissions, the same as the app. It reads and edits; it never deletes
projects or Codex parts.

## Source

`src/` is the server: `stdio.ts` starts it, `tools.ts` defines every tool, `ohmstead.ts` reads and writes
projects and the Codex through Supabase as the signed-in user, and `auth.ts` / `config.ts` handle sign-in.
The drawing, sizing and checking engine is shared with the Ohmstead app and ships bundled inside the
[`ohmstead`](https://www.npmjs.com/package/ohmstead) npm package (`build.mjs` makes that bundle). The
Dockerfile runs the published package.

Licensed under the [Functional Source License 1.1, MIT future license](LICENSE.md).

Requires Node 20+. Questions: [howdy@ohmstead.io](mailto:howdy@ohmstead.io).
