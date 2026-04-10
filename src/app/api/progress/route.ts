/**
 * Server-Sent Events (SSE) Endpoint for Processing Progress
 *
 * Polls the database every 500ms and streams job progress to the client.
 * Closes when job completes, fails, or is cancelled.
 */

import { db } from "@/db";
import { processingJobs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get("jobId");

  if (!jobId) {
    return new Response("Missing jobId parameter", { status: 400 });
  }

  const jobIdNum = parseInt(jobId, 10);
  if (isNaN(jobIdNum)) {
    return new Response("Invalid jobId parameter", { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let isActive = true;

      const sendEvent = (data: object) => {
        if (!isActive) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          isActive = false;
        }
      };

      const poll = async () => {
        if (!isActive) return;

        try {
          const [job] = await db
            .select()
            .from(processingJobs)
            .where(eq(processingJobs.id, jobIdNum));

          if (!job) {
            sendEvent({ error: "Job not found", status: "not_found" });
            isActive = false;
            controller.close();
            return;
          }

          sendEvent({
            jobId: job.id,
            status: job.status,
            processed: job.processedImages,
            total: job.totalImages,
            failed: job.failedImages,
            statusMessage: job.statusMessage,
            jobType: job.jobType,
            startedAt: job.startedAt?.toISOString() ?? null,
            downloadedImages: job.downloadedImages ?? 0,
            downloadTotal: job.downloadTotal ?? 0,
            cachedImages: job.cachedImages ?? 0,
            errorMessage: job.errorMessage,
          });

          if (["completed", "failed", "cancelled"].includes(job.status)) {
            isActive = false;
            controller.close();
            return;
          }

          if (isActive) {
            setTimeout(poll, 500);
          }
        } catch (error) {
          log.error({ err: error }, "SSE poll error");
          if (isActive) {
            sendEvent({ error: "Database error", status: "error" });
            isActive = false;
            controller.close();
          }
        }
      };

      poll();

      request.signal.addEventListener("abort", () => {
        isActive = false;
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
