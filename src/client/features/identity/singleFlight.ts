export function createSingleFlight() {
  let active: Promise<unknown> | undefined;
  return Object.freeze({
    run<T>(operation: () => Promise<T>): Promise<T> {
      if (active) return active as Promise<T>;
      const current = (async () => operation())();
      active = current;
      void current.then(
        () => { if (active === current) active = undefined; },
        () => { if (active === current) active = undefined; }
      );
      return current;
    },
    clear() {
      active = undefined;
    }
  });
}
