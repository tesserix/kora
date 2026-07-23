import * as React from "react";

/** Checkbox. Controlled via `checked` + `onCheckedChange`, or uncontrolled via `defaultChecked`. */
export interface CheckboxProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
}
export declare function Checkbox(props: CheckboxProps): JSX.Element;
