import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent } from "eve";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default defineAgent({
  description:
    "Specialist in security code review. Analyzes diffs for vulnerabilities, injection flaws, auth issues, exposed secrets, and data leaks.",
  model: openai("gpt-4o-mini"),
});
