/*
 * Every server function of the pages (`export const x = createServerFn(...)` in
 * apps/web/src/server/*.functions.ts) and what offers the same capability outside the app: the
 * /api/v1 operations that do it, and so their MCP tools (mcp-parity.test.ts), or the reason only the
 * signed-in owner may do it in the app. app-parity.test.ts reads the server functions from their
 * source and fails on one this map leaves out. The rule: docs/decisions/mcp-parity.md
 *
 * One block per area, as the route modules are split (apps/web/src/server/<area>-api.ts): a server
 * function's entry goes at the end of its area's block, so areas worked on at once never touch the
 * same lines.
 */

export type Coverage =
  /** The operationIds of the routes that do what the server function does */
  | { api: readonly string[] }
  /** Why no API client may do it: a credential, the instance's own set-up, or the page's view state */
  | { appOnly: string };

const ONBOARDING = 'the first-run guide of the app (docs/decisions/onboarding.md)';
const ASSISTANT =
  'the in-app writing assistant’s own chat (docs/decisions/writing-assistant.md), an AI client of the editor itself: an MCP client is an assistant of its own, and edits a draft through the drafts routes';

export const SERVER_FUNCTIONS: Readonly<Record<string, Coverage>> = {
  // launches (api.ts): the list, one launch, making one, approving it, deleting it
  listLaunches: { api: ['listLaunches'] },
  getLaunch: { api: ['getLaunch'] },
  getDeletion: { api: ['planLaunchDeletion'] },
  deleteLaunch: { api: ['deleteLaunch'] },
  approveDrafts: { api: ['approveLaunch'] },
  launchRepo: { api: ['launchRepo'] },
  writeArticle: { api: ['writeArticle'] },
  launchFromSources: { api: ['launchFromSources'] },

  // drafts (drafts-api.ts): edited, previewed on the site, a whole launch published again
  // The page edits what getLaunch gave it; an API client reads the one draft first
  saveDraft: { api: ['getDraft', 'editDraft'] },
  previewOnSite: { api: ['requestSitePreview'] },
  findSitePreview: { api: ['getSitePreview'] },
  // With a channel it is retryChannel's; without, the whole launch's pending pieces
  publishAgain: { api: ['retryChannel', 'publishLaunchAgain'] },

  // repos (repos-api.ts): the repos and releases to launch from, the pre-flight alone
  listRepos: { api: ['listRepos'] },
  listReleases: { api: ['listReleases'] },
  checkRepo: { api: ['checkRepo'] },

  // posts and their times (api.ts)
  editPiece: { api: ['editPost'] },
  deletePiece: { api: ['deletePost'] },
  editPieces: { api: ['editLaunchPosts'] },
  deleteAllPieces: { api: ['deleteLaunchPosts'] },
  schedulePiece: { api: ['scheduleLaunch'] },
  moveSchedule: { api: ['reschedulePost'] },
  cancelSchedule: { api: ['cancelScheduledPost'] },
  recommendedTimes: { api: ['recommendTimes'] },

  // comments (api.ts)
  listComments: { api: ['listComments', 'getCommentSettings'] },
  checkCommentsNow: { api: ['checkComments'] },
  redraftReply: { api: ['redraftComment'] },
  saveReply: { api: ['editReply'] },
  approveReply: { api: ['approveReply'] },
  dismissReply: { api: ['dismissComment'] },
  saveCommentSettings: { api: ['setCommentSettings'] },

  // stats (stats-api.ts)
  getStats: { api: ['statsOverview', 'statsSeries', 'statsRanking'] },
  getGrowth: { api: ['statsAccounts'] },
  getSearch: { api: ['statsSearch'] },

  // accounts and their profiles (api.ts, accounts-api.ts, profile-api.ts)
  getChannels: { api: ['listAccounts', 'statsAccounts'] },
  connectWithForm: { appOnly: 'connects an account: its credentials go into the keychain, and a credential never comes through the API' },
  disconnect: { appOnly: 'disconnects an account and deletes its credentials from the keychain: connecting and disconnecting are the app’s, like the credentials themselves' },
  importEnv: { appOnly: 'copies the credentials found in the .env of the machine the app runs on into the keychain, as connected accounts' },
  getProfileReview: { api: ['getProfileReview'] },
  reviewProfileNow: { api: ['reviewProfile'] },
  profileReviewJob: { api: ['listJobs'] },
  recheckAccount: { api: ['checkAccount'] },
  syncAccountNow: { api: ['syncAccount', 'listJobs'] },
  renameAccount: { api: ['renameAccount'] },
  makePrimary: { api: ['makePrimaryAccount'] },
  applyProfileProposal: { api: ['applyProfileProposal'] },
  applyBrandPictureNow: { api: ['applyBrandPicture'] },

  // attention (attention-api.ts): the bell's list and its dismissals
  getAttention: { api: ['listAttention'] },
  dismissAttention: { api: ['dismissAttention'] },
  clearAttention: { api: ['dismissAttention'] },

  // automation (automation-api.ts): how releases are heard of, the trigger rules, a round now, the work list
  getJobsPage: { api: ['listJobs'] },
  rotateWebhookSecret: { appOnly: 'makes a new GitHub webhook secret and answers it once, to paste into GitHub: a secret never leaves the server through the API' },
  getAutomation: { api: ['getAutomation'] },
  saveAutomation: { api: ['setAutomation'] },
  saveTriggers: { api: ['setTriggers'] },
  runRoundNow: { api: ['runRound'] },

  // ai (ai-api.ts): each task's provider, model and budget, the prompts
  saveClaudio: { appOnly: 'saves claudio’s address with its token, which goes into the keychain: a credential never comes through the API' },
  getAiSettings: { api: ['getAiSettings', 'listAiPrompts', 'listLaunches'] },
  saveAiSettings: { api: ['setAiSettings'] },
  saveAiPrompt: { api: ['saveAiPrompt'] },
  restoreAiPrompt: { api: ['restoreAiPrompt'] },
  previewAiPrompt: { api: ['previewAiPrompt'] },
  useProviderForAll: { api: ['useAiProviderForAll'] },
  testProvider: { api: ['testAiProvider'] },

  // the writing assistant's chat
  listAssistantSessions: { appOnly: `the past sessions of ${ASSISTANT}` },
  loadAssistantSession: { appOnly: `one session of ${ASSISTANT}` },
  settleAssistantProposal: { appOnly: `a proposal of ${ASSISTANT} marked accepted or rejected: the diff’s state in the chat, the text itself saved with the draft` },
  assistantCheckJob: { appOnly: `the result of the “check against the code” of ${ASSISTANT}, started by its streaming endpoint` },

  // signing in, the instance's settings, the API's own ways in
  whoAmI: { appOnly: 'the signed-in session’s login and picture for the shell: the API takes a token, which has no session' },
  getSettings: {
    appOnly: 'the instance’s own configuration: which secrets are set and where every setting comes from, the GitHub App’s installation and the owner’s GitHub token; set up by the signed-in owner, never read with a token',
  },
  saveSettings: { appOnly: 'writes the instance’s settings, secrets among them (they go into the keychain) and the launches repo and addresses the whole process runs on' },
  listTokens: { appOnly: 'the API tokens are listed, made and revoked by the signed-in owner alone (docs/decisions/api-tokens.md): a token never sees the others' },
  createToken: { appOnly: 'makes an API token and shows it once: a token never mints another (docs/decisions/api-tokens.md)' },
  revokeToken: { appOnly: 'revokes an API token: tokens are managed in the app alone, so a leaked one cannot revoke the owner’s others (docs/decisions/api-tokens.md)' },
  getWebMcp: { appOnly: 'whether WebMCP is on, which lets the owner’s session cookie into the API (docs/decisions/mcp.md): the owner’s choice, in the app' },
  setWebMcp: { appOnly: 'turns WebMCP on or off, which decides whether the API takes the owner’s session cookie (docs/decisions/mcp.md): a token must not widen the API’s own ways in' },
  getBanner: { appOnly: 'the banner the owner closed, read from the request’s cookie: the page’s view state' },

  // onboarding and the tour
  getOnboardingState: { appOnly: `the state of ${ONBOARDING}, for the shell` },
  getOnboarding: { appOnly: `what the steps of ${ONBOARDING} show: what is configured, each part of it read through its own area` },
  markStep: { appOnly: `a step of ${ONBOARDING} marked done or skipped` },
  finishOnboarding: { appOnly: `${ONBOARDING}, finished` },
  setOnboardingAside: { appOnly: `${ONBOARDING}, set aside for later` },
  answerTourOffer: { appOnly: 'the answer to the offer of the app’s guided tour of its pages, which runs in the browser' },
  listLaunchRepos: { appOnly: `the repos the launches repo is chosen from, for the first step of ${ONBOARDING} (a launch's repos are the repos area's)` },
  chooseLaunchesRepo: { appOnly: `sets the launches repo, which the whole instance writes to, in ${ONBOARDING}: a setting, like saveSettings` },
  proposeBrand: { appOnly: `the first brand.yml checked before it is committed, in ${ONBOARDING}` },
  createBrand: { appOnly: `commits a first brand.yml to a launches repo that has none, in ${ONBOARDING}; afterwards the brand is a file edited on GitHub` },
};
