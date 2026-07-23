import * as React from "react";

export type BadgeVariant =
  | "default" | "secondary" | "destructive" | "outline"
  | "success" | "warning" | "error" | "info" | "neutral";

/** Small pill for status, counts, and labels. */
export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}
export declare function Badge(props: BadgeProps): JSX.Element;
