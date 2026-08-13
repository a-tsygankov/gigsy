/// <reference types="vite/client" />

// TourRenderer.ts side-effect-imports driver.js's stylesheet directly
// from its package subpath, which vite/client's own "*.css" ambient
// module does not reach (it only sees local specifiers on disk).
// Scoped to exactly that one specifier, rather than a "*.css" wildcard,
// which would widen every CSS import in the project to `any`.
declare module "driver.js/dist/driver.css";
