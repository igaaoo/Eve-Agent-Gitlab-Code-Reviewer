import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent } from "eve";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default defineAgent({
  description:
    "Specialist in code style and quality review. Analyzes diffs for naming conventions, code structure, readability, design patterns, and adherence to project conventions.",
  model: openai("gpt-4o-mini"),
});
