/*
 * The API operations that do not have an MCP tool yet, while the MCP server catches up with /api/v1.
 * mcp-parity.test.ts lets these through, and fails once one of them is covered, so the entry goes in
 * the same change as its tool.
 *
 * One block per area, each under its comment and apart from the next by a blank line. An area removes
 * its own block (its comment and its operations) and leaves the blank lines, so parallel changes never
 * touch the same or neighbouring lines. Nothing new goes here: a new operation gets its tool, or an
 * entry in EXCLUDED with the reason it has none.
 */

export const PENDING: readonly string[] = [

  // schedule: packages/mcp/src/tools/schedule.ts
  'scheduleLaunch',
  'reschedulePost',
  'cancelScheduledPost',
  'recommendTimes',
  'getTimezone',
  'setTimezone',

  // comments: packages/mcp/src/tools/comments.ts
  'listComments',
  'checkComments',
  'redraftComment',
  'editReply',
  'approveReply',
  'dismissComment',
  'getCommentSettings',
  'setCommentSettings',

  // profiles: packages/mcp/src/tools/profiles.ts
  'listProfileCapabilities',
  'getProfileReview',
  'reviewProfile',
  'editProfile',

  // sources: packages/mcp/src/tools/sources.ts
  'launchFromSources',
  'uploadMedia',
  'editLaunchPosts',
  'deleteLaunchPosts',
  'planLaunchDeletion',
  'deleteLaunch',

];
