export {};

const mockState = {
  issuedHost: "https://api.veyran.northcore.space",
  currentHost: "https://api.veyran.northcore.space"
};
const mockGuard = jest.fn(
  (headers: { Authorization?: string }, url: string) => {
    if (
      headers.Authorization !== "Bearer file-token" ||
      !url.startsWith(`${mockState.issuedHost}/`) ||
      !url.startsWith(`${mockState.currentHost}/`)
    )
      throw new Error(
        "Server settings changed while using account credentials."
      );
  }
);

jest.mock("@notesnook/core", () => ({ assertBearerDestination: mockGuard }));

const {
  completeMultipartRequest,
  headFileSizeRequest,
  initiateMultipartRequest
} = require("./file-requests") as typeof import("./file-requests");

const headers = { Authorization: "Bearer file-token" };
const send = jest.fn(async () => ({ ok: true }));

beforeEach(() => {
  mockState.currentHost = mockState.issuedHost;
  mockGuard.mockClear();
  send.mockClear();
  global.fetch = send as unknown as typeof fetch;
});

describe("mobile file requests keep the issuing backend", () => {
  test("the Core guard is available", () => {
    expect(require("@notesnook/core").assertBearerDestination).toBe(mockGuard);
  });
  test("multipart initiation cannot redirect a bearer after a host switch", () => {
    mockState.currentHost = "https://api.notesnook.com";
    expect(() =>
      initiateMultipartRequest(
        `${mockState.currentHost}/s3/multipart?name=a&parts=2`,
        headers
      )
    ).toThrow(/Server settings changed/);
    expect(send).not.toHaveBeenCalled();
  });

  test("multipart completion checks again after uploading parts", () => {
    mockState.currentHost = "https://api.notesnook.com";
    expect(() =>
      completeMultipartRequest(
        `${mockState.currentHost}/s3/multipart`,
        { Key: "a", UploadId: "one" },
        headers
      )
    ).toThrow(/Server settings changed/);
    expect(send).not.toHaveBeenCalled();
  });

  test("HEAD cannot use a token against a changed host", () => {
    mockState.currentHost = "https://api.notesnook.com";
    expect(() =>
      headFileSizeRequest(`${mockState.currentHost}/s3?name=a`, "file-token")
    ).toThrow(/Server settings changed/);
    expect(send).not.toHaveBeenCalled();
  });

  test("unchanged host dispatches only after all three guards", () => {
    initiateMultipartRequest(`${mockState.currentHost}/s3/multipart`, headers);
    completeMultipartRequest(
      `${mockState.currentHost}/s3/multipart`,
      {},
      headers
    );
    headFileSizeRequest(`${mockState.currentHost}/s3?name=a`, "file-token");
    expect(mockGuard).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenCalledTimes(3);
  });
});
