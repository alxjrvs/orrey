import * as React from 'react';

/**
 * Discord chat frame around anything Orrey posts. Discord's palette, not Orrey's.
 */
export interface DiscordMessageProps extends React.HTMLAttributes<HTMLDivElement> {
  author?: string;
  /** shows the APP tag */
  bot?: boolean;
  /** Discord-style relative time, e.g. "Today at 17:00" */
  timestamp?: React.ReactNode;
  /** Orrey has no logo — the avatar is initials in type */
  avatarInitials?: string;
  children?: React.ReactNode;
}
export declare function DiscordMessage(props: DiscordMessageProps): JSX.Element;
