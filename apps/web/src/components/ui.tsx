import type { ReactNode } from 'react';
import { explain } from './errors';
import { CHANNEL_NAMES, channelIcon, type Tone } from '../server/view';

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`pill s-${tone}`}>{children}</span>;
}

export function ChannelName({ channel }: { channel: string }) {
  const icon = channelIcon(channel);
  return (
    <>
      {icon ? <img className="icon" src={icon} alt="" /> : <span aria-hidden="true" style={{ width: 22, display: 'inline-block' }} />}
      <span className="ch">{CHANNEL_NAMES[channel] ?? channel}</span>
    </>
  );
}

export const when = (iso: string) => iso.slice(0, 16).replace('T', ' ');

export const number = (n: number) => (Number.isInteger(n) ? n.toLocaleString('en') : n.toFixed(2));

/** A failure kept on the page (an account's last check, a channel that failed): explained, with the original folded away */
export function Problem({ text }: { text: string }) {
  const e = explain(text);
  return (
    <div className="problem" role="note">
      <strong>{e.title}.</strong> {e.text}
      {e.details && (
        <details className="toast-details">
          <summary>Details</summary>
          <pre>{e.details}</pre>
        </details>
      )}
    </div>
  );
}

export function Notice({ tone, children }: { tone: 'ok' | 'bad' | 'wait'; children: ReactNode }) {
  return (
    <div className={`notice ${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
