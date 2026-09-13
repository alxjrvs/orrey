import * as React from 'react';

/**
 * Square hairline chip for machine facts: ids, versions, counts, table names.
 */
export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** false renders in the UI face instead of mono (rare) */
  mono?: boolean;
  children?: React.ReactNode;
}
export declare function Tag(props: TagProps): JSX.Element;
