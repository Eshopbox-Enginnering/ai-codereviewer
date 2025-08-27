        const customInstructions = core.getInput('CUSTOM_INSTRUCTIONS');
            contextFiles,
            customInstructions
      ${request.context.customInstructions || ''}
      ${request.context.customInstructions || ''}
      ${request.context.customInstructions || ''}
                    body: `[AI] ${comment.comment}`
    async hasReviewForCommit(prNumber, commit) {
        const { data: reviews } = await this.octokit.pulls.listReviews({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
        });
        return reviews.some(r => { var _a; return ((_a = r.user) === null || _a === void 0 ? void 0 : _a.login) === 'github-actions[bot]' && r.commit_id === commit; });
    }
    async addLabel(prNumber, label) {
        try {
            await this.octokit.issues.addLabels({
                owner: this.owner,
                repo: this.repo,
                issue_number: prNumber,
                labels: [label]
            });
        }
        catch (err) {
            core.warning(`Failed to add label ${label}: ${err}`);
        }
    }
            contextFiles: config.contextFiles || ['package.json', 'README.md'],
            customInstructions: config.customInstructions
        if (await this.githubService.hasReviewForCommit(prNumber, prDetails.head)) {
            core.info('Skipping review - commit already reviewed');
            return {
                summary: 'Commit already reviewed',
                lineComments: [],
                suggestedAction: 'COMMENT',
                confidence: 1
            };
        }
        const MAX_CHARS = 15000;
        const chunks = [];
        let current = [];
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
        if (current.length > 0)
            chunks.push(current);
        let combinedSummary = '';
        let allComments = [];
        let action = 'COMMENT';
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
                    repository: (_a = process.env.GITHUB_REPOSITORY) !== null && _a !== void 0 ? _a : '',
                    owner: (_b = process.env.GITHUB_REPOSITORY_OWNER) !== null && _b !== void 0 ? _b : '',
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
            }
            else if (res.suggestedAction === 'APPROVE' && action !== 'REQUEST_CHANGES') {
                action = 'APPROVE';
            }
        }
        const review = {
            summary: combinedSummary.trim(),
            lineComments: allComments,
            suggestedAction: action,
            confidence: 1,
        };
        await this.githubService.addLabel(prNumber, 'ai-reviewed');
