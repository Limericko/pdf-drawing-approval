export function newNotificationIds(currentIds: number[], notifiedIds: number[]) {
  const notified = new Set(notifiedIds);
  return uniqueNumbers(currentIds).filter((id) => !notified.has(id));
}

export function mergeNotifiedIds(existingIds: number[], newIds: number[]) {
  return uniqueNumbers([...existingIds, ...newIds]);
}

function uniqueNumbers(ids: number[]) {
  return Array.from(new Set(ids.filter((id) => Number.isInteger(id))));
}
