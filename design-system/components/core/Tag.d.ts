import * as React from "react";

/** Chip for filters and token inputs. Optional leading color dot and remove button. */
export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  onRemove?: () => void;
  color?: string;
}
export declare function Tag(props: TagProps): JSX.Element;
