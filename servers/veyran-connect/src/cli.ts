/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

/**
 * The operator CLI (bundled `dist/cli.mjs`).
 *
 * Commands are explicit and foreground only:
 *   setup             create the `0700` profile and its `0600` files (idempotent)
 *   export-connection write the app-side connection file (explicit `--out`)
 *   mcp-config        write the caller-only MCP config (MCP credential only)
 *   broker            run the foreground singleton HTTPS broker on the persisted port
 *   inbox-key         store the separate Notesnook Inbox API key (hidden TTY prompt)
 *   status            print a non-secret profile/health report
 *
 * Secrets never appear in argv, the environment, stdout, stderr or a log. An
 * existing profile is **never** silently overwritten or rotated: a
 * partial/corrupt/insecure file fails closed and setup refuses. `teardown` is
 * intentionally absent: see docs/veyran-connect/MCP.md ("teardown never clears
 * a foreign service").
 */
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  brokerCredentialsSchema,
  createCredential,
  type BrokerCredentials
} from "./credentials.js";
import {
  brokerConfigSchema,
  createBrokerId,
  loadBrokerConfig,
  mcpConfigSchema,
  saveBrokerConfig,
  saveConnectionExport,
  saveMcpConfig,
  type BrokerConfig
} from "./config.js";
import { operatorPaths } from "./paths.js";
import {
  assertSecureDir,
  ensureSecureDir,
  InsecureFileError,
  inspectSecureFile,
  readSecureJson,
  writeSecureJsonAtomic
} from "./secure-files.js";
import { INBOX_LIMITS, SERVER_LIMITS } from "./limits.js";
import {
  HiddenPromptError,
  inboxApiKeySchema,
  loadInboxApiKey,
  promptHiddenKey,
  saveInboxApiKey
} from "./inbox-profile.js";
import { Broker } from "./broker.js";
import { createBrokerAuthorizer, createBrokerHttpsServer } from "./https.js";
import { reportDiagnostic } from "./logging.js";
import { attachBroker } from "./attach.js";
import { CertificateError, generateTlsMaterial, validateTlsMaterial } from "./certs.js";
import { BrokerError } from "./errors.js";

const DEFAULT_PORT = 47821;

/** Internal signal: an existing caller config does not match the profile. */
class McpConfigInconsistentError extends Error {
  constructor() {
    super("mcp caller config is inconsistent with the broker profile");
    this.name = "McpConfigInconsistentError";
  }
}

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  let command = "";
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=");
      if (inline !== undefined) flags[key] = inline;
      else if (argv[index + 1] && !argv[index + 1].startsWith("--"))
        flags[key] = argv[++index];
      else flags[key] = true;
    } else if (!command) {
      command = arg;
    }
  }
  return { command, flags };
}

function stringFlag(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(line: string): void {
  process.stderr.write(`${line}\n`);
  process.exitCode = 1;
}

function budgetCredential(): number {
  return SERVER_LIMITS.maxCredentialFileBytes;
}

/** Read a JSON file, returning `undefined` only when it is genuinely absent. */
async function readOptional(file: string, budget: number): Promise<unknown | undefined> {
  try {
    return await readSecureJson<unknown>(file, budget);
  } catch (error) {
    if (error instanceof InsecureFileError && error.reason === "missing") return undefined;
    throw error;
  }
}

function validatePort(value: string | boolean | undefined): number {
  const port = typeof value === "string" ? Number(value) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("invalid_port");
  return port;
}

/** One single bind probe on the chosen port — never a range scan. */
async function probePortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolve(true));
    });
  });
}

async function commandSetup(flags: Record<string, string | boolean>): Promise<void> {
  const paths = operatorPaths(stringFlag(flags.profile));
  await ensureSecureDir(paths.dir);

  let credentials: BrokerCredentials;
  let config: BrokerConfig;
  let createdCredentials = false;
  let createdConfig = false;
  try {
    const rawCredentials = await readOptional(paths.credentials, budgetCredential());
    const rawConfig = await readOptional(paths.config, SERVER_LIMITS.maxConfigFileBytes);

    // A profile is only valid as a *whole*: credentials and config are created
    // together and preserved together. One present without the other is a
    // partial profile and fails closed (never silently completed/rotated).
    if ((rawCredentials === undefined) !== (rawConfig === undefined))
      throw new BrokerError("CONFIG_INVALID");

    if (rawCredentials === undefined) {
      const generated = brokerCredentialsSchema.parse({
        v: 1,
        app: createCredential(),
        mcp: createCredential(),
        tls: await generateTlsMaterial()
      });
      validateTlsMaterial(generated.tls);
      credentials = generated;
      createdCredentials = true;
    } else {
      const parsed = brokerCredentialsSchema.safeParse(rawCredentials);
      if (!parsed.success) throw new BrokerError("CONFIG_INVALID");
      validateTlsMaterial(parsed.data.tls);
      credentials = parsed.data;
    }

    if (rawConfig === undefined) {
      const port = validatePort(flags.port);
      if (!(await probePortAvailable(port))) {
        fail(
          `veyran-connect: the chosen port ${port} is already in use; pass --port <port> to pick another.`
        );
        return;
      }
      config = brokerConfigSchema.parse({
        v: 1,
        brokerId: createBrokerId(),
        port,
        createdAt: Date.now(),
        leafPin: credentials.tls.leafPin
      });
      createdConfig = true;
    } else {
      const parsed = brokerConfigSchema.safeParse(rawConfig);
      if (!parsed.success || parsed.data.leafPin !== credentials.tls.leafPin)
        throw new BrokerError("CONFIG_INVALID");
      config = parsed.data;
    }

    // Caller-only MCP config: MCP credential only, never the app credential. A
    // present-but-inconsistent caller config is preserved (fail closed) and
    // never silently rotated — and it is checked *before* anything is written.
    const rawMcp = await readOptional(paths.mcpConfig, SERVER_LIMITS.maxConfigFileBytes);
    const mcpConfig = {
      v: 1 as const,
      brokerId: config.brokerId,
      port: config.port,
      client: credentials.mcp,
      tls: { rootPem: credentials.tls.rootPem, leafPin: credentials.tls.leafPin }
    };
    if (rawMcp !== undefined) {
      const parsedMcp = mcpConfigSchema.safeParse(rawMcp);
      const consistent =
        parsedMcp.success &&
        parsedMcp.data.brokerId === config.brokerId &&
        parsedMcp.data.port === config.port &&
        parsedMcp.data.client.id === credentials.mcp.id &&
        parsedMcp.data.client.secret === credentials.mcp.secret &&
        parsedMcp.data.tls.leafPin === credentials.tls.leafPin &&
        parsedMcp.data.tls.rootPem === credentials.tls.rootPem;
      if (!consistent) throw new McpConfigInconsistentError();
    }

    // Nothing is written until every check has passed: a rejected profile is
    // left byte-for-byte unchanged.
    if (createdCredentials)
      await writeSecureJsonAtomic(paths.credentials, credentials, budgetCredential());
    if (createdConfig) await saveBrokerConfig(paths.config, config);
    if (rawMcp === undefined) await saveMcpConfig(paths.mcpConfig, mcpConfig);
  } catch (error) {
    // Certificate *generation* failure keeps its specific top-level message.
    if (error instanceof CertificateError) throw error;
    if (error instanceof McpConfigInconsistentError) {
      reportDiagnostic("CONFIG_INVALID");
      fail(
        'veyran-connect: the existing MCP caller config is invalid or inconsistent; refusing to overwrite it. Run "mcp-config" after removing it manually.'
      );
      return;
    }
    reportDiagnostic(
      error instanceof InsecureFileError ? "CONFIG_INSECURE" : "CONFIG_INVALID"
    );
    fail(
      "veyran-connect: the existing profile is corrupt, partial or permission-unsafe; refusing to overwrite it. Remove it manually to recreate."
    );
    return;
  }
  reportDiagnostic(createdCredentials ? "CONFIG_CREATED" : "CONFIG_PRESERVED");

  out(`profile:  ${paths.dir}`);
  out(`port:     ${config.port}`);
  out(
    "files:    broker.credentials.json (0600, both credentials + server TLS key), broker.config.json (0600), mcp.config.json (0600, MCP credential only)"
  );
  out(`next:     run "veyran-connect broker" in the foreground, then start the MCP server.`);
  out(
    `app:      run "veyran-connect export-connection --out <path>" and import that file in the app.`
  );

  if (flags.pair === true || flags.pair === "true") {
    if (!process.stdout.isTTY) {
      reportDiagnostic("PAIRING_REFUSED");
      return;
    }
    reportDiagnostic("PAIRING_DISPLAYED");
    out("");
    out("Pairing (foreground TTY only):");
    out("  1. Run: veyran-connect export-connection --profile <dir> --out <chosen path>");
    out("  2. In the VeyraN app, choose that file from the explicit import picker.");
    out(
      "  3. The app stores it in its own protected container/Keychain; nothing else is shared."
    );
  }
}

/**
 * `inbox-key` — store the operator's **separate** Notesnook Inbox API key.
 *
 * The key is read only from a hidden foreground TTY prompt: it is never an
 * argv flag, never taken from the environment, never echoed (not even as
 * asterisks), never written to stdout/stderr or a log, and never copied into
 * any broker file. An existing valid key is preserved unless `--replace` is
 * passed explicitly; a corrupt/insecure/partial key file is never overwritten.
 */
async function commandInboxKey(
  flags: Record<string, string | boolean>
): Promise<void> {
  const paths = operatorPaths(stringFlag(flags.profile));

  // The key lives *inside* the existing operator profile; this never creates a
  // profile and never touches the broker files.
  try {
    await assertSecureDir(paths.dir);
  } catch {
    reportDiagnostic("INBOX_KEY_REFUSED");
    fail(
      'veyran-connect: the operator profile is missing or permission-unsafe; run "setup" first.'
    );
    return;
  }

  if (flags.key !== undefined) {
    reportDiagnostic("INBOX_KEY_REFUSED");
    fail(
      "veyran-connect: the Inbox API key is never accepted in argv (it would be visible to other processes); it is read only from the hidden prompt."
    );
    return;
  }

  const replace = flags.replace === true || flags.replace === "true";
  const existing = await inspectSecureFile(paths.inboxKey, INBOX_LIMITS.maxKeyFileBytes);
  if (!existing.ok && existing.reason !== "missing") {
    reportDiagnostic(
      existing.reason === "insecure_mode" ||
        existing.reason === "is_symlink" ||
        existing.reason === "foreign_owner"
        ? "CONFIG_INSECURE"
        : "CONFIG_INVALID"
    );
    fail(
      `veyran-connect: the existing inbox key file is not usable (${existing.reason}); refusing to overwrite it. Remove it manually to recreate.`
    );
    return;
  }
  if (existing.ok) {
    // A file that is merely present is not enough: it must *be* a valid key
    // document. A corrupt one is never silently replaced, with or without
    // `--replace` (the same fail-closed rule `setup` applies to a partial
    // profile).
    try {
      await loadInboxApiKey(paths.inboxKey);
    } catch {
      reportDiagnostic("CONFIG_INVALID");
      fail(
        "veyran-connect: the existing inbox key file is invalid; refusing to overwrite it. Remove it manually to recreate."
      );
      return;
    }
    if (!replace) {
      reportDiagnostic("INBOX_KEY_PRESERVED");
      fail(
        `veyran-connect: an inbox API key is already configured at ${paths.inboxKey}; pass --replace to set a new one.`
      );
      return;
    }
  }

  let entered: string;
  try {
    entered = await promptHiddenKey(
      { input: process.stdin, output: process.stderr },
      "Notesnook Inbox API key (input hidden, Enter to confirm): "
    );
  } catch (error) {
    reportDiagnostic("INBOX_KEY_REFUSED");
    const reason =
      error instanceof HiddenPromptError && error.reason === "aborted"
        ? "the prompt was aborted"
        : "a foreground TTY is required (the key is never piped in)";
    fail(`veyran-connect: ${reason}; nothing was written.`);
    return;
  }

  const parsed = inboxApiKeySchema.safeParse(entered);
  if (!parsed.success) {
    reportDiagnostic("INBOX_KEY_REFUSED");
    fail(
      "veyran-connect: the entered key is not a valid Inbox API key (printable ASCII without spaces, 16-1024 characters); nothing was written."
    );
    return;
  }

  await saveInboxApiKey(paths.inboxKey, parsed.data);
  reportDiagnostic("INBOX_KEY_WRITTEN");
  out(`wrote inbox API key file (0600): ${paths.inboxKey}`);
  out(
    "next:     the capture_note tool sends to https://inbox.notesnook.com/ only when the user explicitly asks."
  );
}

async function loadProfile(
  profileDir: string | undefined
): Promise<{ credentials: BrokerCredentials; config: BrokerConfig } | undefined> {
  const paths = operatorPaths(profileDir);
  try {
    const raw = await readSecureJson<unknown>(paths.credentials, budgetCredential());
    const credentials = brokerCredentialsSchema.parse(raw);
    validateTlsMaterial(credentials.tls);
    const config = await loadBrokerConfig(paths.config);
    if (config.leafPin !== credentials.tls.leafPin) throw new BrokerError("CONFIG_INVALID");
    return { credentials, config };
  } catch {
    return undefined;
  }
}

async function commandExportConnection(
  flags: Record<string, string | boolean>
): Promise<void> {
  const destination = stringFlag(flags.out);
  if (!destination) {
    reportDiagnostic("CONNECTION_EXPORT_REFUSED");
    fail(
      "veyran-connect: export-connection requires an explicit --out <path> (user-selected)."
    );
    return;
  }
  const profile = await loadProfile(stringFlag(flags.profile));
  if (!profile) {
    fail('veyran-connect: profile is missing or invalid; run "setup" first.');
    return;
  }
  await saveConnectionExport(destination, {
    v: 1,
    service: "veyran-connect",
    brokerId: profile.config.brokerId,
    port: profile.config.port,
    app: profile.credentials.app,
    tls: {
      rootPem: profile.credentials.tls.rootPem,
      leafPin: profile.credentials.tls.leafPin
    }
  });
  reportDiagnostic("CONNECTION_EXPORTED");
  out(`wrote app connection file (0600): ${destination}`);
}

async function commandMcpConfig(
  flags: Record<string, string | boolean>
): Promise<void> {
  const paths = operatorPaths(stringFlag(flags.profile));
  const profile = await loadProfile(stringFlag(flags.profile));
  if (!profile) {
    fail('veyran-connect: profile is missing or invalid; run "setup" first.');
    return;
  }
  await saveMcpConfig(paths.mcpConfig, {
    v: 1,
    brokerId: profile.config.brokerId,
    port: profile.config.port,
    client: profile.credentials.mcp,
    tls: {
      rootPem: profile.credentials.tls.rootPem,
      leafPin: profile.credentials.tls.leafPin
    }
  });
  out(`wrote caller-only MCP config (0600): ${paths.mcpConfig}`);
}

async function commandBroker(
  flags: Record<string, string | boolean>
): Promise<void> {
  const profile = await loadProfile(stringFlag(flags.profile));
  if (!profile) {
    reportDiagnostic("CONFIG_INVALID");
    fail('veyran-connect: profile is missing or invalid; run "setup" first.');
    return;
  }
  const { credentials, config } = profile;
  const broker = new Broker({
    port: config.port,
    brokerId: config.brokerId,
    credentials
  });
  const server = createBrokerHttpsServer({
    port: config.port,
    tls: credentials.tls,
    // Edge authentication before any body is read: constant-time role check
    // built from the broker's own two credentials.
    authorizePreamble: createBrokerAuthorizer(credentials),
    dispatch: (route, authorization, body) =>
      broker.dispatch(route, authorization, body)
  });
  server.on("error", () => {
    reportDiagnostic("BROKER_BIND_FAILED");
    fail(
      `veyran-connect: could not bind 127.0.0.1:${config.port}; another process owns it. Failing closed (no takeover, no port scan).`
    );
  });
  server.listen(config.port, "127.0.0.1", () => {
    reportDiagnostic("BROKER_LISTENING");
    out(`broker listening on https://127.0.0.1:${config.port} (foreground; Ctrl-C to stop)`);
  });
  const shutdown = (): void => {
    reportDiagnostic("CLI_STOP");
    broker.close();
    server.close(() => {
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function commandStatus(flags: Record<string, string | boolean>): Promise<void> {
  const paths = operatorPaths(stringFlag(flags.profile));
  const credentialsFile = await inspectSecureFile(
    paths.credentials,
    budgetCredential()
  );
  const configFile = await inspectSecureFile(paths.config, SERVER_LIMITS.maxConfigFileBytes);
  const mcpFile = await inspectSecureFile(paths.mcpConfig, SERVER_LIMITS.maxConfigFileBytes);
  // Non-secret states only: whether the optional Inbox key file exists and is
  // permission-safe. The key itself is never read here, let alone printed.
  const inboxKeyFile = await inspectSecureFile(paths.inboxKey, INBOX_LIMITS.maxKeyFileBytes);
  const attached = await attachBroker(stringFlag(flags.profile)).catch(() => ({
    ok: false as const,
    code: "BROKER_UNAVAILABLE" as const
  }));
  const report = {
    profile: paths.dir,
    files: {
      credentials: credentialsFile.ok ? "ok" : credentialsFile.reason,
      config: configFile.ok ? "ok" : configFile.reason,
      mcpConfig: mcpFile.ok ? "ok" : mcpFile.reason,
      inboxKey: inboxKeyFile.ok ? "ok" : inboxKeyFile.reason
    },
    broker: attached.ok ? "reachable" : "unavailable"
  };
  out(JSON.stringify(report, null, 2));
}

export async function main(
  argv: readonly string[] = process.argv.slice(2)
): Promise<void> {
  const { command, flags } = parseArgs(argv);
  switch (command) {
    case "setup":
      reportDiagnostic("CLI_START");
      await commandSetup(flags).catch((error: unknown) => {
        if (error instanceof CertificateError || error instanceof BrokerError) {
          reportDiagnostic("CONFIG_INVALID");
          fail(
            "veyran-connect: could not create a valid profile (certificate generation or validation failed)."
          );
          return;
        }
        throw error;
      });
      return;
    case "export-connection":
      await commandExportConnection(flags);
      return;
    case "mcp-config":
      await commandMcpConfig(flags);
      return;
    case "broker":
      reportDiagnostic("CLI_START");
      await commandBroker(flags);
      return;
    case "inbox-key":
      reportDiagnostic("CLI_START");
      await commandInboxKey(flags);
      return;
    case "status":
      await commandStatus(flags);
      return;
    default:
      out("usage: veyran-connect <setup|export-connection|mcp-config|broker|inbox-key|status> [--profile <dir>]");
      out("  setup             create the 0700 profile and 0600 files (idempotent)");
      out("  export-connection --out <path>   write the app-side connection file");
      out("  mcp-config        write the caller-only MCP config");
      out("  broker            run the foreground singleton HTTPS broker");
      out("  inbox-key         store the Notesnook Inbox API key (hidden TTY prompt, no argv)");
      out("  status            print a non-secret profile/health report");
      if (!command) process.exitCode = 1;
  }
}

// Run only when this module is the process entry point (bundled `cli.mjs`), so
// importing the module for tests never executes the CLI.
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isEntryPoint()) void main();
