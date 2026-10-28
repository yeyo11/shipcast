import { settingDefinition, SETTINGS, type SettingName } from '@shipcast/runtime';
import { createServerFn } from '@tanstack/react-start';
import { appContext } from './context.server';
import { forOwner } from './errors';
import { InvalidInput, object, text } from './input';

const NAMES = Object.keys(SETTINGS) as SettingName[];
/** Shown as set or not, never sent to the page */
const SECRET: SettingName[] = NAMES.filter((n) => settingDefinition(n).store.kind === 'secret');

/** What the Settings page shows: each setting and where it comes from, the GitHub App and the owner's token */
export const getSettings = createServerFn({ method: 'GET' }).handler(async () => {
  const ctx = await appContext();
  const values = await ctx.settings.read();
  const sources = ctx.settings.sources();
  const settings = NAMES.map((name) => {
    const value = values[name];
    return {
      name,
      label: settingDefinition(name).label,
      env: settingDefinition(name).env,
      secret: SECRET.includes(name),
      value: SECRET.includes(name) || value === undefined ? null : String(value),
      set: value !== undefined,
      source: sources[name] ?? 'unset',
    };
  });

  let installation: { account: string; repositories: string; permissions: string } | null = null;
  let installationProblem: string | null = null;
  if (ctx.githubApp) {
    try {
      const found = await ctx.githubApp.installation();
      installation = {
        account: found.account,
        repositories: found.repositorySelection === 'all' ? 'all repositories' : 'selected repositories',
        permissions: Object.entries(found.permissions)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', '),
      };
    } catch (error) {
      installationProblem = error instanceof Error ? error.message : String(error);
    }
  }
  // Asking for the token refreshes it when it is close to expiring: the page shows the state after that
  const userToken = ctx.userTokens ? ((await ctx.userTokens.token()) ? await ctx.userTokens.stored() : undefined) : undefined;
  return {
    settings,
    missing: ctx.settings.missing().map((n) => settingDefinition(n).label),
    secretsKind: ctx.secrets.kind,
    github: {
      access: ctx.access,
      signIn: ctx.app.github.kind,
      installation,
      installationProblem,
      user: userToken ? { login: userToken.login, expiresAt: userToken.expiresAt ?? null, refreshExpiresAt: userToken.refreshExpiresAt ?? null } : null,
    },
  };
});

/** A string sets a setting, null clears it; anything not sent is left as it is */
export const saveSettings = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'settings');
    const change: Partial<Record<SettingName, string | null>> = {};
    for (const [key, value] of Object.entries(o)) {
      if (!NAMES.includes(key as SettingName)) throw new InvalidInput(`${key} is not a setting`);
      change[key as SettingName] = value === null ? null : text(value, key, 4000);
    }
    return change;
  })
  .handler(async ({ data }) => {
    const ctx = await appContext();
    await forOwner(() => ctx.settings.write(data));
    await ctx.refresh();
    return { missing: ctx.settings.missing().map((n) => settingDefinition(n).label) };
  });
