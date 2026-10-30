import {
  AccountService,
  CommentService,
  launchConfigOf,
  LaunchService,
  pageFetcher,
  SettingsService,
  SourcesService,
  PostService,
  ScheduleService,
  type CommentDeps,
  type EditDeps,
  type GitHubRest,
  type MediaStore,
  type PipelineDeps,
  type Post,
  type Repositories,
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
  /** The pieces and their schedule, and what the recommended times are read from */
  registry: Pick<Repositories, 'launches' | 'posts' | 'accounts' | 'settings' | 'cursors' | 'queries'>;
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
export const commentService = (deps: { registry: Pick<Repositories, 'comments' | 'settings'>; sending?: () => Promise<CommentDeps> }) =>
  new CommentService({
    store: deps.registry,
    sending: deps.sending ?? (() => Promise.reject(new Error('this caller sends no replies'))),
  });

export const accountService = (deps: { registry: Pick<Repositories, 'accounts'> }) => new AccountService(deps.registry.accounts);

export const settingsService = (deps: { registry: Pick<Repositories, 'settings'> }) => new SettingsService(deps.registry);

/** Over the app's pipeline (the claim's registry and launches repo) and its GitHub (the pre-flight, the merge) */
export const launchService = (deps: { registry: Pick<Repositories, 'launches'>; deps: Pick<PipelineDeps, 'github' | 'registry' | 'launchesRepo'>; github: GitHubRest }) =>
  new LaunchService({ launches: deps.registry.launches, claims: deps.deps, github: deps.github });

/**
 * With `launch-sources`: launches made from sources, claimed through the launch service (a primary
 * repo's release and its pre-flight) and fed by the guarded page fetcher and the media store
 */
export const sourcesService = (deps: { registry: Pick<Repositories, 'launches' | 'sources'>; deps: Pick<PipelineDeps, 'github' | 'registry' | 'launchesRepo'>; github: GitHubRest; media: MediaStore }) =>
  new SourcesService({
    launchService: launchService(deps),
    launches: deps.registry.launches,
    sources: deps.registry.sources,
    launchesRepo: deps.deps.launchesRepo,
    media: deps.media,
    fetchPage: pageFetcher(),
  });
