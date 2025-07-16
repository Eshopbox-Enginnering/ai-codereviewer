import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import * as github from "@actions/github";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

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

async function getDiff(owner: string, repo: string, pull_number: number): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string when format=diff
  return response.data;
}

function getPositionFromChunk(chunk: Chunk, lineNumber: number): number | null {
  let position = 0;
  for (const change of chunk.changes) {
    if (change.type !== "del") position++;
    // @ts-expect-error - parse-diff type doesn't define ln
    if (change.ln === Number(lineNumber) && change.type === "add") {
      return position;
    }
  }
  return null;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue;

    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        comments.push(
          ...aiResponse.map((r) => ({
            body: r.reviewComment,
            path: file.to || "",
            line: Number(r.lineNumber),
          }))
        );
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  const changesText = chunk.changes
    .map((c) => {
      // @ts-expect-error - ln or ln2 comes from parser
      const line = c.ln ?? c.ln2 ?? "";
      return `${line} ${c.content}`;
    })
    .join("\n");

  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format: {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.

Review the following code diff in the file "${file.to}" and take the pull request title and description into account when writing the response.

Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:
\`\`\`diff
${chunk.content}
${changesText}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{ lineNumber: string; reviewComment: string }> | null> {
  try {
    const response = await openai.chat.completions.create({
      model: OPENAI_API_MODEL,
      temperature: 0.2,
      max_tokens: 700,
      messages: [{ role: "system", content: prompt }],
    });

    const raw = response.choices[0].message?.content?.trim() || "{}";
    const cleaned = raw.replace(/^```json\\s*/i, "").replace(/^```\\s*/i, "").replace(/\\s*```$/, "");
    return JSON.parse(cleaned).reviews;
  } catch (error) {
    console.error("Error parsing AI response:", error);
    return null;
  }
}

async function postInlineComments(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>,
  parsedDiff: File[]
): Promise<string[]> {
  const fallback: string[] = [];

  for (const comment of comments) {
    const file = parsedDiff.find((f) => f.to === comment.path);
    if (!file) continue;

    const chunk = file.chunks.find((chunk) =>
      chunk.changes.some(
        // @ts-expect-error
        (change) => change.ln === comment.line
      )
    );

    if (!chunk) {
      fallback.push(`- [${comment.path} @ ${comment.line}]: ${comment.body}`);
      continue;
    }

    const position = getPositionFromChunk(chunk, comment.line);

    if (position !== null) {
      try {
        await new Promise((r) => setTimeout(r, 300)); // Delay to avoid secondary rate limit
        await octokit.pulls.createReviewComment({
          owner,
          repo,
          pull_number,
          commit_id: github.context.payload.pull_request?.head.sha || "",
          path: comment.path,
          position,
          body: comment.body,
        });
      } catch (e: any) {
        console.warn("❌ Inline comment failed. Falling back. Reason:", e.message);
        fallback.push(`- [${comment.path} @ ${comment.line}]: ${comment.body}`);
      }
    } else {
      fallback.push(`- [${comment.path} @ ${comment.line}]: ${comment.body}`);
    }
  }

  return fallback;
}

async function main() {
  const prDetails = await getPRDetails();
  const eventData = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8"));

  let diff: string | null = null;

  if (eventData.action === "opened") {
    diff = await getDiff(prDetails.owner, prDetails.repo, prDetails.pull_number);
  } else if (eventData.action === "synchronize") {
    const response = await octokit.repos.compareCommits({
      headers: { accept: "application/vnd.github.v3.diff" },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: eventData.before,
      head: eventData.after,
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
  const excludePatterns = core.getInput("exclude").split(",").map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) => minimatch(file.to ?? "", pattern));
  });

  const comments = await analyzeCode(filteredDiff, prDetails);

  console.log("✅ Running updated AI review script...");
  if (comments.length > 0) {
    console.log(`🟡 ${comments.length} AI comments generated.`);
    comments.forEach((c) =>
      console.log(`- ${c.path}#L${c.line}: ${c.body.slice(0, 100)}...`)
    );

    const fallback = await postInlineComments(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments,
      parsedDiff
    );

    if (fallback.length > 0) {
      await octokit.issues.createComment({
        owner: prDetails.owner,
        repo: prDetails.repo,
        issue_number: prDetails.pull_number,
        body: `🟠 **AI Review Summary (Fallback for unmatched lines)**\n\n${fallback.join("\n\n")}`,
      });
    }

    core.setFailed(`${comments.length} AI review issues found.`);
    process.exit(1);
  } else {
    console.log("✅ No issues found by AI.");
  }


}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});