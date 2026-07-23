import * as React from "react";

/** Inline message block. Variants map to the semantic status token pairs. */
export interface CalloutProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "info" | "success" | "warning" | "error" | "neutral";
  title?: string;
  icon?: React.ReactNode;
}
export declare function Callout(props: CalloutProps): JSX.Element;
