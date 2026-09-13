import * as React from 'react';

/**
 * Mutually exclusive view filter above a table. Square, hairline-divided, accent-filled when on.
 */
export interface SegmentedFilterProps extends React.HTMLAttributes<HTMLDivElement> {
  options?: (string | { value: string; label: string })[];
  value?: string;
  onChange?: (next: string) => void;
}
export declare function SegmentedFilter(props: SegmentedFilterProps): JSX.Element;
