#!/usr/bin/env node
/**
 * Non-interactive headless runner for mscode.
 *
 * Usage:
 *   mscode-run --prompt "Fix the bug in auth.ts"
 *   mscode-run --prompt "Add tests" --timeout 300
 *   mscode-run --prompt "Refactor utils" --format json
 *   echo "task description" | mscode-run
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isStreamDestroyedError } from './error-classification.js';
import { getAppDataDir } from './utils/project.js';
import { releaseAllThreadLocks } from './utils/thread-lock.js';
import { createMastraCode } from './index.js';

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { prompt?: string; timeout?: number; format: 'default' | 'json' } {
  let prompt: string | undefined;
  let timeout: number | undefined;
  let format: 'default' | 'json' = 'default';

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--prompt' || arg === '-p') && argv[i + 1]) {
      prompt = argv[++i];
    } else if (arg === '--timeout' && argv[i + 1]) {
      timeout = parseInt(argv[++i]!, 10);
      if (isNaN(timeout)) {
        process.stderr.write('Error: --timeout must be a number\n');
        process.exit(1);
      }
    } else if (arg === '--format' && argv[i + 1]) {
      const val = argv[++i]!;
      if (val !== 'default' && val !== 'json') {
        process.stderr.write('Error: --format must be "default" or "json"\n');
        process.exit(1);
      }
      format = val;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (!arg!.startsWith('-') && !prompt) {
      // Positional arg as prompt
      prompt = arg;
    }
  }

  return { prompt, timeout, format };
}

function printUsage(): void {
  process.stdout.write(`
Usage: mscode-run [options] [prompt]

Options:
  --prompt, -p <text>   The task to execute (required, or pipe via stdin)
  --timeout <seconds>   Exit with code 2 if not complete within timeout
  --format <type>       Output format: "default" or "json" (default: "default")
  --help, -h            Show this help

Examples:
  mscode-run --prompt "Fix the bug in auth.ts"
  mscode-run --prompt "Add tests" --timeout 300
  mscode-run --prompt "Refactor utils" --format json
  echo "task description" | mscode-run
`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

process.on('uncaughtException', error => {
  if (isStreamDestroyedError(error)) return;
  process.stderr.write(`Fatal: ${error.message}\n`);
  process.exit(1);
});
process.on('unhandledRejection', reason => {
  if (isStreamDestroyedError(reason)) return;
  const msg = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`Fatal: ${msg}\n`);
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv);

  // Read from stdin if no prompt provided and stdin is piped
  let prompt = args.prompt;
  if (!prompt && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    prompt = Buffer.concat(chunks).toString('utf-8').trim();
  }

  if (!prompt) {
    printUsage();
    process.stderr.write('Error: --prompt is required (or pipe via stdin)\n');
    process.exit(1);
  }

  const emit = args.format === 'json'
    ? (data: Record<string, unknown>) => process.stdout.write(JSON.stringify(data) + '\n')
    : null;

  // ── Bootstrap harness ────────────────────────────────────────────────────
  const result = await createMastraCode({
    initialState: { yolo: true },
  });
  // Set module-level refs for cleanup handlers
  harness = result.harness;
  mcpManager = result.mcpManager;

  if (mcpManager?.hasServers()) {
    await mcpManager.init();
  }

  // Redirect console.error/warn to log file (same as main.ts)
  const logFile = path.join(getAppDataDir(), 'debug.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  const fmt = (a: unknown): string => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try { return JSON.stringify(a); } catch { return String(a); }
  };
  console.error = (...a: unknown[]) => logStream.write(`[ERROR] ${new Date().toISOString()} ${a.map(fmt).join(' ')}\n`);
  console.warn = (...a: unknown[]) => logStream.write(`[WARN] ${new Date().toISOString()} ${a.map(fmt).join(' ')}\n`);

  await harness.init();

  // ── Timeout ──────────────────────────────────────────────────────────────
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (args.timeout) {
    timeoutId = setTimeout(() => {
      if (args.format === 'json') {
        emit!({ type: 'timeout', seconds: args.timeout });
      } else {
        process.stderr.write(`\nTimeout: ${args.timeout}s elapsed. Aborting.\n`);
      }
      harness.abort();
      void cleanup().then(() => process.exit(2));
    }, args.timeout * 1000);
  }

  // ── Track last emitted text for delta computation ────────────────────────
  let lastTextLength = 0;

  // ── Subscribe to events ──────────────────────────────────────────────────
  const done = new Promise<number>(resolve => {
    harness.subscribe(event => {
      if (args.format === 'json') {
        emit!({ type: event.type, ...event });
        if (event.type === 'agent_end') {
          resolve(event.reason === 'error' || event.reason === 'aborted' ? 1 : 0);
        }
        return;
      }

      // Default format — human-readable output
      switch (event.type) {
        case 'agent_start':
          lastTextLength = 0;
          break;

        case 'message_update': {
          // Extract text content and print delta
          const textParts = event.message.content.filter(
            (c): c is { type: 'text'; text: string } => c.type === 'text',
          );
          const fullText = textParts.map(p => p.text).join('');
          if (fullText.length > lastTextLength) {
            process.stdout.write(fullText.slice(lastTextLength));
            lastTextLength = fullText.length;
          }
          break;
        }

        case 'message_end':
          lastTextLength = 0;
          process.stdout.write('\n');
          break;

        case 'tool_start':
          process.stderr.write(`[tool] ${event.toolName}\n`);
          break;

        case 'tool_end':
          if (event.isError) {
            process.stderr.write(`[tool error] ${truncate(String(event.result), 200)}\n`);
          }
          break;

        case 'shell_output':
          process.stderr.write(event.output);
          break;

        case 'subagent_start':
          process.stderr.write(`[subagent:${event.agentType}] ${truncate(event.task, 100)}\n`);
          break;

        case 'subagent_end':
          if (event.isError) {
            process.stderr.write(`[subagent error] ${truncate(event.result, 200)}\n`);
          }
          break;

        case 'tool_approval_required':
          // Auto-approve everything in headless mode
          harness.respondToToolApproval({ toolCallId: event.toolCallId, decision: 'approve' });
          process.stderr.write(`[auto-approved] ${event.toolName}\n`);
          break;

        case 'ask_question':
          // Auto-answer questions
          harness.respondToQuestion({
            questionId: event.questionId,
            answer: 'Proceed with your best judgment. Do not ask further questions.',
          });
          process.stderr.write(`[auto-answered] ${truncate(event.question, 100)}\n`);
          break;

        case 'plan_approval_required':
          // Auto-approve plans
          void harness.respondToPlanApproval({
            planId: event.planId,
            response: { action: 'approved' },
          });
          process.stderr.write(`[auto-approved plan] ${event.title}\n`);
          break;

        case 'error':
          process.stderr.write(`[error] ${event.error.message}\n`);
          break;

        case 'agent_end':
          resolve(event.reason === 'error' || event.reason === 'aborted' ? 1 : 0);
          break;
      }
    });
  });

  // ── Send the prompt ──────────────────────────────────────────────────────
  await harness.sendMessage({ content: prompt });

  // ── Wait for completion ──────────────────────────────────────────────────
  const exitCode = await done;
  if (timeoutId) clearTimeout(timeoutId);
  await cleanup();
  process.exit(exitCode);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

let harness: Awaited<ReturnType<typeof createMastraCode>>['harness'] | undefined;
let mcpManager: Awaited<ReturnType<typeof createMastraCode>>['mcpManager'] | undefined;

async function cleanup() {
  releaseAllThreadLocks();
  await Promise.allSettled([mcpManager?.disconnect(), harness?.stopHeartbeats()]);
}

process.on('SIGINT', () => {
  void cleanup().then(() => process.exit(130));
});
process.on('SIGTERM', () => {
  void cleanup().then(() => process.exit(143));
});

main().catch(error => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
