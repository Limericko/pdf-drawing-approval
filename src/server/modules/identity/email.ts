export function normalizeEmail(email: string) {
  return email.normalize("NFKC").trim().toLowerCase();
}
