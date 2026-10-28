import type { AiErrorTable } from '../../errors.ts';

/**
 * Claudio's error codes and what Shipcast does about each, the one table of them: the chat
 * completions' (in an OpenAI-shaped `error.code`), the workspaces' and the readiness reasons. The
 * chat codes past `rate_limit_exceeded` are the ones asked of Claudio and not yet confirmed, so a
 * rename on its side is a change here and nowhere else. A code not in the table falls back to its
 * HTTP status (errors.ts).
 */
export const CLAUDIO_ERRORS: AiErrorTable = {
  // The subscription's usage limit: it resets, so the job queue tries again after Retry-After
  rate_limit_exceeded: { code: 'ai_rate_limited', message: 'reached the subscription’s usage limit' },
  // Claude Code stopped before answering: a retry would stop at the same ceiling
  'max-turns': { code: 'ai_no_answer', message: 'used all its turns without answering' },
  'max-budget': { code: 'ai_no_answer', message: 'spent the task’s budget without answering' },
  // A tool outside the declared rules: the request is wrong, not the provider's state
  'tool-blocked': { code: 'ai_refused', message: 'blocked a tool the task did not declare' },
  'cwd-missing': { code: 'ai_refused', message: 'has no folder to work in for this call' },
  // Expired (2 h without use) or released under the run: the next try prepares a new one
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
