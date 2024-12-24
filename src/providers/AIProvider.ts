export interface AIProviderConfig {
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ReviewRequest {
  files: Array<{
    path: string;
    content: string;
    originalContent?: string;
    diff?: string;
  }>;
  contextFiles?: Array<{
    path: string;
    content: string;
  }>;
  pullRequest: {
    title: string;
    description: string;
    base: string;
    head: string;
  };
  context: {
    repository: string;
    owner: string;
    projectContext?: string;
  };
}

export interface ReviewResponse {
  summary: string;
  lineComments?: Array<{
    path: string;
    line: number;
    comment: string;
  }>;
  suggestedAction: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  confidence: number;
}

export interface AIProvider {
  initialize(config: AIProviderConfig): Promise<void>;
  review(request: ReviewRequest): Promise<ReviewResponse>;
}
