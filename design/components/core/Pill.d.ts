import * as React from 'react';

/**
 * Lifecycle / quorum state label. The only rounded shape in the console.
 */
export interface PillProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** in = confirmed or running; maybe = needs attention; out = cancelled or short; accent = live poll; idle = not yet posted */
  tone?: 'neutral' | 'in' | 'maybe' | 'out' | 'accent' | 'idle';
  /** leading dot, for live/streaming states only */
  dot?: boolean;
  children?: React.ReactNode;
}
export declare function Pill(props: PillProps): JSX.Element;
