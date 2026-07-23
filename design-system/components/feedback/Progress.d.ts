import * as React from "react";
/** Linear progress bar. */
export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  max?: number;
  color?: string;
  height?: number;
}
export declare function Progress(props: ProgressProps): JSX.Element;
