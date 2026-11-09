// Which Supabase project to talk to, first match wins:
//   1. OHMSTEAD_SUPABASE_URL + OHMSTEAD_SUPABASE_ANON_KEY (env)
//   2. ~/.ohmstead/backend.json, saved by `ohmstead-mcp login --server … / --desktop`
//   3. the app's .env.local (local Supabase from `supabase start`)

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Config = { url: string; anonKey: string; source: string };
type Backend = { url: string; anonKey: string };

/** Where sessions and the saved backend live. */
export const HOME_DIR = process.env.OHMSTEAD_HOME ?? join(homedir(), ".ohmstead");
export const BACKEND_FILE = join(HOME_DIR, "backend.json");

function readDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function readBackend(path: string): Backend | null {
  try {
    const b = JSON.parse(readFileSync(path, "utf8"));
    return b?.url && b?.anonKey ? { url: b.url, anonKey: b.anonKey } : null;
  } catch {
    return null;
  }
}

export function loadConfig(): Config {
  const url = process.env.OHMSTEAD_SUPABASE_URL;
  const anonKey = process.env.OHMSTEAD_SUPABASE_ANON_KEY;
  if (url && anonKey) return { url, anonKey, source: "env" };

  const saved = readBackend(BACKEND_FILE);
  if (saved) return { ...saved, source: BACKEND_FILE };

  // dist/stdio.js → ../../.env.local is the app's env file.
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env.local");
  const env = readDotEnv(envPath);
  if (env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { url: env.NEXT_PUBLIC_SUPABASE_URL, anonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, source: envPath };
  }
  throw new Error(
    "No Supabase configured. Run `ohmstead-mcp login --desktop` (same server as the Ohmstead app) or `--server <url> --key <anon key>`, or set OHMSTEAD_SUPABASE_URL and OHMSTEAD_SUPABASE_ANON_KEY.",
  );
}

/** The backend the installed desktop app uses: its own choice, else the one it shipped with. */
export function desktopBackend(): Backend | null {
  const home = homedir();
  const os = platform();
  const userData =
    os === "darwin" ? join(home, "Library", "Application Support", "Ohmstead")
    : os === "win32" ? join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Ohmstead")
    : join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "Ohmstead");
  const bundled =
    os === "darwin" ? ["/Applications/Ohmstead.app", join(home, "Applications", "Ohmstead.app")].map((a) => join(a, "Contents", "Resources", "server", "backend.json"))
    : os === "win32" ? [join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs", "Ohmstead", "resources", "server", "backend.json")]
    : [];
  for (const f of [join(userData, "backend.json"), ...bundled]) {
    const b = readBackend(f);
    if (b) return b;
  }
  return null;
}

/** Remember a backend for later runs (login, whoami, and the MCP server itself). */
export function saveBackend(b: Backend) {
  mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(BACKEND_FILE, JSON.stringify({ url: b.url.replace(/\/+$/, ""), anonKey: b.anonKey }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(BACKEND_FILE, 0o600);
}

export function forgetBackend() {
  rmSync(BACKEND_FILE, { force: true });
}
