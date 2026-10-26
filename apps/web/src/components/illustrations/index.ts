/*
 * Shipcast's illustration set: postal, with humour, drawn on Cartel's role tokens
 * (docs/plans/design-system.md, "Illustrations"). Each scene is decorative unless given a `title`.
 */
import type { ComponentType } from 'react';
import { Automation } from './Automation';
import { EmptyDrafts } from './EmptyDrafts';
import { EmptyLaunches } from './EmptyLaunches';
import type { IllustrationProps } from './kit';
import { NoAccounts } from './NoAccounts';
import { NotFound } from './NotFound';
import { Pigeonholes } from './Pigeonholes';
import { Mailbox } from './Mailbox';
import { Scale } from './Scale';
import { Toolbox } from './Toolbox';
import { Offline } from './Offline';
import { OnboardAI } from './OnboardAI';
import { OnboardAutomation } from './OnboardAutomation';
import { OnboardBrand } from './OnboardBrand';
import { OnboardChannels } from './OnboardChannels';
import { OnboardMeasure } from './OnboardMeasure';
import { Parcels } from './Parcels';
import { Sealing } from './Sealing';
import { Typewriter } from './Typewriter';
import { PublishFailed } from './PublishFailed';
import { ServerError } from './ServerError';
import { Shipped } from './Shipped';
import { SignIn } from './SignIn';
import { WaitingForYou } from './WaitingForYou';

export type { IllustrationProps } from './kit';
export {
  Pigeonholes,
  Mailbox,
  Scale,
  Toolbox,
  Parcels,
  Sealing,
  Typewriter,
  Automation,
  EmptyDrafts,
  EmptyLaunches,
  NoAccounts,
  NotFound,
  Offline,
  OnboardAI,
  OnboardAutomation,
  OnboardBrand,
  OnboardChannels,
  OnboardMeasure,
  PublishFailed,
  ServerError,
  Shipped,
  SignIn,
  WaitingForYou,
};

/** Every scene by name, in the order the gallery shows them, with what it is for */
export const ILLUSTRATIONS = {
  NotFound: { component: NotFound, use: '404: a label stamped "Return to sender"' },
  ServerError: { component: ServerError, use: '500: a torn parcel sealed "Damaged"' },
  Offline: { component: Offline, use: 'Offline: a mailbox, flag down, cord cut' },
  EmptyLaunches: { component: EmptyLaunches, use: 'No launches: an empty open box' },
  EmptyDrafts: { component: EmptyDrafts, use: 'No drafts: a blank label pad' },
  NoAccounts: { component: NoAccounts, use: 'No accounts: a megaphone, unplugged' },
  WaitingForYou: { component: WaitingForYou, use: 'Waiting for you: a yellow parcel ringing the bell' },
  Shipped: { component: Shipped, use: 'Shipped: the postmark' },
  PublishFailed: { component: PublishFailed, use: 'A post failed: the "Damaged" stamp' },
  SignIn: { component: SignIn, use: 'Sign in: a poster on the wall' },
  Automation: { component: Automation, use: 'Automation: the sorting machine' },
  OnboardBrand: { component: OnboardBrand, use: 'Onboarding, brand: a repo becomes a parcel' },
  OnboardAI: { component: OnboardAI, use: 'Onboarding, AI: the clerk and the spark' },
  OnboardChannels: { component: OnboardChannels, use: 'Onboarding, channels: the address book' },
  OnboardMeasure: { component: OnboardMeasure, use: 'Onboarding, measuring: the tracking slip' },
  OnboardAutomation: { component: OnboardAutomation, use: 'Onboarding, automation: the belt and the clock' },
  Parcels: { component: Parcels, use: 'Launches, the list: parcels on a sack truck, one with a moustache' },
  Sealing: { component: Sealing, use: 'Launch a repo: a parcel taped shut, labelled "To: The world"' },
  Typewriter: { component: Typewriter, use: 'Write: a typewriter, the bell about to ding' },
  Pigeonholes: { component: Pigeonholes, use: 'Channels: the pigeonhole wall, a few holes tagged, a pigeon with a letter' },
  Mailbox: { component: Mailbox, use: 'Comments: letters arriving in a smiling mailbox, a reply slip beside it' },
  Scale: { component: Scale, use: 'Stats: a scale weighing a parcel with a bar chart on its label' },
  Toolbox: { component: Toolbox, use: 'Settings: a toolbox on a parcel, a wrench, a stamp and a spare screw' },
} as const satisfies Record<string, { component: ComponentType<IllustrationProps>; use: string }>;

export type Illustration = keyof typeof ILLUSTRATIONS;

export const ILLUSTRATION_NAMES = Object.keys(ILLUSTRATIONS) as Illustration[];
