/**
 * Design-system component barrel (docs/design-system.md). Screens
 * import from here, never from component internals — the inventory
 * mirrors the Gigsy Design System exactly:
 *
 *   core        Button, Card, Input, Textarea, Select, Field, Toggle,
 *               DateTimeField, DurationField, ExtraDatesField, FilePicker,
 *               GigPicker
 *   settings    SettingRow, SettingGroup
 *   data        Tile, SectionHeading, GigRow
 *   feedback    StatusPill, SyncBadge, EmptyState, ListSkeleton, Splash
 *   navigation  AppHeader, TabBar, Fab, Segmented
 *   overlay     Sheet
 */
export { Button, ButtonLink, buttonClasses } from "./Button.tsx";
export { Card, CardLink, cardClasses } from "./Card.tsx";
export { Input, Textarea, inputShellClasses, textareaClasses } from "./Input.tsx";
export { Select } from "./Select.tsx";
export { Field } from "./Field.tsx";
export { DateTimeField } from "./DateTimeField.tsx";
export { DurationField } from "./DurationField.tsx";
export { ExtraDatesField } from "./ExtraDatesField.tsx";
export { FilePicker } from "./FilePicker.tsx";
export { GigPicker, type GigPickerProps } from "./GigPicker.tsx";
export { Toggle } from "./Toggle.tsx";
export { SettingRow, SettingGroup } from "./SettingRow.tsx";
export { Tile, TILE_TONE_CLASSES } from "./Tile.tsx";
export { SectionHeading } from "./SectionHeading.tsx";
export { GigRow, gigDateLine, gigSummary, type GigRowProps } from "./GigRow.tsx";
export { StatusPill, STATUS_PILL_CLASSES } from "./StatusPill.tsx";
export { SyncBadge } from "./SyncBadge.tsx";
export { EmptyState } from "./EmptyState.tsx";
export { ListSkeleton } from "./ListSkeleton.tsx";
export { Splash } from "./Splash.tsx";
export { UpdateBar } from "./UpdateBar.tsx";
export { AppHeader } from "./AppHeader.tsx";
export { TabBar } from "./TabBar.tsx";
export { Fab } from "./Fab.tsx";
export { Segmented, type SegmentedOption } from "./Segmented.tsx";
export { Sheet, type SheetProps } from "./Sheet.tsx";
