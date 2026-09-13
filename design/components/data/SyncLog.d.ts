import * as React from 'react';

/**
 * Append-only record of what Orrey did and what came back. Reads bottom-of-rail, never modal.
 */
export interface SyncLogEntry {
  /** 24h time, e.g. "19:02" */
  at: string;
  /** lower-case, machine-voiced: "gcal event orr_5f2a updated" */
  text: string;
  /** write brightens the line; error turns it rust */
  tone?: 'read' | 'write' | 'error';
}
export interface SyncLogProps extends React.HTMLAttributes<HTMLDivElement> {
  entries?: SyncLogEntry[];
}
export declare function SyncLog(props: SyncLogProps): JSX.Element;
