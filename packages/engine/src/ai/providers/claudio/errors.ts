import type { AiErrorTable } from '../../errors.ts';

/**
 * Claudio's error codes and what Shipcast does about each, the one table of them: the chat
 * completions' (snake_case, in an OpenAI-shaped `error.code`, as the HTTP answer or as the last
 * chunk of a stream), the workspaces' REST codes (kebab-case) and the readiness reasons. A code not
 * in the table falls back to its HTTP status (errors.ts).
 */
export const CLAUDIO_ERRORS: AiErrorTable = {
  // The subscription's usage limit or Claudio's spend cap: it resets, so the job queue tries again after Retry-After
  rate_limit_exceeded: { code: 'ai_rate_limited', message: 'reached the subscription’s usage limit' },
  // Claude Code stopped before answering (422): a retry would stop at the same ceiling
  max_turns: { code: 'ai_no_answer', message: 'used all its turns without answering' },
  max_budget: { code: 'ai_no_answer', message: 'spent the task’s budget without answering' },
  no_structured_output: { code: 'ai_invalid_output', message: 'ended without an answer in the response format' },
  // A tool outside the declared rules (422; the message names the subcommand or path and the missing rule): the request is wrong
  tool_blocked: { code: 'ai_refused', message: 'blocked a tool the task did not declare' },
  cwd_missing: { code: 'ai_refused', message: 'has no folder to work in for this call' },
  // A chat continued with another workspace, tools or ceilings than it started with
  policy_mismatch: { code: 'ai_refused', message: 'refused to continue a chat under another policy' },
  // Gone (404) or expired (410, 2 h without use) under the run: the next try prepares a new one
  workspace_not_found: { code: 'ai_unavailable', message: 'no longer has the workspace' },
  workspace_expired: { code: 'ai_unavailable', message: 'let the workspace expire' },
  // The workspaces' REST API
  'workspace-not-found': { code: 'ai_unavailable', message: 'no longer has the workspace' },
  'workspace-host-not-allowed': { code: 'ai_refused', message: 'may not download from this host: add it to CLAUDIO_WORKSPACE_HOSTS' },
  'workspace-address-blocked': { code: 'ai_refused', message: 'refused to download from a private address' },
  'workspace-too-large': { code: 'ai_refused', message: 'refused the repository: it is over the workspace’s size caps' },
  'workspace-bad-archive': { code: 'ai_refused', message: 'could not read the repository’s archive' },
  // 20 live workspaces: one frees up when another run ends
  'workspace-limit': { code: 'ai_rate_limited', message: 'has as many workspaces as it holds' },
  // Readiness (/api/ready): only the owner signs Claude Code in; a starting Claudio is a moment away
  'cli-missing': { code: 'ai_not_connected', message: 'has no Claude Code installed' },
  'signed-out': { code: 'ai_not_connected', message: 'is not signed in to Claude: sign in on Claudio' },
  'sign-in-expired': { code: 'ai_not_connected', message: 'has an expired Claude sign-in: sign in again on Claudio' },
  starting: { code: 'ai_unavailable', message: 'is still starting' },
};
