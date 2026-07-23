import * as React from "react";

export type ButtonVariant =
  | "default" | "destructive" | "outline" | "secondary" | "ghost" | "link" | "success" | "warning";
export type ButtonSize = "default" | "sm" | "lg" | "xl" | "icon" | "icon-sm" | "icon-lg";

/**
 * Primary action control. Nine variants, seven sizes; supports a loading state.
 * @startingPoint section="Core" subtitle="Buttons across all variants and sizes" viewport="700x220"
 */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
  loadingText?: string;
}
export declare function Button(props: ButtonProps): JSX.Element;
