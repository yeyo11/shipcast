import { Tabs as Base } from '@base-ui/react/tabs';
import type { ReactNode } from 'react';

export interface Tab<V extends string> {
  value: V;
  label: ReactNode;
  panel: ReactNode;
}

export interface TabsProps<V extends string> {
  /** Names the tab list for assistive technology ("Drafts by channel") */
  label: string;
  tabs: ReadonlyArray<Tab<V>>;
  value?: V;
  defaultValue?: V;
  onValueChange?: (value: V) => void;
  /** `underline` for a page's sections (a line under the current tab), rather than the segmented pills */
  variant?: 'pills' | 'underline';
}

/**
 * Tabs as Cartel's segmented control: the active tab filled in the text colour, the others outlined.
 * Arrow keys move between tabs and show each as they reach it; the list scrolls sideways on a narrow screen instead of overflowing
 * the page.
 */
export function Tabs<V extends string>({ label, tabs, value, defaultValue, onValueChange, variant = 'pills' }: TabsProps<V>) {
  return (
    <Base.Root className={variant === 'underline' ? 'ui-tabs ui-tabs-underline' : 'ui-tabs'} value={value} defaultValue={defaultValue ?? tabs[0]?.value} onValueChange={onValueChange ? (next) => onValueChange(next as V) : undefined}>
      <Base.List className="ui-tab-list" aria-label={label} activateOnFocus>
        {tabs.map((t) => (
          <Base.Tab key={t.value} value={t.value} className="ui-tab">
            {t.label}
          </Base.Tab>
        ))}
      </Base.List>
      {tabs.map((t) => (
        <Base.Panel key={t.value} value={t.value} className="ui-tab-panel">
          {t.panel}
        </Base.Panel>
      ))}
    </Base.Root>
  );
}
