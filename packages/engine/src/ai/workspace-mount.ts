import { mkdir } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import type { Workspace } from '../workspace.ts';

/**
 * Where the job's checkouts are, as a remote agent sees them: the engine clones on this machine, and
 * a provider that reads the repo itself (claudio) has the same folder mounted at another path. The one
 * place that maps one to the other, so no path of the provider's side is written anywhere else.
 */
export interface WorkspaceMount {
  /** The checkout at `hostPath` on this machine, as the provider sees it; throws for a path outside the workspace */
  providerPath(hostPath: string): string;
  /** A folder with nothing in it, as the provider sees it: where it works on a task with no repo. Created when missing */
  emptyDir(): Promise<string>;
}

const EMPTY = '.shipcast-empty';

/** The mount of a workspace: `/app/workspace/x` on this machine is `/workspace/x` on claudio's side */
export function workspaceMount(workspace: Pick<Workspace, 'hostDir' | 'providerDir'>): WorkspaceMount {
  const providerRoot = workspace.providerDir.replace(/\/+$/, '') || '/';
  return {
    providerPath(hostPath) {
      const rel = relative(workspace.hostDir, hostPath);
      if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error(`${hostPath} is not in the workspace ${workspace.hostDir}`);
      // The provider's side is a POSIX path whatever this machine is
      return rel ? posix.join(providerRoot, ...rel.split(sep)) : providerRoot;
    },
    async emptyDir() {
      await mkdir(join(workspace.hostDir, EMPTY), { recursive: true });
      return posix.join(providerRoot, EMPTY);
    },
  };
}
