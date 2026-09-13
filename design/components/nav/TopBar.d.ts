import * as React from 'react';

/**
 * Fixed 44px console chrome. Wordmark left, sync state right.
 */
export interface TopBarProps extends React.HTMLAttributes<HTMLElement> {
  children?: React.ReactNode;
}
export declare function TopBar(props: TopBarProps): JSX.Element;

/**
 * The brand mark: set in type, because Orrey has no logo.
 */
export interface WordmarkProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** px font size; 13 in chrome, 20+ on auth screens */
  size?: number;
}
export declare function Wordmark(props: WordmarkProps): JSX.Element;
