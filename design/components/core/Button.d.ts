import * as React from 'react';

/**
 * Square, mono, uppercase action control. One accent-filled primary per view.
 */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary = the single accent action; secondary = hairline outline; ghost = list-level action; danger = destructive */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  /** stretch to container width, for rail action grids */
  full?: boolean;
  children?: React.ReactNode;
}
export declare function Button(props: ButtonProps): JSX.Element;
