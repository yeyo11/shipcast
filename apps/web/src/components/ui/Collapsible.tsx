import { Accordion as BaseAccordion } from '@base-ui/react/accordion';
import { Collapsible as Base } from '@base-ui/react/collapsible';
import type { ReactNode } from 'react';

/** The drawn chevron that turns with the state, shared by both so a fold looks the same everywhere */
const Chevron = () => <span className="ui-chevron" aria-hidden="true" />;

export interface CollapsibleProps {
  /** What is always visible: the button that folds and unfolds. Phrasing content only: it sits inside a button */
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** On the root: the box around the summary and the panel */
  className?: string;
  /** On the button, for a fold whose summary needs its own layout */
  triggerClassName?: string;
}

/**
 * One fold, for what stands alone (a toast's Details, the onboarding's step list). The panel's height
 * animates through `--collapsible-panel-height`; under `prefers-reduced-motion` it is instant, since
 * `--ui-move` is zero then.
 */
export function Collapsible({ summary, children, defaultOpen, open, onOpenChange, className, triggerClassName }: CollapsibleProps) {
  return (
    <Base.Root className={`ui-collapsible${className ? ` ${className}` : ''}`} defaultOpen={defaultOpen} open={open} onOpenChange={onOpenChange}>
      <Base.Trigger className={`ui-collapsible-trigger${triggerClassName ? ` ${triggerClassName}` : ''}`}>
        {summary}
        <Chevron />
      </Base.Trigger>
      <Base.Panel className="ui-collapsible-panel">
        <div className="ui-collapsible-inner">{children}</div>
      </Base.Panel>
    </Base.Root>
  );
}

/**
 * Folds that sit together (the drafts of a launch, the prompts): a group the owner can open several
 * of at once. Each `AccordionItem` is one fold with a heading, so a screen reader lists them.
 */
export function Accordion({ children, className, defaultValue }: { children: ReactNode; className?: string; defaultValue?: string[] }) {
  return (
    <BaseAccordion.Root className={className} multiple defaultValue={defaultValue}>
      {children}
    </BaseAccordion.Root>
  );
}

export function AccordionItem({ value, summary, children, className, triggerClassName }: { value: string; summary: ReactNode; children: ReactNode; className?: string; triggerClassName?: string }) {
  return (
    <BaseAccordion.Item value={value} className={`ui-collapsible${className ? ` ${className}` : ''}`}>
      <BaseAccordion.Header className="ui-accordion-header">
        <BaseAccordion.Trigger className={`ui-collapsible-trigger${triggerClassName ? ` ${triggerClassName}` : ''}`}>
          {summary}
          <Chevron />
        </BaseAccordion.Trigger>
      </BaseAccordion.Header>
      <BaseAccordion.Panel className="ui-collapsible-panel ui-accordion-panel">
        <div className="ui-collapsible-inner">{children}</div>
      </BaseAccordion.Panel>
    </BaseAccordion.Item>
  );
}
