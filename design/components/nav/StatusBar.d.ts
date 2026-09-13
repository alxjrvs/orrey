import * as React from 'react';

/**
 * 26px bottom bar of machine facts: what is authoritative, what is queued, when the clock next runs.
 */
export interface StatusBarProps extends React.HTMLAttributes<HTMLElement> { children?: React.ReactNode }
export declare function StatusBar(props: StatusBarProps): JSX.Element;

export interface StatusItemProps extends React.HTMLAttributes<HTMLSpanElement> {
  label: React.ReactNode;
  /** the figure, rendered brighter than its label */
  value?: React.ReactNode;
}
export declare function StatusItem(props: StatusItemProps): JSX.Element;
