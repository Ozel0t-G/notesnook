# VeyraN sync server NuGet advisory audit

**Date:** 2026-09-27

**Source tree:** `/Users/ozel0t/Documents/VeyraN/veyran-sync-server` (`master`)
**Scope:** Read-only review of the three .NET 9 service restore graphs, source call paths, and the repository's standard `docker-compose.yml`. No image or production host was inspected.

## Method and limits

I ran `dotnet list <project>.csproj package --vulnerable --include-transitive --format json` against `Notesnook.API`, `Streetwriters.Identity`, and `Streetwriters.Messenger` with SDK 9.0.121. NuGet used `https://api.nuget.org/v3/index.json`. I traced dependency parents in each existing `obj/project.assets.json` and inspected source and Compose configuration. All findings below are **restore-graph findings**, not proof that a vulnerable assembly is loaded or that a specific exploit is reachable in a running deployment.

The repository's development Compose file maps `notesnook-server:5264`, `identity-server:8264`, and `sse-server:7264` to host ports and uses prebuilt `streetwriters/*:latest` images. **Production is different:** the VPS uses private source-built images pinned as Sync `veyran/sync:86547b47`, Identity `veyran/identity:19c6c51`, and Events `veyran/sse:a06ecfaa` behind Traefik. The production images were not opened for this package audit, so the exact published assemblies/SBOM and loaded runtime versions remain unconfirmed even though the custom build provenance is known. The service Dockerfiles publish **self-contained, single-file** executables from floating `mcr.microsoft.com/dotnet/sdk:9.0-alpine`; a patched base image alone will not replace runtime bits already bundled into an older published executable.

## Exact advisory inventory

Service codes: **A** = Notesnook API, **I** = Identity, **M** = Messenger/SSE. `Direct` means a project in this repository has an explicit `PackageReference`; all other entries are transitive in the listed service graph. Each bare ID below expands to `https://github.com/advisories/GHSA-<ID>`. NuGet's severity is advisory metadata; practical priority also depends on the code path.

| NuGet package and resolved version | Services | Direct source / transitive parent | GHSA IDs reported by NuGet |
| --- | --- | --- | --- |
| `AngleSharp` 1.3.0 | A | Direct: `Notesnook.API` | `pgww-w46g-26qg` |
| `MailKit` 4.9.0 | A, I, M | Direct: `Streetwriters.Common` and `Streetwriters.Identity` | `9j88-vvj5-vhgr` |
| `MessagePack` 2.5.187 | A | `Microsoft.AspNetCore.SignalR.Protocols.MessagePack` 6.0.3 and `Microsoft.AspNetCore.SignalR.StackExchangeRedis` 9.0.13 | `hv8m-jj95-wg3x`, `vh6j-jc39-fggf`, `2f33-pr97-265q`, `v72x-2h86-7f8m`, `2x83-8g95-xh59`, `cj9g-3mj2-g8vv`, `wfr3-xj75-pfwh`, `w567-gjr2-hm5j`, `cxmj-83gh-fp49`, `q2h6-ghwm-5qm8`, `qhmf-xw27-6rqr` |
| `Microsoft.AspNetCore.Server.Kestrel.Core` 2.2.0 | A | Direct legacy `Microsoft.AspNetCore.Server.Kestrel.Https` 2.2.0 | `5rrx-jjjq-q2r5` |
| `Microsoft.IdentityModel.JsonWebTokens` 6.10.0 / 6.19.0 / 6.7.1 | A / I / M | Authentication dependency graph | `59j7-ghrg-fj52` |
| `MimeKit` 4.9.0 | A, I, M | `MailKit` | `g7hc-96xr-gvvx` |
| `Newtonsoft.Json` 10.0.1 | A, M | WampSharp/Newtonsoft MessagePack dependencies; Identity instead resolves 13.0.1 and has no Newtonsoft advisory | `5crp-9r3c-p9vr` |
| `OpenTelemetry.Api` 1.8.1 | A | OpenTelemetry hosting/exporter packages | `g94r-2vxg-569j` |
| `Scriban` 5.12.1 | A, I, M | Direct: `Streetwriters.Common` | `wgh7-7m3c-fx25`, `grr9-747v-xvcp`, `5rpf-x9jg-8j5p`, `p6q4-fgr8-vx4p`, `x6m9-38vm-2xhf`, `5wr9-m6jw-xx44`, `c875-h985-hvrc`, `v66j-x4hw-fv9g`, `xcx6-vp38-8hr5`, `m2p3-hwv5-xpqw`, `xw6w-9jjh-p9cr`, `24c8-4792-22hx`, `q6rr-fm2g-g5x8`, `7jvp-hj45-2f2m` |
| `SharpCompress` 0.30.1 | A, I, M | MongoDB driver graph | `6c8g-7p36-r338` |
| `Snappier` 1.0.0 | A, I, M | MongoDB driver graph | `pggp-6c3x-2xmx` |
| `System.Drawing.Common` 4.7.0 | A, I | `System.Windows.Extensions` 4.7.0 | `rxg9-xrhp-64gj` |
| `System.IdentityModel.Tokens.Jwt` 6.10.0 / 6.19.0 / 6.7.1 | A / I / M | Authentication dependency graph | `59j7-ghrg-fj52` |
| `System.Net.Http` 4.3.0 | A, I, M | Legacy `NETStandard.Library` 1.6.1 graph | `7jgj-8wvc-jh57` |
| `System.Text.Encodings.Web` 4.5.0 / 4.7.0 / 4.5.0 | A / I / M | ASP.NET Core 2.2 and IdentityModel graph | `ghhp-997w-qr28` |
| `System.Text.RegularExpressions` 4.3.0 | A, I, M | Legacy dependency graph | `cmhx-cq75-c4mj` |
| `AutoMapper` 13.0.1 | I | `IdentityServer4.EntityFramework.Storage` / IdentityServer Mongo graph | `rvv3-g6hj-g44x` |
| `Microsoft.Extensions.Caching.Memory` 6.0.1 | I | EF Core 6.0.0 and `Ng.UserAgentService` | `qj66-m88j-hmgj` |
| `starkbank-ecdsa` 1.3.1 | I | `SendGrid` 9.24.4 | `9wx7-jrvc-28mm`, `j3jw-j2j8-2wv9` |
| `Microsoft.AspNetCore.Authentication.JwtBearer` 5.0.0 | M | Direct: `Streetwriters.Messenger` | `q7cg-43mg-qp69` |

The API reports 16 affected package IDs, Identity 14, and Messenger 12. These counts include duplicate advisories across service graphs; they should not be added to estimate unique vulnerabilities. The API and Identity projects also directly reference JwtBearer 6.0.0, which NuGet did **not** flag with `GHSA-q7cg-43mg-qp69`.

## Reachability and priority

1. **High: API MessagePack deserialization.** `Notesnook.API/Startup.cs` calls `AddMessagePackProtocol()` and maps the authorized WebSocket hub at `/hubs/sync/v2`; the hub accepts client payloads. This is a plausible remotely reachable denial-of-service surface for an authenticated or compromised client. [GHSA-vh6j-jc39-fggf](https://github.com/advisories/GHSA-vh6j-jc39-fggf) documents a depth-check bypass during deserialization and a 2.x fix in 2.5.301. [GHSA-hv8m-jj95-wg3x](https://github.com/advisories/GHSA-hv8m-jj95-wg3x) is another high finding in the same package. Upgrade the SignalR MessagePack dependency set together to versions that resolve every reported advisory, then test existing client wire compatibility and malformed-input handling. An arbitrary direct transitive pin without compatibility testing is unsafe.

2. **High: old web-server and authentication packages.** The API directly references Kestrel HTTPS 2.2.0, which pulls in Kestrel Core 2.2.0 and a critical [HTTP request-smuggling advisory](https://github.com/dotnet/aspnetcore/security/advisories/GHSA-5rrx-jjjq-q2r5). Microsoft describes affected .NET 9 runtimes through 9.0.9 and affected ASP.NET Core 2.x apps using Kestrel Core through 2.3.0. Because this project targets .NET 9, the 2.2.0 restore entry **does not establish** which Kestrel assembly serves requests; inspect the published/runtime version. Remove the legacy HTTPS package if the .NET 9 shared framework supplies the needed API, rebuild with a patched SDK, and verify. Messenger directly references JwtBearer 5.0.0; [GHSA-q7cg-43mg-qp69](https://github.com/advisories/GHSA-q7cg-43mg-qp69) concerns logging an unparseable JWT. Messenger configures JWT authentication and SSE authorization, so update to a compatible supported major and check token validation and logging.

3. **High: email transport.** `Streetwriters.Common/Services/EmailSender.cs` creates `MailKit.Net.Smtp.SmtpClient`, connects with `SecureSocketOptions.Auto`, authenticates, and constructs `MimeKit` messages. Identity calls this service for 2FA, confirmation, password reset, and login alerts. [MailKit GHSA-9j88-vvj5-vhgr](https://github.com/advisories/GHSA-9j88-vvj5-vhgr) is a STARTTLS downgrade issue fixed in 4.16.0; [MimeKit GHSA-g7hc-96xr-gvvx](https://github.com/advisories/GHSA-g7hc-96xr-gvvx) is a mail-address injection issue fixed in 4.15.1. Upgrade MailKit and its MimeKit dependency together; test SMTP/TLS and address validation. The MailKit code is definitely used, while exploitability of the MimeKit issue depends on whether an attacker can supply a malicious envelope address accepted by the application.

4. **Medium to high, configuration dependent: AngleSharp and Scriban.** The API uses AngleSharp to parse and serialize monograph HTML in `MonographsController.SanitizeContentAsync`. The standard Compose config sets `SELF_HOSTED=1`, and that method returns before parsing when self-hosted; this exact vulnerable parser path is therefore bypassed in the standard self-hosted configuration. A non-self-hosted API can reach it through authenticated monograph publish/update, and the [mXSS advisory](https://github.com/advisories/GHSA-pgww-w46g-26qg) is fixed in AngleSharp 1.5.0. `Streetwriters.Common/Services/EmailSender.cs` also invokes Scriban for message subject/body, but the templates observed in `Streetwriters.Identity/Services/TemplatedEmailSender.cs` are static files/strings; client values are render data, not template source. This limits the direct reachability of Scriban's template sandbox and template-driven resource-exhaustion advisories, including the [critical context-reuse finding](https://github.com/advisories/GHSA-5wr9-m6jw-xx44). Update Scriban to a release that clears all 14 findings and regression-test rendered email.

5. **Lower confidence for this application's call paths: transitive libraries.** MongoDB brings `SharpCompress` and `Snappier` into all three graphs. The reported [SharpCompress issue](https://github.com/advisories/GHSA-6c8g-7p36-r338) requires archive extraction via `WriteToDirectory` (fixed in 0.48.0), and the [Snappier issue](https://github.com/advisories/GHSA-pggp-6c3x-2xmx) requires malformed framed data passed to `SnappyStream` (fixed in 1.3.1). No direct calls to those APIs were found in repository source; the MongoDB driver's internal use still needs verification. `starkbank-ecdsa` comes from `SendGrid`, while observed identity email delivery uses MailKit. The [critical signature-verification advisory](https://github.com/advisories/GHSA-j3jw-j2j8-2wv9) is fixed in 1.3.2, but no application call to this verifier was found. Prefer removing unused SendGrid or upgrading its dependency chain. The remaining `System.*`, Newtonsoft, AutoMapper, cache, token, and OpenTelemetry warnings need compatible parent-package upgrades and runtime verification; presence in restore is insufficient to rank their specific exploits as externally reachable.

## Safe remediation sequence

1. Record the existing pinned production image **digests**, self-contained runtime version, and published assembly/SBOM contents for all three services. Compare them to the exact private source commits used in those builds and this restore graph. Do not infer production package versions from the development Compose `:latest` tags.
2. Patch the credible network paths first: API SignalR/MessagePack, API/Messenger ASP.NET authentication and Kestrel packages/runtime, then MailKit/MimeKit. Preserve client protocol compatibility and test authenticated sync, SSE, and email flows.
3. Upgrade AngleSharp, Scriban, MongoDB-related dependencies, and the Identity dependency chain. Prefer updating/removing the parent package responsible for a transitive finding; verify each resolved graph afterward with the same NuGet command. Avoid warning suppression as a substitute for remediation.
4. Rebuild and redeploy the self-contained images from a pinned, patched SDK. Microsoft's [current .NET support policy](https://dotnet.microsoft.com/en-us/platform/support/policy) listed .NET 9 patch 9.0.20 on 2026-09-08 and end of support on 2026-11-10; plan a .NET 10 LTS migration rather than relying indefinitely on .NET 9.

No credentials or environment values were read or reproduced in this report.
