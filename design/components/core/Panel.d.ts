import * as React from 'react';

/**
 * Hairline-bordered region with a mono caps header. No shadow, no radius.
 */
export interface PanelProps extends React.HTMLAttributes<HTMLElement> {
  /** mono caps label, e.g. "ROSTER 4/6" */
  title?: React.ReactNode;
  /** secondary line beside the title */
  meta?: React.ReactNode;
  /** right-aligned controls in the header */
  actions?: React.ReactNode;
  /** remove body padding — for tables and full-bleed lists */
  flush?: boolean;
  children?: React.ReactNode;
}
export declare function Panel(props: PanelProps): JSX.Element;
