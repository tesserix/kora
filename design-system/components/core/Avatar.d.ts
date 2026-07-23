import * as React from "react";

/** Circular avatar with image or initials fallback. */
export interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  src?: string;
  alt?: string;
  initials?: string;
  size?: "sm" | "md" | "lg" | "xl" | number;
}
export declare function Avatar(props: AvatarProps): JSX.Element;
