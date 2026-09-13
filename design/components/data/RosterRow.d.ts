import * as React from 'react';

/**
 * One player's answer for one session: declared intent, plus the organiser-correctable attended mark.
 */
export interface RosterRowProps extends React.HTMLAttributes<HTMLDivElement> {
  name: React.ReactNode;
  /** two-letter initials for the square avatar */
  initials?: string;
  /** "GM" or similar, rendered in parentheses */
  role?: string;
  /** declared intent; silent means no reply, which is not a no */
  intent?: 'in' | 'out' | 'maybe' | 'silent';
  /** post-session attended mark; omit before the session has happened */
  attended?: boolean;
  /** short free-text note the player attached to their answer */
  note?: React.ReactNode;
}
export declare function RosterRow(props: RosterRowProps): JSX.Element;

export interface AvatarProps extends React.HTMLAttributes<HTMLElement> {
  initials?: string;
  /** background override, e.g. a campaign colour */
  tone?: string;
  size?: number;
}
export declare function Avatar(props: AvatarProps): JSX.Element;
