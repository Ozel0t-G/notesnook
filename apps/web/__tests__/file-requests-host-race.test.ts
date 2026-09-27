import { beforeEach, describe, expect, test, vi } from "vitest";
import axios from "axios";
import {
  completeMultipartRequest,
  headFileSizeRequest,
  initiateMultipartRequest
} from "../src/interfaces/file-requests";

const mocked = vi.hoisted(() => ({
  issuedHost: "https://api.veyran.northcore.space",
  currentHost: "https://api.veyran.northcore.space",
  get: vi.fn(),
  post: vi.fn(),
  head: vi.fn(),
  guard: vi.fn((headers: { Authorization?: string }, url: string) => {
    if (
      headers.Authorization !== "Bearer file-token" ||
      !url.startsWith(`${mocked.issuedHost}/`) ||
      !url.startsWith(`${mocked.currentHost}/`)
    )
      throw new Error(
        "Server settings changed while using account credentials."
      );
  })
}));

vi.mock("@notesnook/core", () => ({
  assertBearerDestination: mocked.guard
}));
vi.mock("axios", () => ({
  default: { get: mocked.get, post: mocked.post, head: mocked.head }
}));

const headers = { Authorization: "Bearer file-token" };
const signal = new AbortController().signal;

beforeEach(() => {
  vi.clearAllMocks();
  mocked.currentHost = mocked.issuedHost;
});

describe("Web file requests keep the issuing backend", () => {
  test("multipart initiation cannot send a bearer after a host switch", () => {
    mocked.currentHost = "https://api.notesnook.com";
    expect(() =>
      initiateMultipartRequest(
        `${mocked.currentHost}/s3/multipart?name=a&parts=2`,
        headers,
        signal
      )
    ).toThrow(/Server settings changed/);
    expect(axios.get).not.toHaveBeenCalled();
  });

  test("multipart completion rechecks after awaited part uploads", () => {
    mocked.currentHost = "https://api.notesnook.com";
    expect(() =>
      completeMultipartRequest(
        `${mocked.currentHost}/s3/multipart`,
        { Key: "a", UploadId: "one" },
        headers,
        signal
      )
    ).toThrow(/Server settings changed/);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test("HEAD cannot use a token against a changed file host", () => {
    mocked.currentHost = "https://api.notesnook.com";
    expect(() =>
      headFileSizeRequest(`${mocked.currentHost}/s3?name=a`, "file-token")
    ).toThrow(/Server settings changed/);
    expect(axios.head).not.toHaveBeenCalled();
  });

  test("unchanged host dispatches the guarded requests", () => {
    initiateMultipartRequest(
      `${mocked.currentHost}/s3/multipart`,
      headers,
      signal
    );
    completeMultipartRequest(
      `${mocked.currentHost}/s3/multipart`,
      {},
      headers,
      signal
    );
    headFileSizeRequest(`${mocked.currentHost}/s3?name=a`, "file-token");
    expect(mocked.guard).toHaveBeenCalledTimes(3);
    expect(axios.get).toHaveBeenCalledOnce();
    expect(axios.post).toHaveBeenCalledOnce();
    expect(axios.head).toHaveBeenCalledOnce();
  });
});
