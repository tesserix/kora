import * as React from "react";

/** KPI stat block: label, value, optional unit and trend delta. */
export interface StatProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  value: React.ReactNode;
  unit?: string;
  delta?: React.ReactNode;
  trend?: "up" | "down";
}
export declare function Stat(props: StatProps): JSX.Element;
