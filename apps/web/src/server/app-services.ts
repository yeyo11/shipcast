import {
  AccountService,
  CommentService,
  launchConfigOf,
  LaunchService,
  SettingsService,
  PostService,
  ScheduleService,
  type CommentDeps,
  type EditDeps,
  type GitHubRest,
  type PipelineDeps,
  type Post,
  type Registry,
  type ReviewGitHub,
} from '@shipcast/engine';

/*
 * The engine's application services as the web builds them, for the server functions, the launch
 * page's actions and the REST API alike: one construction each, so every entry point reaches a use
 * case the same way. They are cheap objects over the ports given; the ports (the registry, the
 * connectors by account, the queue's arming) come from the app's context, or from a test's fakes.
 */

/** What the posts' and the schedule's services need from the app */
export interface PieceServiceDeps {
  registry: Registry;
  /** What editing and deleting needs: the connectors by account, and GitHub for the blog */
  editing(): Promise<EditDeps>;
  /** Queues (or moves) the wake-up of each scheduled piece at its time */
  armSchedule(posts: Post[]): Promise<void>;
  /** For the launch's launch.yml: a channel it sets to off cannot be scheduled */
  github: Pick<ReviewGitHub, 'fileAt'>;
  launchesRepo: string;
}

export const postService = (deps: Pick<PieceServiceDeps, 'registry' | 'editing'>) => new PostService({ launches: deps.registry.launches, editing: deps.editing });

export const scheduleService = (deps: Pick<PieceServiceDeps, 'registry' | 'armSchedule' | 'github' | 'launchesRepo'>) =>
  new ScheduleService({
    store: deps.registry,
    recommendations: deps.registry,
    launchConfig: (launch) => launchConfigOf(deps.github, deps.launchesRepo, launch),
    arm: deps.armSchedule,
  });

/** `sending` builds the connectors a reply goes out with; a reader that sends nothing may leave it out */
export const commentService = (deps: { registry: Registry; sending?: () => Promise<CommentDeps> }) =>
  new CommentService({
    store: deps.registry,
    sending: deps.sending ?? (() => Promise.reject(new Error('this caller sends no replies'))),
  });

export const accountService = (deps: { registry: Registry }) => new AccountService(deps.registry.accounts);

export const settingsService = (deps: { registry: Registry }) => new SettingsService(deps.registry);

/** Over the app's pipeline (the claim's registry and launches repo) and its GitHub (the pre-flight, the merge) */
export const launchService = (deps: { registry: Registry; deps: Pick<PipelineDeps, 'github' | 'registry' | 'launchesRepo'>; github: GitHubRest }) =>
  new LaunchService({ launches: deps.registry.launches, claims: deps.deps, github: deps.github });
