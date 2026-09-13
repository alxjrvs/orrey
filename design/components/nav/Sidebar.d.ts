import * as React from 'react';

/**
 * 210px left rail: campaigns, one-offs, and administration.
 */
export interface SidebarProps extends React.HTMLAttributes<HTMLElement> { children?: React.ReactNode }
export declare function Sidebar(props: SidebarProps): JSX.Element;

export interface SidebarSectionProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode;
  /** appended after an interpunct, e.g. "Campaigns · 4" */
  count?: number | string;
}
export declare function SidebarSection(props: SidebarSectionProps): JSX.Element;

export interface NavItemProps extends React.HTMLAttributes<HTMLDivElement> {
  /** campaign identity colour; omit for administration rows */
  color?: string;
  label: React.ReactNode;
  /** right-aligned mono fact — days until next session, seat count */
  meta?: React.ReactNode;
  active?: boolean;
}
export declare function NavItem(props: NavItemProps): JSX.Element;
