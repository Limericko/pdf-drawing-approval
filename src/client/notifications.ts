export function newTaskNotificationIds(currentIds: number[], notifiedIds: number[]) {
  const notified = new Set(notifiedIds);
  return currentIds.filter((id) => !notified.has(id));
}

export function readNotifiedTaskIds(storage: Storage, key: string) {
  try {
    const value = storage.getItem(key);
    if (!value) return [];
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === "number") : [];
  } catch {
    return [];
  }
}

export function writeNotifiedTaskIds(storage: Storage, key: string, ids: number[]) {
  storage.setItem(key, JSON.stringify(Array.from(new Set(ids))));
}
