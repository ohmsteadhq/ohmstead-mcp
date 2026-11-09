// Signs in as the user (emailed code, same as the beta login) and keeps the
// session in ~/.ohmstead, one file per Supabase project. Every query then runs
// under the user's own Row Level Security.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { HOME_DIR, type Config } from "./config.js";

const DIR = HOME_DIR;

const sessionName = (cfg: Config) => `session-${createHash("sha256").update(cfg.url).digest("hex").slice(0, 12)}.json`;

export const sessionFile = (cfg: Config) => join(DIR, sessionName(cfg));

/** Synchronous file-backed storage for supabase-js auth. */
function fileStorage(path: string) {
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return {}; // missing or unreadable
    }
  };
  const write = (data: Record<string, string>) => {
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
  };
  return {
    getItem: (k: string) => read()[k] ?? null,
    setItem: (k: string, v: string) => write({ ...read(), [k]: v }),
    removeItem: (k: string) => {
      const d = read();
      delete d[k];
      write(d);
    },
  };
}

export function makeClient(cfg: Config): SupabaseClient {
  return createClient(cfg.url, cfg.anonKey, {
    auth: {
      storage: fileStorage(sessionFile(cfg)),
      // Key inside the session file. Pre-rename name; changing it would sign everyone out.
      storageKey: "wirecode-auth",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
}

export function clearSession(cfg: Config) {
  const f = sessionFile(cfg);
  if (existsSync(f)) rmSync(f);
}

/** Signed-in client, or a clear error telling the user how to log in. */
export async function signedInClient(cfg: Config): Promise<SupabaseClient> {
  const sb = makeClient(cfg);
  const { data, error } = await sb.auth.getUser();
  if (error || !data.user) {
    throw new Error(`Not signed in to Ohmstead (${cfg.url}). Run \`ohmstead-mcp login\` in a terminal, then retry.`);
  }
  return sb;
}
