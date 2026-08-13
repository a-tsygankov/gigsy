/// <reference types="vite/client" />

// TourRenderer.ts side-effect-imports driver.js's stylesheet directly
// from its package subpath, which vite/client's own "*.css" ambient
// module does not reach (it only sees local specifiers on disk). This
// widens the same wildcard so the bare package import type-checks too.
declare module "*.css";
