/**
 * The list-row / panel surface every screen uses (design system,
 * components/core/Card): white fill, 1px slate-200 hairline, 12px
 * radius, shadow-sm. Interactive cards lift one shadow step on hover.
 * `dense` is the compact row used for services/payments inside a gig.
 */
import type { ComponentPropsWithoutRef } from "react";
import { Link, type LinkProps } from "react-router-dom";

export interface CardStyleProps {
  /** Adds the hover shadow lift — set on cards that navigate. */
  interactive?: boolean | undefined;
  /** Compact row: px-3 py-2, 14px text, no resting shadow. */
  dense?: boolean | undefined;
  className?: string | undefined;
}

export function cardClasses({
  interactive = false,
  dense = false,
  className = "",
}: CardStyleProps): string {
  return [
    "block rounded-xl border border-slate-200 bg-white",
    dense ? "px-3 py-2 text-sm" : "p-4 shadow-sm",
    interactive ? "transition-shadow duration-150 hover:shadow" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

type CardProps = CardStyleProps & ComponentPropsWithoutRef<"div"> & {
  /** Render as a semantic container, e.g. "section". */
  as?: "div" | "section";
};

export function Card({ interactive, dense, className, as: Tag = "div", ...rest }: CardProps) {
  return <Tag className={cardClasses({ interactive, dense, className })} {...rest} />;
}

type CardLinkProps = CardStyleProps & LinkProps;

/** A card that navigates — always gets the hover lift. */
export function CardLink({ interactive = true, dense, className, ...rest }: CardLinkProps) {
  return <Link className={cardClasses({ interactive, dense, className })} {...rest} />;
}
