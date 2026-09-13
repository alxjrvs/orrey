import * as React from 'react';

/**
 * Answers "does it run" at a glance: one square per roster seat, filled by declared intent.
 */
export interface QuorumMeterProps extends React.HTMLAttributes<HTMLDivElement> {
  inCount?: number;
  maybeCount?: number;
  outCount?: number;
  /** roster size — remaining squares render as silent (no reply) */
  total?: number;
  /** minimum players for the session to run; below it the count turns amber */
  quorum?: number;
  showCount?: boolean;
  /** px edge of each square */
  size?: number;
}
export declare function QuorumMeter(props: QuorumMeterProps): JSX.Element;
