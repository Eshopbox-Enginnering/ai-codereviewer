import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; position: number }>> {
  const comments: Array<{ body: string; path: string; position: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue;
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  try {
    const response = await openai.chat.completions.create({
      model: OPENAI_API_MODEL,
      temperature: 0.2,
      max_tokens: 700,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
      ...(OPENAI_API_MODEL === "gpt-4-1106-preview" || OPENAI_API_MODEL === "gpt-4o"
        ? { response_format: "json" as any }
        : {}),
    });

    let res = response.choices[0].message?.content?.trim() || "{}";
    res = res.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

    const parsed = JSON.parse(res);
    return parsed.reviews ?? [];
  } catch (error) {
    console.error("❌ Error parsing AI response:", error);
    return null;
  }
}

// function createComment(
//   file: File,
//   chunk: Chunk,
//   aiResponses: Array<{
//     lineNumber: string;
//     reviewComment: string;
//   }>
// ): Array<{ body: string; path: string; line: number }> {
//   return aiResponses.flatMap((aiResponse) => {
//     if (!file.to) return [];
//     return {
//       body: aiResponse.reviewComment,
//       path: file.to,
//       line: Number(aiResponse.lineNumber),
//     };
//   });
// }

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; position: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) return [];

    const targetLine = Number(aiResponse.lineNumber);

    // Cast to 'any' to bypass TS complaints
    const change = (chunk.changes as any[]).find((c) => {
      return c.ln === targetLine || c.ln2 === targetLine;
    });

    if (!change || change.type === "del" || change.position === undefined) {
      console.warn(
        `⚠️ Skipping comment: no matching diff line or position found for line ${targetLine} in ${file.to}`
      );
      return [];
    }

    return {
      body: aiResponse.reviewComment,
      path: file.to,
      position: change.position,
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; position: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);

  console.log("✅ Running updated AI review script...");
  if (comments.length > 0) {
    console.log(`🟡 ${comments.length} AI comments added to PR.`);
    console.log("AI comments to be posted:");
    comments.forEach((c) =>
      console.log(`- ${c.path}#L${c.position}: ${c.body.slice(0, 100)}...`)
    );

    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );

    core.setFailed(`${comments.length} AI review issues found.`);
    throw new Error("❌ PR check failed due to AI code review comments.");
  } else {
    console.log("✅ No issues found by AI.");
  }
}

main().catch((error) => {
  console.error("❌ Fatal error in main():", error);
  core.setFailed(error.message || "Unexpected error");
});