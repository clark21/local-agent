import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentConfigService } from './config/agent-config.service';
import { DatabaseService } from './database/database.service';
import { CodexService } from './codex/codex.service';
import { TaskService } from './tasks/task.service';
import { TelegramService } from './telegram/telegram.service';
import { ClaudeService } from './claude/claude.service';
import { AgentService } from './agent/agent.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  providers: [
    AgentConfigService,
    DatabaseService,
    CodexService,
    ClaudeService,
    AgentService,
    TaskService,
    TelegramService,
  ],
})
export class AppModule {}
