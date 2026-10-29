import { useMemo } from 'react';
import { diffSummary, wordDiff } from './diff';

/**
 * A proposal against what it replaces, word by word. Deletions are struck through and insertions
 * underlined, besides their colours, and each carries a hidden "deleted" or "inserted" for screen
 * readers, so nothing depends on colour alone.
 */
export function DiffView({ before, after, label }: { before: string; after: string; label: string }) {
  const parts = useMemo(() => wordDiff(before, after), [before, after]);
  const { inserted, deleted } = diffSummary(parts);
  return (
    <figure className="diff" aria-label={label}>
      <figcaption className="diff-summary">
        {inserted === 0 && deleted === 0 ? 'No change in the words' : `${inserted} word${inserted === 1 ? '' : 's'} added, ${deleted} removed`}
        <span className="diff-key" aria-hidden="true">
          <del>removed</del> <ins>added</ins>
        </span>
      </figcaption>
      {/* Focusable, so a keyboard can scroll a proposal taller than its box */}
      <div className="diff-text" role="region" aria-label={label} tabIndex={0}>
        {parts.map((part, i) =>
          part.type === 'equal' ? (
            <span key={i}>{part.text}</span>
          ) : part.type === 'delete' ? (
            <del key={i}>
              <span className="visually-hidden"> [deleted: </span>
              {part.text}
              <span className="visually-hidden">] </span>
            </del>
          ) : (
            <ins key={i}>
              <span className="visually-hidden"> [inserted: </span>
              {part.text}
              <span className="visually-hidden">] </span>
            </ins>
          ),
        )}
      </div>
    </figure>
  );
}
