import * as React from "react";

export type IconSize = "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | number;

/**
 * Renders a Lucide glyph by name. Requires the lucide UMD script to be loaded on the page.
 * Tesserix uses Lucide (stroke 2) as its icon system; sizes map to iconSizes tokens.
 */
export interface IconProps extends React.SVGAttributes<SVGSVGElement> {
  name: string;
  size?: IconSize;
  color?: string;
  strokeWidth?: number;
}
export declare function Icon(props: IconProps): JSX.Element;
