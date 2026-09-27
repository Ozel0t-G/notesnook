import { assertBearerDestination } from "@notesnook/core";

export function initiateMultipartRequest(
  url: string,
  headers: Record<string, string>
) {
  assertBearerDestination(headers, url);
  return fetch(url, { headers });
}

export function completeMultipartRequest(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>
) {
  assertBearerDestination(headers, url);
  return fetch(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { ...headers, "Content-Type": "application/json" }
  });
}

export function headFileSizeRequest(url: string, token: string) {
  const headers = { Authorization: `Bearer ${token}` };
  assertBearerDestination(headers, url);
  return fetch(url, { method: "HEAD", headers });
}
