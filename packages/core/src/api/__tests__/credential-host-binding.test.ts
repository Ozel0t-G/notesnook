import { afterEach, expect, test, vi } from "vitest";
import http from "../../utils/http.js";
import hosts from "../../utils/constants.js";
import Database from "../index.js";
import {
  assertBearerDestination,
  assertCredentialDestination,
  bindCredential
} from "../../utils/credential-host-binding.js";

const original = { api: hosts.API_HOST, auth: hosts.AUTH_HOST };

afterEach(() => {
  hosts.API_HOST = original.api;
  hosts.AUTH_HOST = original.auth;
  vi.unstubAllGlobals();
});

test("an account token cannot be redirected by a later host change", async () => {
  hosts.API_HOST = "https://api.veyran.northcore.space";
  hosts.AUTH_HOST = "https://auth.veyran.northcore.space";
  bindCredential("account-token-host-race", {
    api: hosts.API_HOST,
    auth: hosts.AUTH_HOST
  });
  const send = vi.fn();
  vi.stubGlobal("fetch", send);

  new Database().host({ API_HOST: "https://api.notesnook.com" });
  await expect(
    http.get(`${hosts.API_HOST}/users`, "account-token-host-race")
  ).rejects.toThrow(/Server settings changed/);
  await expect(
    http.post(
      `${hosts.AUTH_HOST}/account/sessions/clear`,
      null,
      "account-token-host-race"
    )
  ).rejects.toThrow(/Server settings changed/);
  expect(send).not.toHaveBeenCalled();
});

test("a bound account token cannot reach an unrelated hosted service", async () => {
  hosts.API_HOST = "https://api.veyran.northcore.space";
  hosts.AUTH_HOST = "https://auth.veyran.northcore.space";
  bindCredential("account-token-upstream", {
    api: hosts.API_HOST,
    auth: hosts.AUTH_HOST
  });
  const send = vi.fn();
  vi.stubGlobal("fetch", send);

  await expect(
    http.get(
      "https://subscriptions.streetwriters.co/account",
      "account-token-upstream"
    )
  ).rejects.toThrow(/Server settings changed/);
  expect(send).not.toHaveBeenCalled();
});

test("an unbound bearer token fails closed before network dispatch", async () => {
  const send = vi.fn();
  vi.stubGlobal("fetch", send);
  await expect(
    http.get("https://api.veyran.northcore.space/users", "unbound-token")
  ).rejects.toThrow(/no verified server binding/);
  expect(send).not.toHaveBeenCalled();
});

test("an explicit server URL trailing slash keeps the same backend identity", () => {
  hosts.API_HOST = "https://api.veyran.northcore.space/";
  hosts.AUTH_HOST = "https://auth.veyran.northcore.space/";
  bindCredential("trailing-slash-token", {
    api: "https://api.veyran.northcore.space",
    auth: "https://auth.veyran.northcore.space"
  });
  expect(() =>
    assertCredentialDestination(
      "trailing-slash-token",
      "https://api.veyran.northcore.space/users"
    )
  ).not.toThrow();
});

test("platform adapters cannot dispatch a bound bearer after a host switch", () => {
  hosts.API_HOST = "https://api.veyran.northcore.space";
  hosts.AUTH_HOST = "https://auth.veyran.northcore.space";
  bindCredential("adapter-file-token", {
    api: hosts.API_HOST,
    auth: hosts.AUTH_HOST
  });
  const headers = { Authorization: "Bearer adapter-file-token" };
  expect(() =>
    assertBearerDestination(headers, `${hosts.API_HOST}/s3/multipart`)
  ).not.toThrow();
  hosts.API_HOST = "https://api.notesnook.com";
  expect(() =>
    assertBearerDestination(headers, `${hosts.API_HOST}/s3/multipart`)
  ).toThrow(/Server settings changed/);
});

test("platform adapters reject absent and unverified bearers", () => {
  expect(() =>
    assertBearerDestination({}, "https://api.veyran.northcore.space/s3")
  ).toThrow(/no verified account credential/);
  expect(() =>
    assertBearerDestination(
      { Authorization: "Bearer unknown-adapter-token" },
      "https://api.veyran.northcore.space/s3"
    )
  ).toThrow(/no verified server binding/);
});
