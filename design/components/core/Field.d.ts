import * as React from 'react';

/**
 * Label + control + hint/error wrapper for console admin forms, and the text input itself.
 */
export interface FieldProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  label?: React.ReactNode;
  /** muted helper line under the control */
  hint?: React.ReactNode;
  /** replaces the hint and turns it rust */
  error?: React.ReactNode;
  required?: boolean;
  children?: React.ReactNode;
}
export declare function Field(props: FieldProps): JSX.Element;

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}
export declare function Input(props: InputProps): JSX.Element;
