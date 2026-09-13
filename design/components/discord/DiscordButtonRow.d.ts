import * as React from 'react';

/**
 * The primary input surface of the whole product. Five buttons per row is Discord's hard limit.
 */
export interface DiscordButtonSpec {
  label: React.ReactNode;
  style?: 'primary' | 'secondary' | 'success' | 'danger' | 'link';
  /** trailing tally, e.g. the number currently in */
  count?: number;
  emoji?: string;
  disabled?: boolean;
  onClick?: () => void;
}
export interface DiscordButtonRowProps extends React.HTMLAttributes<HTMLDivElement> {
  /** truncated to 5 — a longer set needs a select menu instead */
  buttons?: DiscordButtonSpec[];
}
export declare function DiscordButtonRow(props: DiscordButtonRowProps): JSX.Element;
