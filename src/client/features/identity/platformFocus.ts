type Focusable = { focus(): void };
type FocusRoot = { querySelector(selector: string): Focusable | null };

export function focusPlatformHeading(root: FocusRoot | null | undefined) {
  root?.querySelector("h1")?.focus();
}

export function focusPlatformError(root: FocusRoot | null | undefined) {
  root?.querySelector('[role="alert"]')?.focus();
}
