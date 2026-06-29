export function routeUrl(baseUrl: string, hashRoute: string) {
  const normalizedBase = baseUrl.trim().replace(/\/+$/, "");
  const normalizedRoute = hashRoute.startsWith("#") ? hashRoute : `#${hashRoute.startsWith("/") ? hashRoute : `/${hashRoute}`}`;
  return `${normalizedBase}/${normalizedRoute}`;
}

export function approvalUrl(baseUrl: string, approvalId: number) {
  return routeUrl(baseUrl, `#/approvals/${approvalId}`);
}
