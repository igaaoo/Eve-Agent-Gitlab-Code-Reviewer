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

export default defineTool({
  description:
    "Post a review comment on a GitLab merge request as a general note.",
  inputSchema: z.object({
    projectId: z.number().describe("The GitLab project ID"),
    mrIid: z.number().describe("The merge request IID"),
    comment: z.string().describe("The review comment in Markdown format"),
  }),
  needsApproval: never(),

  async execute({ projectId, mrIid, comment }) {
    const ctx = { projectId, mrIid, tool: "post_mr_comment" };
    const startTime = performance.now();

    const commentPreview =
      comment.length > 200
        ? comment.slice(0, 200) + `... (${comment.length} chars)`
        : comment;

    log.info("Posting review to GitLab", {
      ...ctx,
      commentPreview,
      commentLength: comment.length,
    });

    const res = await fetch(
      `${process.env.GITLAB_BASE_URL}/api/v4/projects/${projectId}/merge_requests/${mrIid}/notes`,
      {
        method: "POST",
        headers: {
          "PRIVATE-TOKEN": process.env.GITLAB_PRIVATE_TOKEN!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: comment }),
      },
    );

    const durationMs = Math.round(performance.now() - startTime);

    if (!res.ok) {
      const error = await res.text();
      log.error("Failed to post review to GitLab", {
        ...ctx,
        status: res.status,
        error: error.slice(0, 1000),
        durationMs,
      });
      throw new Error(`GitLab API error ${res.status}: ${error}`);
    }

    log.info("Review posted successfully to GitLab", {
      ...ctx,
      commentLength: comment.length,
      durationMs,
      status: res.status,
    });

    return { success: comment };
  },
});
