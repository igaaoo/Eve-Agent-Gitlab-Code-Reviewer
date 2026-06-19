import { defineChannel, POST } from "eve/channels";

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
// ----

const log = logger("gitlab");

// ---- Configuration from environment ----
const TARGET_BRANCH = process.env.REVIEW_TARGET_BRANCH ?? "develop";
const REVIEW_ACTIONS = (process.env.REVIEW_ACTIONS ?? "open")
  .split(",")
  .map((s) => s.trim());
const IGNORE_DRAFT = process.env.REVIEW_IGNORE_DRAFT !== "false";
const IGNORE_AUTHORS = (process.env.REVIEW_IGNORE_AUTHORS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const REVIEW_LANGUAGE = process.env.REVIEW_LANGUAGE ?? "Portuguese";

export default defineChannel({
  routes: [
    POST("/gitlab/codeReview", async (req, { send }) => {
      const reviewId = crypto.randomUUID();
      const startTime = performance.now();

      try {
        const body = await req.json();
        const projectId: number = body.project?.id;
        const mrIid: number = body.object_attributes?.iid;
        const action: string | undefined = body.object_attributes?.action;
        const targetBranch: string | undefined =
          body.object_attributes?.target_branch;
        const title: string | undefined = body.object_attributes?.title;
        const authorName: string = body.user?.name ?? "unknown";
        const ctx = { reviewId, projectId, mrIid };

        log.info("Webhook received", {
          ...ctx,
          object_kind: body.object_kind,
          action,
          target_branch: targetBranch,
          author: authorName,
        });

        // --- Filtering ---
        if (body.object_kind !== "merge_request") {
          log.info("Ignored — not a merge_request event", ctx);
          return new Response("ignored", { status: 200 });
        }

        if (!action || !REVIEW_ACTIONS.includes(action)) {
          log.info(`Ignored — action "${action}" not in REVIEW_ACTIONS`, {
            ...ctx,
            allowed: REVIEW_ACTIONS,
          });
          return new Response("ignored", { status: 200 });
        }

        if (
          targetBranch &&
          TARGET_BRANCH !== "*" &&
          targetBranch !== TARGET_BRANCH
        ) {
          log.info(
            `Ignored — target branch "${targetBranch}" != "${TARGET_BRANCH}"`,
            ctx,
          );
          return new Response("ignored", { status: 200 });
        }

        if (
          IGNORE_DRAFT &&
          (title?.startsWith("WIP:") || title?.startsWith("Draft:"))
        ) {
          log.info("Ignored — draft MR", ctx);
          return new Response("ignored", { status: 200 });
        }

        if (
          IGNORE_AUTHORS.length > 0 &&
          IGNORE_AUTHORS.includes(authorName.toLowerCase())
        ) {
          log.info("Ignored — author in IGNORE_AUTHORS", {
            ...ctx,
            author: authorName,
          });
          return new Response("ignored", { status: 200 });
        }

        const mrTitle: string = title ?? "";
        const mrUrl: string = body.object_attributes?.url ?? "";

        // --- Fetch diff from GitLab ---
        const diffStart = performance.now();
        log.info("Fetching MR diff", ctx);

        const diffRes = await fetch(
          `${process.env.GITLAB_BASE_URL}/api/v4/projects/${projectId}/merge_requests/${mrIid}/changes`,
          { headers: { "PRIVATE-TOKEN": process.env.GITLAB_PRIVATE_TOKEN! } },
        );

        if (!diffRes.ok) {
          const errorBody = await diffRes.text().catch(() => "unknown");
          log.error("Failed to fetch diff from GitLab", {
            ...ctx,
            status: diffRes.status,
            response: errorBody.slice(0, 500),
            durationMs: Math.round(performance.now() - diffStart),
          });
          return new Response("Failed to fetch diff", { status: 500 });
        }

        const diffData = await diffRes.json();
        const changes: Array<{
          old_path: string;
          new_path: string;
          diff: string;
        }> = diffData.changes ?? [];

        const diffSize = JSON.stringify(diffData).length;
        log.info("Diff fetched successfully", {
          ...ctx,
          filesCount: changes.length,
          diffSize,
          durationMs: Math.round(performance.now() - diffStart),
        });

        const diffText = changes
          .filter((c) => c.diff)
          .map((c) => `### ${c.new_path}\n\`\`\`diff\n${c.diff}\n\`\`\``)
          .join("\n\n");

        const message = `Review the following GitLab Merge Request and then post your review using the post_mr_comment tool.

**Title:** ${mrTitle}
**Author:** ${authorName}
**URL:** ${mrUrl}
**Project ID:** ${projectId}
**MR IID:** ${mrIid}
**Feedback Language:** ${REVIEW_LANGUAGE}

## Changed Files

${diffText || "No diff available."}`;

        // --- Send to agent ---
        log.info("Sending message to agent", ctx);

        const session = await send(message, {
          auth: null,
          continuationToken: `${projectId}:${mrIid}`,
        });

        const totalDuration = Math.round(performance.now() - startTime);
        log.info("Message sent to agent successfully", {
          ...ctx,
          sessionId: session.id,
          durationMs: totalDuration,
        });

        return new Response("ok", { status: 200 });
      } catch (err) {
        const totalDuration = Math.round(performance.now() - startTime);
        const message = err instanceof Error ? err.message : "Unknown error";
        const stack = err instanceof Error ? err.stack : undefined;

        log.error("Webhook handler error", {
          reviewId,
          error: message,
          stack: process.env.NODE_ENV === "production" ? undefined : stack,
          durationMs: totalDuration,
        });

        return new Response("Internal Server Error", { status: 500 });
      }
    }),
  ],

  events: {
    "message.completed"(_event, channel) {
      const { projectId, mrIid } = extractMrFromToken(channel);
      log.info("Agent review completed", { projectId, mrIid });
    },

    "session.failed"(event, channel) {
      const { projectId, mrIid } = extractMrFromToken(channel);
      log.error("Agent session failed", {
        projectId,
        mrIid,
        error: typeof event === "string" ? event : JSON.stringify(event),
      });
    },
  },
});

function extractMrFromToken(channel: { readonly continuationToken: string }): {
  projectId?: number;
  mrIid?: number;
} {
  const token = channel.continuationToken ?? "";
  const parts = token.split(":");
  if (parts.length >= 2) {
    return {
      projectId: Number(parts[0]) || undefined,
      mrIid: Number(parts[1]) || undefined,
    };
  }
  return {};
}
