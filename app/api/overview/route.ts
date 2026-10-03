import { handleOverview } from "@/lib/overviewHandler";
import { getDeps } from "@/lib/server";

export const runtime = "nodejs"; // iconv-lite + in-memory stream store need the Node runtime
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return handleOverview(req, getDeps());
}
