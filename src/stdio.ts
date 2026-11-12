// ohmstead-mcp — stdio MCP server for Claude Code / Claude Desktop.
//   ohmstead-mcp login    sign in with an emailed code (once per Supabase project)
//       --desktop                    use the same server as the installed Ohmstead app
//       --server <url> --key <anon>  use a company / on-prem server
//       --reset                      forget the saved server (back to env / .env.local)
//   ohmstead-mcp logout   forget the saved session
//   ohmstead-mcp whoami   show who is signed in
//   ohmstead-mcp          serve MCP over stdio (what MCP clients run)

import { createInterface } from "node:readline/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { clearSession, makeClient, sessionFile, signedInClient } from "./auth.js";
import { desktopBackend, forgetBackend, loadConfig, saveBackend } from "./config.js";
import { INSTRUCTIONS, registerTools } from "./tools.js";

const VERSION = "0.1.1";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

/** `login --desktop | --server <url> --key <anon> | --reset` saves the choice before signing in. */
function chooseBackend() {
  const has = (f: string) => process.argv.includes(f);
  if (has("--reset")) forgetBackend();
  if (has("--desktop")) {
    const b = desktopBackend();
    if (!b) throw new Error("Couldn't find the Ohmstead app's server settings. Install and open the app once, or use --server <url> --key <anon key>.");
    saveBackend(b);
  } else if (has("--server")) {
    const url = arg("--server");
    const anonKey = arg("--key");
    if (!url || !/^https?:\/\//.test(url) || !anonKey) throw new Error("Usage: ohmstead-mcp login --server https://… --key <anon key>");
    saveBackend({ url, anonKey });
  }
}

async function login() {
  chooseBackend();
  const cfg = loadConfig();
  if (cfg.source === "env" && process.argv.some((a) => ["--desktop", "--server"].includes(a))) {
    console.log("Note: OHMSTEAD_SUPABASE_URL is set, so it wins over the saved server.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Ohmstead at ${cfg.url}`);
  const email = (await rl.question("Email: ")).trim();
  const sb = makeClient(cfg);
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  if (error) {
    rl.close();
    throw new Error(/signups? not allowed|not found/i.test(error.message) ? "That email doesn't have a Ohmstead account." : error.message);
  }
  const local = /127\.0\.0\.1|localhost/.test(cfg.url);
  console.log(`Sent a sign-in code to ${email}.${local ? " (Local Supabase: open http://127.0.0.1:54324 to read it.)" : ""}`);
  const code = (await rl.question("Code (or paste the sign-in link): ")).trim();
  rl.close();
  // Projects whose email template has no {{ .Token }} send a magic link instead; its `token` is the token hash.
  const link = /^https?:\/\//.test(code) ? new URL(code).searchParams : null;
  const res = link?.get("token")
    ? await sb.auth.verifyOtp({ token_hash: link.get("token")!, type: link.get("type") === "signup" ? "signup" : "magiclink" })
    : await sb.auth.verifyOtp({ email, token: code, type: "email" });
  if (res.error) throw new Error("That code is wrong or expired. Run login again for a new one.");
  console.log(`Signed in as ${res.data.user?.email}. Session saved to ${sessionFile(cfg)}`);
}

async function whoami() {
  const cfg = loadConfig();
  const sb = await signedInClient(cfg);
  const { data } = await sb.auth.getUser();
  console.log(`${data.user?.email} @ ${cfg.url} (config: ${cfg.source})`);
}

async function serve() {
  const cfg = loadConfig();
  const server = new McpServer({ name: "ohmstead", version: VERSION }, { instructions: INSTRUCTIONS });
  // Sign-in is checked per call so the server still starts (and says how to log in) when signed out.
  // Waits for the plan so a Free user's first tool list is already read-only.
  await registerTools(server, { getClient: () => signedInClient(cfg) });
  await server.connect(new StdioServerTransport());
}

const cmd = process.argv[2];
const main = cmd === "login" ? login : cmd === "logout" ? async () => (clearSession(loadConfig()), console.log("Signed out.")) : cmd === "whoami" ? whoami : serve;

main()
  .then(() => {
    // supabase-js keeps a refresh timer alive; CLI commands should exit.
    if (cmd) process.exit(0);
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
