import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent } from "eve";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default defineAgent({
  description:
    "Specialist in performance code review. Analyzes diffs for N+1 queries, memory leaks, expensive loops, blocking operations, and inefficient algorithms.",
  model: openai("gpt-4o-mini"),
});
