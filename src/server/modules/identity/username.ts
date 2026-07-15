const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export function normalizeUsername(value: string) {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function isValidUsername(value: string) {
  return USERNAME_PATTERN.test(value);
}
