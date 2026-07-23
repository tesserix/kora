import * as React from "react";

/** Text field with 2px border, 44px height, and validity states (valid/invalid + helper/error text). */
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  isValid?: boolean;
  isInvalid?: boolean;
  helperText?: string;
  errorText?: string;
}
export declare function Input(props: InputProps): JSX.Element;
