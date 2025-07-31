import { AIProvider } from '../providers/AIProvider';
import { GitHubService } from '../services/GitHubService';
import { DiffService } from '../services/DiffService';
import { ReviewResponse } from '../providers/AIProvider';
import * as core from '@actions/core';

export interface ReviewServiceConfig {
  maxComments: number;
  approveReviews: boolean;
  projectContext?: string;
  contextFiles?: string[];
  customInstructions?: string;
}

export class ReviewService {
  private config: ReviewServiceConfig;

  constructor(
    private aiProvider: AIProvider,
    private githubService: GitHubService,
    private diffService: DiffService,
    config: ReviewServiceConfig
  ) {
    this.config = {
      maxComments: config.maxComments || 0,
      approveReviews: config.approveReviews,
      projectContext: config.projectContext,
      contextFiles: config.contextFiles || ['package.json', 'README.md'],
      customInstructions: config.customInstructions
    };
  }

  async performReview(prNumber: number): Promise<ReviewResponse> {
    core.info(`Starting review for PR #${prNumber}`);

    // Get PR details
    const prDetails = await this.githubService.getPRDetails(prNumber);
    core.info(`PR title: ${prDetails.title}`);

    if (await this.githubService.hasReviewForCommit(prNumber, prDetails.head)) {
      core.info('Skipping review - commit already reviewed');
      return {
        summary: 'Commit already reviewed',
        lineComments: [],
        suggestedAction: 'COMMENT',
        confidence: 1
      };
    }

    // Get modified files from diff
    const lastReviewedCommit = await this.githubService.getLastReviewedCommit(prNumber);
    const isUpdate = !!lastReviewedCommit;

    // If this is an update, get previous reviews
    let previousReviews;
    if (isUpdate) {
      previousReviews = await this.githubService.getPreviousReviews(prNumber);
      core.debug(`Found ${previousReviews.length} previous reviews`);
    }

    const modifiedFiles = await this.diffService.getRelevantFiles(prDetails, lastReviewedCommit);
    core.info(`Modified files length: ${modifiedFiles.length}`);

    // Get full content for each modified file
    const filesWithContent = await Promise.all(
      modifiedFiles.map(async (file) => {
        const fullContent = await this.githubService.getFileContent(file.path, prDetails.head);
        return {
          path: file.path,
          content: fullContent,
          originalContent: await this.githubService.getFileContent(file.path, prDetails.base),
          diff: file.diff,
        };
      })
    );

    // Get repository context (now using configured files)
    const contextFiles = await this.getRepositoryContext();

    const MAX_CHARS = 15000;
    const chunks: typeof filesWithContent[] = [];
    let current: typeof filesWithContent = [];
    let len = 0;
    for (const file of filesWithContent) {
      const size = JSON.stringify(file).length;
      if (len + size > MAX_CHARS && current.length > 0) {
        chunks.push(current);
        current = [];
        len = 0;
      }
      current.push(file);
      len += size;
    }
    if (current.length > 0) chunks.push(current);

    let combinedSummary = '';
    let allComments: ReviewResponse['lineComments'] = [];
    let action: ReviewResponse['suggestedAction'] = 'COMMENT';

    for (const chunk of chunks) {
      const res = await this.aiProvider.review({
        files: chunk,
        contextFiles,
        previousReviews,
        pullRequest: {
          title: prDetails.title,
          description: prDetails.description,
          base: prDetails.base,
          head: prDetails.head,
        },
        context: {
          repository: process.env.GITHUB_REPOSITORY ?? '',
          owner: process.env.GITHUB_REPOSITORY_OWNER ?? '',
          projectContext: this.config.projectContext,
          isUpdate,
          customInstructions: this.config.customInstructions,
        },
      });

      combinedSummary += `${res.summary}\n\n`;
      if (res.lineComments) {
        allComments = [...(allComments || []), ...res.lineComments];
      }
      if (res.suggestedAction === 'REQUEST_CHANGES') {
        action = 'REQUEST_CHANGES';
      } else if (res.suggestedAction === 'APPROVE' && action !== 'REQUEST_CHANGES') {
        action = 'APPROVE';
      }
    }

    const review: ReviewResponse = {
      summary: combinedSummary.trim(),
      lineComments: allComments,
      suggestedAction: action,
      confidence: 1,
    };

    // Add model name to summary
    const modelInfo = `_Code review performed by \`${process.env.INPUT_AI_PROVIDER?.toUpperCase() || 'AI'} - ${process.env.INPUT_AI_MODEL}\`._`;
    review.summary = `${review.summary}\n\n------\n\n${modelInfo}`;

    // Submit review
    await this.githubService.submitReview(prNumber, {
      ...review,
      lineComments: this.config.maxComments > 0 ? review.lineComments?.slice(0, this.config.maxComments) : review.lineComments,
      suggestedAction: this.normalizeReviewEvent(review.suggestedAction),
    });

    await this.githubService.addLabel(prNumber, 'ai-reviewed');

    return review;
  }

  private async getRepositoryContext(): Promise<Array<{path: string, content: string}>> {
    const results = [];

    for (const file of (this.config.contextFiles || [])) {
      try {
        const content = await this.githubService.getFileContent(file);
        if (content) {
          results.push({ path: file, content });
        }
      } catch (error) {
        // File might not exist, skip it
      }
    }

    return results;
  }

  private normalizeReviewEvent(action: string): 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' {
    if (!action || !this.config.approveReviews) {
      return 'COMMENT';
    }

    const eventMap: Record<string, 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'> = {
      'approve': 'APPROVE',
      'request_changes': 'REQUEST_CHANGES',
      'comment': 'COMMENT',
    };

    return eventMap[action.toLowerCase()] || 'COMMENT';
  }
}
