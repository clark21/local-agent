import { Injectable } from '@nestjs/common';
import { AgentProvider, RepositoryConfig } from '../config/agent-config.service';
import {
  ApprovalHandler,
  CodexRunResult,
  CodexService,
  CodexThreadSummary,
  ProgressHandler,
} from '../codex/codex.service';
import { ClaudeService } from '../claude/claude.service';

@Injectable()
export class AgentService {
  constructor(
    private readonly codex: CodexService,
    private readonly claude: ClaudeService,
  ) {}

  run(
    provider: AgentProvider,
    repository: RepositoryConfig,
    prompt: string,
    existingThreadId: string | null,
    signal: AbortSignal,
    onProgress: ProgressHandler,
    onApproval: ApprovalHandler,
  ): Promise<CodexRunResult> {
    return provider === 'claude'
      ? this.claude.run(
          repository,
          prompt,
          existingThreadId,
          signal,
          onProgress,
          onApproval,
        )
      : this.codex.run(
          repository,
          prompt,
          existingThreadId,
          signal,
          onProgress,
          onApproval,
        );
  }

  listThreads(
    provider: AgentProvider,
    repository: RepositoryConfig,
    limit = 10,
  ): Promise<CodexThreadSummary[]> {
    return provider === 'claude'
      ? this.claude.listThreads(repository, limit)
      : this.codex.listThreads(repository, limit);
  }
}
