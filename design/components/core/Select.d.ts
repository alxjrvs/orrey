import * as React from 'react';

/**
 * Native select in console chrome, with a drawn caret.
 */
export interface SelectOption { value: string; label: string }
export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** strings, or {value,label} pairs */
  options?: (string | SelectOption)[];
}
export declare function Select(props: SelectProps): JSX.Element;
