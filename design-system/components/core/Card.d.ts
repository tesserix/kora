import * as React from "react";

/**
 * Surface container. `default` = bordered card w/ large shadow; `glass` = translucent blur.
 * Compose with CardHeader / CardTitle / CardDescription / CardContent / CardFooter.
 * @startingPoint section="Core" subtitle="Card surface with header, content and footer" viewport="700x240"
 */
export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "glass";
}
export declare function Card(props: CardProps): JSX.Element;
export declare function CardHeader(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function CardTitle(props: React.HTMLAttributes<HTMLHeadingElement>): JSX.Element;
export declare function CardDescription(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function CardContent(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function CardFooter(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
