const port = process.env.PORT ?? "8080";
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 2_000);
timer.unref?.();

try {
  const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: controller.signal
  });
  if (!response.ok) process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
