import * as React from 'react';

/**
 * Groups agenda rows under a date. Use when the list spans days; omit for a single-campaign list.
 */
export interface DayHeaderProps {
  /** the day number, set large in the time gutter so it lines up with the times below */
  lead?: React.ReactNode;
  /** width of that gutter — must match the table's When column */
  gutter?: number;
  /** e.g. "Thursday, October" */
  day: React.ReactNode;
  /** e.g. "in 2 days" */
  relative?: React.ReactNode;
  /** number of table columns to span */
  colSpan?: number;
  /** false renders a plain div instead of a table row */
  asRow?: boolean;
  style?: React.CSSProperties;
}
export declare function DayHeader(props: DayHeaderProps): JSX.Element;
