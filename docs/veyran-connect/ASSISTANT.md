# VeyraN Assistant — Mac Catalyst

The assistant is a native Mac Catalyst sidebar and Settings surface. It uses the
official SIWC provider documented in `SIWC.md` and the shared VeyraN Connect
domain adapter. It shows the exact saved snapshot of the current note, lets the
user explicitly request a summary, rephrase or answer, and keeps the response as
an editable in-memory draft until an explicit action is chosen.

## Available workflow

1. The user explicitly signs in or reauthorizes through the system browser. The
   provider validates the registered client, PKCE/state/nonce and verified
   account identity, and stores credentials in the native Keychain.
2. The user selects an actual server-listed model; no model is invented or
   silently substituted. Before sending, the UI identifies the selected note
   context and the user explicitly starts the request.
3. The answer remains an editable draft. The user can save it as a new note,
   append it to the exact reviewed note using its current revision, or create a
   real VeyraN task from the draft. Each action passes through an assistant-owned
   ConnectAdapter with narrow grants, stable operation IDs and revision checks.
4. A write is reported as successful only when the domain adapter confirms
   `local_saved`; conflicts, cancellation, partial streams and provider errors
   preserve the draft and are not described as saved.

The assistant does not read/search the entire collection. Its current context
is one bounded saved-note snapshot; note content is encoded as data and cannot
grant permissions or cause additional tool calls. It does not replace selected
editor text: React Native does not expose the editor selection through a trusted
assistant action contract. It also does not yet run Responses function-calling
loops or persist conversation history. The three explicit write actions above
are implemented; no buttons imply the unsupported operations.

## Access, identity and lifecycle

- No login or inference starts on mount. Sign-in, sign-out and Send are explicit.
- The assistant has its own adapter and grants, scoped to the current account
  and reviewed note. It never borrows MCP pairing credentials.
- Account, lock, logout, migration and current-tab changes synchronously clear
  decrypted preview/draft state and cancel active work. Stale async replies are
  discarded, including account A → B → A and note-tab ABA transitions.
- A changed note is re-read before sending; the user must review the refreshed
  preview and press Send again. Appends require the exact current revision.
- iPhone/iPad report SIWC as unsupported before touching the Keychain, browser
  or note context. The existing mobile app and synchronization remain available.

## Cost notice

The UI says: “Nutzung kann ChatGPT-Kontingent oder vorhandene Credits
verbrauchen. Reine Abo-Nutzung ist nicht garantiert.” This is informative and
does not gate activation. There is no API-key fallback, provider fallback,
credit purchase or automatic refill. The first real inference remains a manual
user action; automated tests use only synthetic fixtures and mocked transport.

## Implementation and validation

Core controller, action and rendered UI tests are under
`apps/mobile/app/services/veyran-assistant/`. They verify explicit send/actions,
reviewed ids/revisions, conflict and cancellation behavior, lifecycle clearing,
and truthful outcomes without real SIWC traffic, Keychain credentials or private
notes. See `RUN-STATUS-2026-10-11.md` for the current platform/build matrix and
the outstanding live pairing step.
