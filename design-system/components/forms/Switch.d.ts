import * as React from "react";

/** Toggle switch. Controlled via `checked` + `onCheckedChange`, or uncontrolled via `defaultChecked`. */
export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
}
export declare function Switch(props: SwitchProps): JSX.Element;
