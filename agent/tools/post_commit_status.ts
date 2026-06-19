import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

// ---- Logger ----
type LogLevel = "debug" | "info" | "warn" | "error";
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
const LEVEL =
  (process.env.LOG_LEVEL as LogLevel) ??
  (process.env.NODE_ENV === "production" ? "info" : "debug");
const IS_JSON =
  process.env.LOG_FORMAT === "json" || process.env.NODE_ENV === "production";

function writeLog(
  level: LogLevel,
  prefix: string,
  message: string,
  ctx: Record<string, unknown> = {},
) {
  if (LOG_LEVELS[level] < LOG_LEVELS[LEVEL]) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message: `[${prefix}] ${message}`,
    context: ctx,
  };
  const output = IS_JSON
    ? JSON.stringify(entry)
    : `[${new Date().toLocaleTimeString("en-US", { hour12: false })}] [${level.toUpperCase()}] [${prefix}] ${message}${Object.keys(ctx).length ? " " + JSON.stringify(ctx) : ""}`;
  (level === "error"
    ? console.error
    : level === "warn"
      ? console.warn
      : console.log)(output);
}
const logger = (prefix: string) => ({
  debug: (m: string, c?: Record<string, unknown>) =>
    writeLog("debug", prefix, m, c),
  info: (m: string, c?: Record<string, unknown>) =>
    writeLog("info", prefix, m, c),
  warn: (m: string, c?: Record<string, unknown>) =>
    writeLog("warn", prefix, m, c),
  error: (m: string, c?: Record<string, unknown>) =>
    writeLog("error", prefix, m, c),
});

const log = logger("tools");

const STATUSES = ["pending", "running", "success", "failed", "canceled"] as const;
type CommitStatus = (typeof STATUSES)[number];

export default defineTool({
  description:
    "Set a commit status on the GitLab merge request's latest commit. Useful for showing pending/running/success/failed in the MR pipeline UI.",
  inputSchema: z.object({
    projectId: z.number().describe("The GitLab project ID"),
    mrIid: z.number().describe("The merge request IID"),
    status: z
      .enum(STATUSES)
      .describe(
        "The commit status: pending, running, success, failed, or canceled",
      ),
    description: z
      .string()
      .max(140)
      .describe("Short description shown in the pipeline UI (max 140 chars)"),
    targetUrl: z
      .string()
      .url()
      .optional()
      .describe("Optional URL to link the status badge to (e.g. a build log)"),
  }),
  needsApproval: never(),

  async execute({ projectId, mrIid, status, description, targetUrl }) {
    const ctx = { projectId, mrIid, tool: "post_commit_status", status };
    const startTime = performance.now();

    log.info("Setting commit status", ctx);

    // Fetch the MR to get the latest commit SHA
    const mrRes = await fetch(
      `${process.env.GITLAB_BASE_URL}/api/v4/projects/${projectId}/merge_requests/${mrIid}`,
      { headers: { "PRIVATE-TOKEN": process.env.GITLAB_PRIVATE_TOKEN! } },
    );

    if (!mrRes.ok) {
      const error = await mrRes.text().catch(() => "unknown");
      log.error("Failed to fetch MR details", {
        ...ctx,
        status: mrRes.status,
        error: error.slice(0, 500),
      });
      throw new Error(`GitLab API error ${mrRes.status}: ${error}`);
    }

    const mrData = await mrRes.json();
    const sha: string | undefined = mrData.sha;

    if (!sha) {
      log.error("No SHA found on MR", ctx);
      throw new Error("Could not determine the latest commit SHA");
    }

    // Set the status on that commit
    const body: Record<string, unknown> = {
      state: status,
      description,
      context: "eve-code-review",
    };
    if (targetUrl) body.target_url = targetUrl;

    const statusRes = await fetch(
      `${process.env.GITLAB_BASE_URL}/api/v4/projects/${projectId}/statuses/${sha}`,
      {
        method: "POST",
        headers: {
          "PRIVATE-TOKEN": process.env.GITLAB_PRIVATE_TOKEN!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    const durationMs = Math.round(performance.now() - startTime);

    if (!statusRes.ok) {
      const error = await statusRes.text().catch(() => "unknown");
      log.error("Failed to set commit status", {
        ...ctx,
        sha,
        statusCode: statusRes.status,
        error: error.slice(0, 500),
        durationMs,
      });
      throw new Error(`GitLab API error ${statusRes.status}: ${error}`);
    }

    log.info("Commit status set successfully", {
      ...ctx,
      sha,
      description,
      durationMs,
    });

    return { success: true, sha, status };
  },
});
