/// <reference path="./assets.d.ts" />
// Tool edits update the project's living embed, as saves in the app do. Runs after the tool has answered, and only for a
// project with a link. Loaded on first use: most sessions never need ELK or the rasterizer.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Catalog } from "@/lib/schematic";
import type { ProjectRow } from "@/lib/types";

const WAIT_MS = 2000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const running = new Set<string>();

async function publish(db: SupabaseClient, projectId: string, catalog: () => Promise<Catalog>) {
  const links = await db.from("project_embeds").select("token").eq("project_id", projectId).is("revision_id", null);
  if (links.error || !links.data?.length) return;
  const row = await db.from("projects").select("title, content, updated_at").eq("id", projectId).single<Pick<ProjectRow, "title" | "content" | "updated_at">>();
  if (row.error) throw new Error(row.error.message);
  const current = await db.from("project_snapshots").select("source_updated_at").eq("project_id", projectId).maybeSingle();
  if (current.data && new Date(current.data.source_updated_at) >= new Date(row.data.updated_at)) return;

  const [{ buildSnapshot }, { publishLiving }, { rasterizer }, { normalizeDoc }, wasm, regular, bold] = await Promise.all([
    import("@/lib/embed/snapshot"),
    import("@/lib/embed/publish"),
    import("@/lib/embed/raster"),
    import("@/lib/types"),
    import("../../node_modules/@resvg/resvg-wasm/index_bg.wasm"),
    import("../../src/lib/embed/fonts/Arimo-Regular.ttf"),
    import("../../src/lib/embed/fonts/Arimo-Bold.ttf"),
  ]);
  const toPng = rasterizer(async () => ({ wasm: wasm.default as BufferSource, fonts: [regular.default, bold.default] }));
  const snap = await buildSnapshot(normalizeDoc(row.data.content), await catalog(), { title: row.data.title, updatedAt: row.data.updated_at, pinned: false }, toPng);
  await publishLiving(db, projectId, row.data.updated_at, snap);
}

/** Hosted: publish now, inside the request's waitUntil. Never throws. */
export async function publishEmbedNow(db: SupabaseClient, projectId: string, catalog: () => Promise<Catalog>) {
  try {
    await publish(db, projectId, catalog);
  } catch (e) {
    console.error("Couldn't update the embed:", e instanceof Error ? e.message : e);
  }
}

export function scheduleEmbedPublish(db: SupabaseClient, projectId: string, catalog: () => Promise<Catalog>) {
  clearTimeout(timers.get(projectId));
  timers.set(
    projectId,
    setTimeout(async () => {
      if (running.has(projectId)) return scheduleEmbedPublish(db, projectId, catalog);
      running.add(projectId);
      try {
        await publish(db, projectId, catalog);
      } catch (e) {
        // stderr: stdout belongs to the MCP protocol.
        console.error("Couldn't update the embed:", e instanceof Error ? e.message : e);
      } finally {
        running.delete(projectId);
      }
    }, WAIT_MS),
  );
}
