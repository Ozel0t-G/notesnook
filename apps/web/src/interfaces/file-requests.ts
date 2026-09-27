import axios from "axios";
import { assertBearerDestination } from "@notesnook/core";

type BearerHeaders = { Authorization: string };

export function initiateMultipartRequest(
  url: string,
  headers: BearerHeaders,
  signal: AbortSignal
) {
  assertBearerDestination(headers, url);
  return axios.get(url, { headers, signal });
}

export function completeMultipartRequest(
  url: string,
  body: Record<string, unknown>,
  headers: BearerHeaders,
  signal: AbortSignal
) {
  assertBearerDestination(headers, url);
  return axios.post(url, body, { headers, signal });
}

export function headFileSizeRequest(url: string, token: string) {
  const headers = { Authorization: `Bearer ${token}` };
  assertBearerDestination(headers, url);
  return axios.head(url, { headers });
}
