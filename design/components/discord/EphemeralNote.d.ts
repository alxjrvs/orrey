import * as React from 'react';

/**
 * The "only you can see this" footer. Every Orrey command answers ephemerally.
 */
export interface EphemeralNoteProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
  /** shows the Dismiss message link */
  dismissable?: boolean;
}
export declare function EphemeralNote(props: EphemeralNoteProps): JSX.Element;
