# Ohmstead MCP server

[Ohmstead](https://ohmstead.io?ref=mcp) builds wiring schematics without CAD: you type the wires as rows,
it draws the schematic, terminal strips and PDF drawing set. This package lets Claude (and other MCP
clients) do the typing: add parts from the Codex, wire components, run checks and fix fan-outs in your
Ohmstead projects, as you.

You need an Ohmstead account: download the app and sign in with your email. Pro and Student get every tool. Free accounts can read projects, search the Codex and run checks
([plans](https://ohmstead.io/?ref=mcp#pricing)).

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

Requires Node 20+. Questions: [howdy@ohmstead.io](mailto:howdy@ohmstead.io).
