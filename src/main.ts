import { readFileSync } from "fs";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import OpenAI from "openai";

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
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8"));
  const { repository, number } = event;
  const pr = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });

  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: pr.data.title ?? "",
    description: pr.data.body ?? "",
  };
}

function getPositionFromChunk(chunk: Chunk, lineNumber: number): number | null {
  let position = 0;
  for (const change of chunk.changes) {
    const line = (change as any).ln;
    if (change.type !== "del") position++;
    if (line === Number(lineNumber) && change.type === "add") {
      return position;
    }
  }
  return null;
}

function createPrompt(file: File, chunk: Chunk, pr: PRDetails): string {
  const changes = chunk.changes
    .map((c: any) => `${c.ln ?? c.ln2} ${c.content}`)
    .join("\n");

  return `Your task is to review pull requests. Instructions:
- Provide the response in this JSON format: {"reviews":[{"lineNumber": <line_number>, "reviewComment": "<review comment>"}]}
- Only suggest actual improvements. No compliments or general comments.
- Respond in GitHub Markdown.
- Focus on the code only. Do not suggest adding code comments.

Pull request title: ${pr.title}
Pull request description:
---
${pr.description}
---

File: ${file.to}
\`\`\`diff
${chunk.content}
${changes}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<{ lineNumber: string, reviewComment: string }[] | null> {
  const model = OPENAI_API_MODEL;
  try {
    const response = await openai.chat.completions.create({
      model,
      temperature: 0.2,
      max_tokens: 700,
      top_p: 1,
      messages: [{ role: "system", content: prompt }],
      ...(model === "gpt-4-1106-preview" && { response_format: { type: "json_object" } }),
    });

    const content = response.choices[0].message?.content ?? "{}";
    return JSON.parse(content).reviews ?? [];
  } catch (err) {
    console.error("🛑 AI error:", err);
    return null;
  }
}

function createComments(file: File, chunk: Chunk, aiResponses: { lineNumber: string; reviewComment: string }[]) {
  return aiResponses.map((resp) => ({
    body: resp.reviewComment,
    path: file.to!,
    line: Number(resp.lineNumber),
  }));
}

async function analyzeDiff(parsedDiff: File[], pr: PRDetails) {
  const comments: { body: string; path: string; line: number }[] = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue;
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, pr);
      const aiReviews = await getAIResponse(prompt);
      if (aiReviews) {
        comments.push(...createComments(file, chunk, aiReviews));
      }
    }
  }
  return comments;
}

async function postInlineComments(
  pr: PRDetails,
  comments: { body: string; path: string; line: number }[],
  parsedDiff: File[]
): Promise<string[]> {
  const fallback: string[] = [];

  for (const comment of comments) {
    const file = parsedDiff.find(f => f.to === comment.path);
    if (!file) continue;

    const chunk = file.chunks.find(chunk =>
      chunk.changes.some(c => (c as any).ln === comment.line)
    );
    if (!chunk) {
      fallback.push(`- [${comment.path} @ ${comment.line}]: ${comment.body}`);
      continue;
    }

    const position = getPositionFromChunk(chunk, comment.line);
    if (position !== null) {
      try {
        const pullRequest = github.context.payload.pull_request;
        if (!pullRequest) {
          throw new Error("❌ pull_request is undefined in GitHub context. Make sure this Action runs on a pull_request event.");
        }
        await octokit.pulls.createReviewComment({
          owner: pr.owner,
          repo: pr.repo,
          pull_number: pr.pull_number,
          commit_id: pullRequest.head.sha,
          path: comment.path,
          position,
          body: comment.body,
        });
      } catch (err: any) {
        console.warn(`⚠️ Inline comment failed. Reason: ${err.message}`);
        fallback.push(`- [${comment.path} @ ${comment.line}]: ${comment.body}`);
      }
    } else {
      fallback.push(`- [${comment.path} @ ${comment.line}]: ${comment.body}`);
    }
  }

  return fallback;
}

async function main() {
  const pr = await getPRDetails();
  const eventData = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));

  let diff: string | null;
  if (eventData.action === "opened") {
    diff = await getDiff(pr.owner, pr.repo, pr.pull_number);
  } else if (eventData.action === "synchronize") {
    const { before, after } = eventData;
    const result = await octokit.repos.compareCommits({
      headers: { accept: "application/vnd.github.v3.diff" },
      owner: pr.owner,
      repo: pr.repo,
      base: before,
      head: after,
    });
    diff = String(result.data);
  } else {
    console.log("⏭️ Unsupported event:", eventData.action);
    return;
  }

  if (!diff) {
    console.log("⚠️ No diff found.");
    return;
  }

  const parsedDiff = parseDiff(diff);
  const exclude = core.getInput("exclude").split(",").map((s) => s.trim());
  const filtered = parsedDiff.filter(file => !exclude.some(pattern => minimatch(file.to ?? "", pattern)));

  const comments = await analyzeDiff(filtered, pr);

  if (comments.length === 0) {
    console.log("✅ No AI suggestions.");
    return;
  }

  console.log(`📝 ${comments.length} AI comments generated.`);
  comments.forEach(c => console.log(`- ${c.path}#L${c.line}: ${c.body.slice(0, 80)}...`));

  const fallback = await postInlineComments(pr, comments, parsedDiff);

  if (fallback.length > 0) {
    await octokit.issues.createComment({
      owner: pr.owner,
      repo: pr.repo,
      issue_number: pr.pull_number,
      body: `🟠 **AI Review Summary (Fallback)**:\n\n${fallback.join("\n\n")}`,
    });
  }

  core.setFailed(`${comments.length} AI review issues found.`);
  process.exit(1);
}

async function getDiff(owner: string, repo: string, pull_number: number): Promise<string | null> {
  const result = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return result.data;
}

main().catch((err) => {
  console.error("❌ Error in AI reviewer:", err);
  process.exit(1);
});
