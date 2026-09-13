import * as React from 'react';

/**
 * Multi-select menu. Exists because a date poll can carry ten dates and a button row holds five.
 */
export interface DiscordSelectOption { label: string; count?: number }
export interface DiscordSelectProps extends React.HTMLAttributes<HTMLDivElement> {
  placeholder?: string;
  options?: (string | DiscordSelectOption)[];
  /** render the expanded list, for mockups of the open state */
  open?: boolean;
  selected?: string[];
  onToggle?: (label: string) => void;
}
export declare function DiscordSelect(props: DiscordSelectProps): JSX.Element;
