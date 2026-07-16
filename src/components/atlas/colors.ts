/**
 * Category → CSS-variable map for dynamic (per-category) SVG fills.
 *
 * Per ADR-2, SVG presentation attributes cannot use `var()` (renders black
 * silently). Dynamic colour therefore flows only through style objects, e.g.
 * `style={{ fill: CATEGORY_VAR[cat] }}`. The tokens live in theme.css (both
 * themes), so category colours flip with the theme by construction.
 */
import { CATEGORY_SLUGS } from '../../data/categories';

export const CATEGORY_VAR: Record<string, string> = Object.fromEntries(
  CATEGORY_SLUGS.map((slug) => [slug, `var(--cat-${slug})`]),
);
