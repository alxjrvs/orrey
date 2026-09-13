import * as React from 'react';

/**
 * 14px square checkbox. Also the shape used for date-poll multi-select rows.
 */
export interface CheckboxProps {
  checked?: boolean;
  label?: React.ReactNode;
  disabled?: boolean;
  onChange?: (next: boolean) => void;
  style?: React.CSSProperties;
}
export declare function Checkbox(props: CheckboxProps): JSX.Element;
