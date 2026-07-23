import * as React from "react";
/** Shimmer loading placeholder. */
export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  width?: number | string;
  height?: number | string;
  radius?: string;
}
export declare function Skeleton(props: SkeletonProps): JSX.Element;
