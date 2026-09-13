import * as React from 'react';
import type { QuorumMeterProps } from './QuorumMeter';

/**
 * One scheduled thing in the agenda: a campaign session, a one-off, or a game day.
 */
export interface SessionRowProps extends React.HTMLAttributes<HTMLTableRowElement> {
  /** short date, e.g. "THU 02" — only used when the list has a When column */
  when?: React.ReactNode;
  time?: React.ReactNode;
  /** drop the When column entirely and set the time inline before the title — the default
   *  under a DayHeader, where the day is the spine and the time is a detail */
  inlineTime?: boolean;
  title: React.ReactNode;
  /** lower-case session title or scheduling note */
  subtitle?: React.ReactNode;
  attendance?: QuorumMeterProps;
  /** session state, mapped to a Pill tone */
  state?: 'confirmed' | 'jeopardy' | 'open' | 'unposted' | 'cancelled' | 'played';
  selected?: boolean;
}
export declare function SessionRow(props: SessionRowProps): JSX.Element;
