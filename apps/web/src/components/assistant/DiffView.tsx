import { Fragment, useMemo } from 'react';
import { diffSummary, readableDiff, wordDiff } from './diff';

export interface DiffViewProps {
  before: string;
  after: string;
  label: string;
  /** The words around a selection, shown plain on each side so the change reads in place */
  context?: { before: string; after: string };
  /** The key under the text (the proposal card's "added" and "removed") */
  legend?: boolean;
  /** Shortens unchanged stretches longer than this many characters to their ends, for a change in a long text */
  trim?: number;
  className?: string;
}

/** An unchanged stretch cut to what touches the changes: its end before the first, its start after the last */
function shorten(text: string, at: 'start' | 'middle' | 'end', max: number): string {
  if (text.length <= (at === 'middle' ? max * 2 : max)) return text;
  const head = text.slice(0, max).replace(/\s\S*$/, ' ');
  const tail = text.slice(text.length - max).replace(/^\S*\s/, ' ');
  if (at === 'start') return `…${tail}`;
  if (at === 'end') return `${head}…`;
  return `${head}…${tail}`;
}

/**
 * A proposal against what it replaces, word by word (the board's diff-del and diff-add). Deletions
 * are struck through besides their colour, and each change carries a hidden "deleted" or "inserted"
 * for screen readers, so nothing depends on colour alone; the count of words changed is read first.
 */
export function DiffView({ before, after, label, context, legend, trim, className }: DiffViewProps) {
  const parts = useMemo(() => readableDiff(wordDiff(before, after)), [before, after]);
  const { inserted, deleted } = diffSummary(parts);
  return (
    <figure className={`wr-diff${className ? ` ${className}` : ''}`} aria-label={label}>
      <figcaption className="visually-hidden">{inserted === 0 && deleted === 0 ? 'No change in the words' : `${inserted} word${inserted === 1 ? '' : 's'} added, ${deleted} removed`}</figcaption>
      {/* Focusable, so a keyboard can scroll a proposal taller than its box */}
      <div className="wr-diff-text" role="region" aria-label={label} tabIndex={0}>
        {context?.before}
        {parts.map((part, i) =>
          part.type === 'equal' ? (
            <span key={i}>{trim ? shorten(part.text, i === 0 ? 'start' : i === parts.length - 1 ? 'end' : 'middle', trim) : part.text}</span>
          ) : part.type === 'delete' ? (
            <Fragment key={i}>
              <del className="k-diff-del">
                <span className="visually-hidden"> [deleted: </span>
                {part.text}
                <span className="visually-hidden">] </span>
              </del>
              {/* A replacement reads as two blocks side by side, as the board draws it */}
              {parts[i + 1]?.type === 'insert' && !/\s$/.test(part.text) && ' '}
            </Fragment>
          ) : (
            <ins key={i} className="k-diff-add">
              <span className="visually-hidden"> [inserted: </span>
              {part.text}
              <span className="visually-hidden">] </span>
            </ins>
          ),
        )}
        {context?.after}
      </div>
      {legend && (
        <div className="k-hrow k-g8 k-xs k-muted" aria-hidden="true">
          <span className="k-hrow k-g4">
            <span className="wr-swatch wr-swatch-add" />
            added
          </span>
          <span className="k-hrow k-g4">
            <span className="wr-swatch wr-swatch-del" />
            removed
          </span>
        </div>
      )}
    </figure>
  );
}
