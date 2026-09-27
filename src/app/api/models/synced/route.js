import { NextResponse } from "next/server";
import { getSyncedModelsMap } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/models/synced - returns the full syncedModels kv map
// shape: { "connectionId:modelId": { lastSyncedAt, firstSeenAt } }
export async function GET() {
  try {
    const synced = await getSyncedModelsMap();
    return NextResponse.json(synced);
  } catch (error) {
    console.log("Error fetching synced models:", error);
    return NextResponse.json({ error: "Failed to fetch synced models" }, { status: 500 });
  }
}
