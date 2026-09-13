import * as React from 'react';

/**
 * Dense hairline table. Header is mono caps on chrome; rows are 1px-separated, never striped.
 */
export interface Column { label: React.ReactNode; width?: string | number; align?: 'left' | 'right' | 'center' }
export interface DataTableProps extends React.TableHTMLAttributes<HTMLTableElement> {
  columns?: Column[];
  children?: React.ReactNode;
}
export declare function DataTable(props: DataTableProps): JSX.Element;

export interface CellProps extends React.TdHTMLAttributes<HTMLTableCellElement> { children?: React.ReactNode }
export declare function Cell(props: CellProps): JSX.Element;
