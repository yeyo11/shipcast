/**
 * Turns what the server says went wrong into something a person can act on: a short title, one or
 * two sentences on what to do, and the original text kept as details for when they need it.
 */
export interface Explained {
  title: string;
  text: string;
  /** The text as it came, when it says more than the explanation */
  details?: string;
}

type Rule = { match: RegExp; explain: (m: RegExpExecArray, raw: string) => Omit<Explained, 'details'> };

const RULES: Rule[] = [
  {
    match: /Unsupported request - method type/,
    explain: () => ({
      title: 'Instagram refused this account',
      text: 'The account you authorised cannot use Instagram’s API. Sign in on instagram.com with a professional (Creator or Business) account that has a role in your Meta app (App roles → Instagram testers), then try again.',
    }),
  },
  {
    match: /token belongs to @([\w.]+), not to the account/,
    explain: (m) => ({
      title: 'Another Instagram account answered',
      text: `Instagram authorised @${m[1]}, not the account this connection is for. Sign in on instagram.com with the account you want and try again.`,
    }),
  },
  {
    match: /not a professional account/,
    explain: () => ({ title: 'Not a professional account', text: 'Instagram only lets professional (Creator or Business) accounts publish through its API. Switch the account to professional in Instagram’s settings, then try again.' }),
  },
  {
    match: /[Ii]nvalid redirect_uri/,
    explain: () => ({ title: 'Meta does not know this address', text: 'Add the app’s callback, exactly, in your Meta app: Instagram → API setup with Instagram login → Business login settings → OAuth redirect URIs.' }),
  },
  {
    match: /^(.+?) rejected the credential/,
    explain: (m) => ({ title: `${m[1]} refused the credential`, text: 'It is wrong, revoked or expired. Create a new one and connect the account again.' }),
  },
  {
    match: /^(.+?) accepted the credential but it lacks a permission/,
    explain: (m) => ({ title: 'A permission is missing', text: `${m[1]} accepted the credential, but it cannot do everything Shipcast needs. Give it the permissions listed on this page and connect it again.` }),
  },
  {
    match: /^(.+?) is rate limiting/,
    explain: (m) => ({ title: 'Too many requests', text: `${m[1]} asked Shipcast to slow down. Try again in a few minutes.` }),
  },
  {
    match: /could not reach|fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/,
    explain: () => ({ title: 'The network did not answer', text: 'Shipcast could not reach it. Check this machine’s connection and try again.' }),
  },
  {
    match: /stale or was not started here/,
    explain: () => ({ title: 'This authorisation expired', text: 'It took more than ten minutes or was started elsewhere. Start it again from this page.' }),
  },
  {
    match: /did not authorise Shipcast/,
    explain: () => ({ title: 'Authorisation cancelled', text: 'Nothing was connected. Start again when you are ready.' }),
  },
  {
    match: /^(.+) is required$/,
    explain: (m) => ({ title: 'Something is missing', text: `${m[1]} is required.` }),
  },
  {
    match: /registration on the instance was lost|refused to register Shipcast/,
    explain: () => ({ title: 'The instance refused Shipcast', text: 'Check the instance’s address, or paste an access token instead.' }),
  },
  {
    match: /was launched already/,
    explain: () => ({ title: 'Already launched', text: 'This release has a launch of its own; open it from Launches. A launch never runs twice.' }),
  },
  {
    match: /An article titled like this exists already/,
    explain: () => ({ title: 'That title is taken', text: 'Another article has the same title, and so the same address. Change the title.' }),
  },
  {
    match: /the pull request is (?:no longer open|merged|closed)/,
    explain: () => ({ title: 'Already decided', text: 'The drafts’ pull request is no longer open, so they can no longer be edited or approved here.' }),
  },
  {
    match: /has no published release|is not ready|No LICENSE|No README|launch\.yml/,
    explain: () => ({ title: 'Not ready to launch', text: 'The pre-flight check found something to fix in the repository first.' }),
  },
];

/** `Instagram: get a long-lived token: 400 {"error":…}` → the network, what failed, the status */
const API_FAILURE = /^([\w. ]+?): ([\w ,'-]+?): (\d{3})\b/;

export function explain(raw: string): Explained {
  const text = raw.trim();
  for (const rule of RULES) {
    const m = rule.match.exec(text);
    if (m) return { ...rule.explain(m, text), details: text };
  }
  const api = API_FAILURE.exec(text);
  if (api) {
    return {
      title: `${api[1]} said no`,
      text: `${api[1]} answered ${api[3]} when Shipcast tried to ${api[2]}. The details below say why; if it keeps happening, check the account on this page.`,
      details: text,
    };
  }
  // Short, plain sentences need no rewording; long or technical ones keep their full text as details
  const plain = text.length <= 160 && !/[{}]|\b\d{3}\b/.test(text);
  const first = text.charAt(0).toUpperCase() + text.slice(1);
  return plain ? { title: 'Something went wrong', text: first } : { title: 'Something went wrong', text: 'Shipcast could not finish this. The details below say what happened.', details: text };
}
