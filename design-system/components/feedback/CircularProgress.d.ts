import * as React from "react";

/**
 * Circular ring gauge — the calorie/macro ring used throughout the Plate app.
 * Center content passed as children.
 * @startingPoint section="Feedback" subtitle="Ring progress gauge with center label" viewport="700x200"
 */
export interface CircularProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  max?: number;
  size?: number;
  stroke?: number;
  color?: string;
  track?: string;
}
export declare function CircularProgress(props: CircularProgressProps): JSX.Element;
