import Anthropic from '@anthropic-ai/sdk';
import { AIProvider, AIProviderConfig, ReviewRequest, ReviewResponse } from './AIProvider';
import * as core from '@actions/core';
import { baseCodeReviewPrompt } from '../prompts';
import { TextBlock } from '@anthropic-ai/sdk/resources';

export class AnthropicProvider implements AIProvider {
  private config!: AIProviderConfig;
  private client!: Anthropic;

  async initialize(config: AIProviderConfig): Promise<void> {
    this.config = config;
    this.client = new Anthropic({
      apiKey: config.apiKey
    });
  }

  async review(request: ReviewRequest): Promise<ReviewResponse> {
    const prompt = this.buildPrompt(request);
    core.info(`Sending request to Anthropic with prompt structure: ${JSON.stringify(request, null, 2)}`);

    const response = await this.client.messages.create({
      model: this.config.model,
      max_tokens: 4000,
      system: baseCodeReviewPrompt,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
        {
          role: 'user',
          content: 'Return the response in JSON format only, no other text or comments.',
        },
      ],
      temperature: this.config.temperature ?? 0.3,
    });

    core.info(`Raw Anthropic response: ${JSON.stringify((response.content[0] as TextBlock).text, null, 2)}`);

    const parsedResponse = this.parseResponse(response);
    core.info(`Parsed response: ${JSON.stringify(parsedResponse, null, 2)}`);

    return parsedResponse;
  }

  private buildPrompt(request: ReviewRequest): string {
    return JSON.stringify({
      type: 'code_review',
      files: request.files,
      pr: request.pullRequest,
      context: request.context,
    });
  }

  private parseResponse(response: Anthropic.Message): ReviewResponse {
    try {
      const content = JSON.parse((response.content[0] as TextBlock).text);
      return {
        summary: content.summary,
        lineComments: content.comments,
        suggestedAction: content.suggestedAction,
        confidence: content.confidence,
      };
    } catch (error) {
      core.error(`Failed to parse Anthropic response: ${error}`);
      return {
        summary: 'Failed to parse AI response',
        lineComments: [],
        suggestedAction: 'COMMENT',
        confidence: 0,
      };
    }
  }
}
