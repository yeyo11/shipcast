import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readReview, type Launch, type ReviewGitHub } from '../src/index.ts';

test("a pull request's drafts are read at once, and listed in their order", async () => {
  const D = 'launches/claudio/v0.9.0';
  let open = 0;
  let most = 0;
  const github: ReviewGitHub = {
    pullRequest: async () => ({ number: 7, url: 'https://github.com/yeyo11/launches/pull/7', state: 'open', branch: 'launch/claudio-v0.9.0', title: 't' }),
    pullRequestFiles: async () => [`${D}/threads.md`, `${D}/bluesky.md`, 'src/content/posts/en/claudio.md', `public/${D}/og.jpg`, `${D}/mastodon.md`],
    fileAt: async (_repo, path) => {
      open++;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 20));
      open--;
      return `# ${path}`;
    },
    updateFile: async () => {},
    mergePullRequest: async () => ({ sha: 'x' }),
  };
  const launch = { id: 1, repo: 'yeyo11/claudio', ref: 'v0.9.0', detail: 'https://github.com/yeyo11/launches/pull/7' } as Launch;
  const review = await readReview(launch, { github, launchesRepo: 'yeyo11/launches' });
  assert.equal(most, 4, 'the four texts are read together, not one after the other');
  assert.deepEqual(
    review?.drafts.map((d) => d.path),
    ['src/content/posts/en/claudio.md', `${D}/bluesky.md`, `${D}/mastodon.md`, `${D}/threads.md`, `public/${D}/og.jpg`],
  );
  assert.equal(review?.drafts[1]?.content, `# ${D}/bluesky.md`);
});
