import * as React from 'react';

/**
 * Projection health for one external display. Orrey owns the data; these say whether the mirror is current.
 */
export interface SyncChipProps extends React.HTMLAttributes<HTMLDivElement> {
  /** ok = current; stale = behind; down = erroring; off = no dot, plain chrome text */
  status?: 'ok' | 'stale' | 'down' | 'off';
  label?: React.ReactNode;
  children?: React.ReactNode;
}
export declare function SyncChip(props: SyncChipProps): JSX.Element;
