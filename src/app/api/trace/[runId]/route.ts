import { getRunTrace, isValidRunId } from "@/lib/trace/trace-store";

// GET only. Looks up a stored run trace by id and returns nothing but the trace.
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ runId: string }> };

function notFound(): Response {
  return Response.json(
    { error: "Trace not found" },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { runId } = await context.params;
    if (!isValidRunId(runId)) return notFound();
    const events = getRunTrace(runId);
    if (events === undefined) return notFound();
    return new Response(JSON.stringify(events, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="trace_${runId}.json"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return notFound();
  }
}
