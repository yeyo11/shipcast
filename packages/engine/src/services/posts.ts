import { deleteLaunchPosts, deletePost, editPost, editPosts, PostRefused, type EditDeps, type PostChanges, type PostOutcome, type PostSelection } from '../edit.ts';
import type { LaunchLookup } from '../ports.ts';
import type { Post } from '../registry.ts';

/**
 * Editing and deleting what a launch published, the one way the launch page, the REST API and the
 * MCP (through the API) do it (docs/decisions/edit-delete.md). The rules are edit.ts's; this is the
 * use case around them, so no entry point re-implements one. Its ports: the launches, to confirm a
 * whole launch's delete by its repo, and what editing needs, built per call because each piece's
 * connectors are those of the account it went out with.
 */
export class PostService {
  readonly #launches: LaunchLookup;
  readonly #editing: () => Promise<EditDeps>;

  constructor(deps: { launches: LaunchLookup; editing: () => Promise<EditDeps> }) {
    this.#launches = deps.launches;
    this.#editing = deps.editing;
  }

  /** One piece; a field its network cannot change is refused before anything is sent */
  async edit(postId: number, changes: PostChanges): Promise<Post> {
    return editPost(postId, changes, await this.#editing());
  }

  async delete(postId: number): Promise<Post> {
    return deletePost(postId, await this.#editing());
  }

  /** The same change to several pieces, each network taking what it has; see PostSelection for which */
  async editMany(launchId: number, changes: PostChanges, selection: PostSelection): Promise<PostOutcome[]> {
    return editPosts(launchId, changes, selection, await this.#editing());
  }

  /** Deletes the pieces selected, reporting what cannot be deleted */
  async deleteMany(launchId: number, selection: PostSelection): Promise<PostOutcome[]> {
    return deleteLaunchPosts(launchId, selection, await this.#editing());
  }

  /**
   * Deletes everything a launch has out, once the owner confirmed it by typing the repo's name: a
   * whole launch's posts are too much to take back on a slip of the mouse.
   */
  async deleteLaunch(launchId: number, confirm: string): Promise<PostOutcome[]> {
    const launch = await this.#launches.get(launchId);
    if (!launch) throw new PostRefused('not_found', 'no such launch');
    if (confirm !== launch.repo) throw new PostRefused('invalid', `type ${launch.repo} to confirm`);
    return this.deleteMany(launchId, undefined);
  }
}
