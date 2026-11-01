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





];
