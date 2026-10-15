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
 * The headless VeyraN Assistant controller (Slice 1).
 *
 * Every rule that matters is enforced here, against injected dependencies, so
 * the same code path is exercised by the app and by a headless test with a
 * synthetic transport and synthetic notes:
 *
 *  - **explicit-send-only inference**: `mount()`, model selection and the
 *    context preview are pure reads; only an explicit `send()` starts exactly
 *    one stream. There is no implicit retry.
 *  - **generation fencing**: every operation captures a generation + the host
 *    identity + the persisted account and revalidates all three after each
 *    await, so a late status/model/result from an A -> B -> A account or a
 *    (re)mount can never land.
 *  - **exact snapshot**: the preview is exactly the `get_note` result Core
 *    returned for the current tab note (title, content, revision); it is
 *    revalidated to still be the current tab note before and during a Send.
 *  - **RAM-only draft**: the answer draft lives in memory only, is editable,
 *    survives cancel/error/partial (never reported as success) and is cleared
 *    on lock/logout/account change/unmount. Nothing is persisted.
 *  - **no invented catalog / no default model**: models come only from the
 *    provider catalog and a stale selection is cleared, never defaulted.
 */

import {
  beginAuthErrorCode,
  errorNotice,
  modelsErrorNotice
} from "../veyran-siwc/helpers";
import {
  assistantActionErrorNotice,
  buildAssistantInput,
  isNoteDraftSavable,
  isSendable,
  isTaskDraftSavable,
  normalizeAssistantTaskTitle,
  verifiedAssistantIdentity
} from "./helpers";
import {
  ASSISTANT_INSTRUCTIONS,
  ASSISTANT_UNSUPPORTED_INFO,
  offersVeyranSignIn,
  type AssistantAction,
  type AssistantAuthEvent,
  type AssistantAuthMode,
  type AssistantDeps,
  type AssistantHostIdentity,
  type AssistantKind,
  type AssistantModelCatalog,
  type AssistantSavedResult,
  type AssistantState,
  type AssistantStreamEmission,
  type AssistantStreamResult,
  type AssistantWriteOutcome,
  type SIWCStatusSummary
} from "./types";

function emptyState(info: string): AssistantState {
  return {
    authStarting: false,
    platformSupported: true,
    blockedReason: undefined,
    status: undefined,
    identity: {},
    models: [],
    modelsLoading: false,
    modelsError: undefined,
    selectedModel: undefined,
    kind: "summary",
    question: "",
    preview: undefined,
    draft: "",
    streaming: false,
    actionBusy: false,
    lastSaved: undefined,
    actionError: undefined,
    error: undefined,
    info
  };
}

/**
 * A usable catalog row: a non-empty slug and a textual display name. Mirrors the
 * SIWC-side predicate so an injected/malformed row can never reach the UI.
 */
function isUsableAssistantModel(model: unknown): model is {
  slug: string;
  displayName: string;
} {
  if (!model || typeof model !== "object") return false;
  const { slug, displayName } = model as {
    slug?: unknown;
    displayName?: unknown;
  };
  return (
    typeof slug === "string" &&
    /^[A-Za-z0-9_./:-]{1,200}$/.test(slug) &&
    typeof displayName === "string" &&
    displayName.trim().length > 0 &&
    displayName.length <= 200
  );
}

/** The immutable per-invocation capture of one explicit write action. */
type WriteCapture = {
  accountId: string;
  identity: AssistantHostIdentity;
  /** Only ever a *verified* non-empty subject. */
  subject: string;
  /** Only ever a *verified* non-empty issued client id. */
  clientId: string;
  writeToken: number;
  draft: string;
};

export class VeyranAssistantController {
  private readonly deps: AssistantDeps;
  private state: AssistantState;
  private readonly listeners = new Set<() => void>();
  /** Bumped at every lifecycle seam; captured by every in-flight operation. */
  private generation = 0;
  /** Bumped for every stream invocation; only the exact owner may finalize. */
  private streamToken = 0;
  private mounted = false;
  /** True while an explicit Send is being preflighted (one stream per press). */
  private sending = false;
  /** True while an explicit provider sign-in is pending (one flow per press). */
  private authInFlight = false;
  private authToken = 0;
  private authCancelPending = false;
  private authCancelBarrier: Promise<void> = Promise.resolve();
  /** One explicit write action at a time (a second press is ignored). */
  private actionBusy = false;
  /**
   * Bumped at every lifecycle seam (lock/logout/account change/migration/
   * unmount) so an in-flight write captured before the seam can never report a
   * result afterwards. A mere current-tab change does not bump it: a note write
   * is bound to the captured note id/revision and the adapter's own predicate
   * fences the tab, while a create is note-independent.
   */
  private writeToken = 0;
  /**
   * The idempotency id cached for the exact current write capture. The same
   * capture (same action, target, expected revision and draft bytes) reuses the
   * same id — the adapter journal then replays instead of writing twice, so a
   * duplicate press can never create a duplicate record. A changed capture gets
   * a fresh id, so a genuinely new action is never suppressed.
   */
  private actionOperation?: { key: string; id: string };
  /**
   * The in-flight native cancel. The native `cancelStream` is process-global
   * (it carries no request id), so a newer stream must never start while an
   * older cancel is still running — the old cancel would kill the new stream.
   * Every cancel chains on this promise; `send` waits on it before it starts a
   * stream, and `canSend` stays disabled while it is unsettled.
   */
  private cancelBarrier: Promise<void> = Promise.resolve();
  /** True while `cancelBarrier` has not settled yet. */
  private cancelInFlight = false;
  /**
   * The monotonic ownership token of the newest catalog read.
   *
   * Every catalog read (an explicit reload, the read that follows a status
   * refresh, or a lifecycle seam) captures this token and may only apply its
   * result while it is still the newest. A slow same-account response can
   * therefore never overwrite a newer catalog (or a newer error), and every
   * account lifecycle seam (lock/logout/account change/revocation) bumps
   * it so an in-flight read from the previous account/mount is dropped instead
   * of landing. A current-note change preserves this account-owned request.
   */
  private catalogToken = 0;
  /** The single in-flight explicit reload (repeated presses coalesce). */
  private reloadInFlight?: Promise<void>;

  constructor(deps: AssistantDeps) {
    this.deps = deps;
    this.state = emptyState(deps.mobileUnavailableCopy());
  }

  // ---------------------------------------------------------------- store API

  getState = (): AssistantState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setState(patch: Partial<AssistantState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  // ------------------------------------------------------------------ helpers

  /**
   * True only while this exact capture is still current: the same controller
   * generation, the same host identity and the same eligible persisted account.
   * Synchronous, so it is also usable as the adapter ownership predicate.
   */
  private isCaptureCurrent(
    generation: number,
    accountId: string,
    identity: { hostUUID: string; epoch: number }
  ): boolean {
    if (!this.mounted) return false;
    if (generation !== this.generation) return false;
    if (!this.deps.isHostIdentityCurrent(identity)) return false;
    const eligibility = this.deps.eligibility();
    return eligibility.eligible && eligibility.accountId === accountId;
  }

  /**
   * The one verified identity comparison. Only a *validated* non-empty
   * subject+clientId pair counts: both the captured pair and the current state
   * pair must verify, so two missing/malformed pairs can never compare equal.
   * A missing identity therefore denies — it never implicitly matches.
   */
  private identityMatches(
    subject: string | undefined,
    clientId: string | undefined
  ): boolean {
    const captured = verifiedAssistantIdentity({ subject, clientId });
    if (!captured) return false;
    const current = verifiedAssistantIdentity(this.state.identity);
    if (!current) return false;
    return (
      captured.subject === current.subject &&
      captured.clientId === current.clientId
    );
  }

  /**
   * The full inference-ownership proof: the capture is current *and* the state
   * still carries a live direct grant *and* a verified `subject`/`clientId` that
   * are the exact ones captured. A revocation, a re-authorization to a
   * different subject (same host/account), a lost identity or a late result is
   * therefore never adopted.
   */
  private ownsInference(
    generation: number,
    accountId: string,
    identity: { hostUUID: string; epoch: number },
    subject: string | undefined,
    clientId: string | undefined
  ): boolean {
    if (!this.isCaptureCurrent(generation, accountId, identity)) return false;
    if (!this.canInvokeState()) return false;
    return this.identityMatches(subject, clientId);
  }

  /**
   * The shared eligibility gate for inference, Send and every write action. It
   * requires the live direct grant *and* a verified identity: a status that
   * omits/blanks the subject or clientId can never authorize anything.
   */
  private canInvokeState(): boolean {
    if (!this.state.status || !this.deps.canInvoke(this.state.status))
      return false;
    return !!verifiedAssistantIdentity(this.state.identity);
  }

  /**
   * Serialize the process-global native cancel behind one barrier. Every cancel
   * chains on the previous one, so two native cancels can never overlap (an
   * older cancel must never run after a newer stream started). The returned
   * promise always settles, never rejects: a rejected native cancel can neither
   * surface a raw error nor wedge the UI. The in-flight flag clears only for the
   * newest barrier.
   */
  private beginCancel(): Promise<void> {
    if (!this.state.platformSupported) return Promise.resolve();
    // A lone cancel starts the native call *eagerly* (a synchronous seam keeps
    // its synchronous native cancel); only an overlapping cancel is deferred
    // behind the in-flight barrier so two native cancels can never overlap.
    const overlapping = this.cancelInFlight;
    this.cancelInFlight = true;
    let invocation: Promise<void>;
    if (overlapping) {
      invocation = this.cancelBarrier
        .catch(() => {})
        .then(() => this.deps.cancelStream());
    } else {
      try {
        invocation = this.deps.cancelStream();
      } catch {
        invocation = Promise.resolve();
      }
    }
    const settled = invocation
      .catch(() => {})
      .then(() => {
        if (this.cancelBarrier === settled) {
          this.cancelInFlight = false;
          // Re-render so a disabled Send re-evaluates once the barrier clears.
          this.setState({});
        }
      });
    this.cancelBarrier = settled;
    return settled;
  }

  // --------------------------------------------------------------- lifecycle

  /**
   * Bind the controller to a mounted surface. On an unsupported platform it
   * only records the informational state and reads nothing (no status, no
   * catalog, no note context, no credential path).
   */
  mount(): void {
    this.mounted = true;
    if (!this.deps.isPlatformSupported()) {
      this.setState({
        platformSupported: false,
        blockedReason: "unsupported_platform",
        info: this.deps.mobileUnavailableCopy() || ASSISTANT_UNSUPPORTED_INFO
      });
      return;
    }
    this.setState({ platformSupported: true });
    void this.refreshStatus();
  }

  unmount(): void {
    this.mounted = false;
    this.invalidate();
    this.setState({ streaming: false });
  }

  /**
   * A lifecycle seam (lock, logout, account change, app loading/migration):
   * invalidate every in-flight operation, drop the previous account's model
   * selection/preview and clear the RAM-only draft. No draft may survive an
   * account change or a lock.
   */
  onLifecycleChange(): void {
    // Before the surface is mounted there is nothing live to invalidate (and an
    // unsupported platform must not reach the provider at all).
    if (!this.mounted) return;
    this.invalidate();
    if (!this.state.platformSupported) return;
    void this.refreshStatus();
  }

  /**
   * A narrower context seam (current-tab change): cancel the in-flight stream,
   * bump the ownership generation so a late read/status cannot land, and drop
   * the previous tab's preview and draft. The verified status/catalog are kept
   * (they are account-scoped, not note-scoped) so the panel does not blank out.
   */
  onContextChange(): void {
    if (!this.mounted) return;
    this.generation += 1;
    this.streamToken += 1;
    // The catalog belongs to the verified account, not to the current note.
    // A note change must not discard a pending model response or permit a
    // second reload while that account's first reload is still pending.
    if (this.state.platformSupported) {
      void this.beginCancel();
    }
    this.setState({
      preview: undefined,
      draft: "",
      streaming: false,
      actionError: undefined,
      lastSaved: undefined,
      error: undefined
    });
  }

  private invalidate(): void {
    this.authToken += 1;
    this.generation += 1;
    this.streamToken += 1;
    this.writeToken += 1;
    this.catalogToken += 1;
    this.reloadInFlight = undefined;
    // The pending sign-in belongs to the invalidated generation: its late
    // result must neither set `authenticating` nor hold the single-flight guard
    // open forever.
    this.authInFlight = false;
    // Fire-and-forget: a synchronous seam must never await the native cancel.
    // The barrier keeps a later Send from starting while it is in flight. Never
    // reached on an unsupported platform (no native provider call).
    if (this.state.platformSupported) {
      void this.beginCancel();
    }
    this.setState({
      blockedReason: undefined,
      status: undefined,
      identity: {},
      authStarting: false,
      models: [],
      modelsLoading: false,
      modelsError: undefined,
      selectedModel: undefined,
      preview: undefined,
      draft: "",
      streaming: false,
      actionError: undefined,
      lastSaved: undefined,
      error: undefined
    });
  }

  /**
   * Drop every account-scoped and note-scoped value on a revocation or an
   * identity change: cancel the stream, invalidate in-flight captures, clear
   * the catalog/selection/preview and wipe the RAM-only draft.
   */
  private dropForRevocation(summary?: SIWCStatusSummary): void {
    this.authToken += 1;
    this.generation += 1;
    this.streamToken += 1;
    this.writeToken += 1;
    // A revocation/identity change supersedes every in-flight catalog read: an
    // old result must never re-populate the dropped account's model list.
    this.catalogToken += 1;
    this.reloadInFlight = undefined;
    // Same rule as `invalidate`: a pending sign-in from the dropped account is
    // superseded and must not keep the single-flight guard held.
    this.authInFlight = false;
    if (this.state.platformSupported) {
      void this.beginCancel();
    }
    // Only a verified identity is ever stored: a summary that omits/blanks the
    // subject or clientId (or is signed out) leaves the identity empty (fail
    // closed).
    const identity =
      summary && summary.signedIn
        ? verifiedAssistantIdentity(summary) ?? {}
        : {};
    this.setState({
      blockedReason: undefined,
      status: summary,
      identity,
      authStarting: false,
      models: [],
      modelsLoading: false,
      modelsError: undefined,
      selectedModel: undefined,
      preview: undefined,
      draft: "",
      streaming: false,
      actionError: undefined,
      lastSaved: undefined
    });
  }

  // ------------------------------------------------------------------ status

  /**
   * Read the authoritative SIWC status for the persisted account. Read-only:
   * it never opens an auth flow and never touches the Keychain beyond the
   * status read the provider already gates.
   */
  async refreshStatus(): Promise<void> {
    if (!this.mounted || !this.state.platformSupported) return;
    const eligibility = this.deps.eligibility();
    if (!eligibility.eligible || !eligibility.accountId) {
      // Signed out / locked / loading: a truthful signed-out state, and nothing
      // from a previous account survives — cancel any stream and clear it all.
      this.dropForRevocation(undefined);
      // The host block is terminal for this read: record the exact bounded
      // reason so the UI shows a truthful state instead of "checking" forever.
      this.setState({ blockedReason: eligibility.reason ?? "unknown" });
      return;
    }
    // Eligible again: never carry a previous block reason forward.
    if (this.state.blockedReason !== undefined) {
      this.setState({ blockedReason: undefined });
    }
    const accountId = eligibility.accountId;
    const generation = this.generation;
    const identity = this.deps.hostIdentity();
    const previousIdentity = verifiedAssistantIdentity(this.state.identity);
    const previousIdentityKey = previousIdentity
      ? this.identityKeyOf(previousIdentity)
      : undefined;

    const summary = await this.deps.status(accountId);
    if (!this.isCaptureCurrent(generation, accountId, identity)) return;

    const canInvoke = this.deps.canInvoke(summary);
    // A ready status without a *verified* subject/clientId is not an identity:
    // it can never authorize inference or a write.
    const nextIdentity = summary
      ? verifiedAssistantIdentity(summary)
      : undefined;
    const nextIdentityKey = nextIdentity
      ? this.identityKeyOf(nextIdentity)
      : undefined;
    const identityChanged = nextIdentityKey !== previousIdentityKey;
    // Establishing an identity for the first time is not a revocation; losing a
    // previously verified identity (or a disconnected account) is.
    const lostIdentity = !!previousIdentity && identityChanged;

    if (!canInvoke || !nextIdentity || lostIdentity) {
      // Revoked direct grant, a missing/unverified identity or a different
      // subject/clientId: cancel the stream, clear the catalog/selection/preview
      // and wipe the RAM-only draft.
      this.dropForRevocation(summary);
      return;
    }

    this.setState({ status: summary, identity: nextIdentity });
    await this.loadModels();
  }

  private identityKeyOf(identity: {
    subject?: string;
    clientId?: string;
  }): string {
    return `${identity.subject ?? ""}\u0000${identity.clientId ?? ""}`;
  }

  // ------------------------------------------------------------------ catalog

  /**
   * Read the live catalog. Never invents a default and never infers.
   *
   * The read is *monotonically owned*: it captures the current catalog token and
   * only applies its outcome while it is still the newest read **and** the full
   * account ownership (host + account + verified subject/clientId + live direct
   * grant) still holds. A superseded or revoked read is dropped.
   *
   * A real failure is stored as a bounded `modelsError` (with a previous,
   * still-valid catalog and the RAM-only draft/reviewed preview preserved); a
   * legitimately empty catalog clears `modelsError` and is shown as an
   * authenticated empty state. A rejected injected/native promise is caught and
   * mapped to a bounded static error — never a raw message.
   */
  async loadModels(): Promise<void> {
    if (!this.mounted || !this.state.platformSupported) return;
    const eligibility = this.deps.eligibility();
    // Fail closed on a missing/unverified identity: no catalog read happens
    // without a verified subject/clientId.
    if (
      !eligibility.eligible ||
      !eligibility.accountId ||
      !this.canInvokeState()
    ) {
      this.dropForRevocation(undefined);
      return;
    }
    const accountId = eligibility.accountId;
    const identity = this.deps.hostIdentity();
    const verified = verifiedAssistantIdentity(this.state.identity);
    if (!verified) return;
    const subject = verified.subject;
    const clientId = verified.clientId;

    const token = ++this.catalogToken;
    this.setState({ modelsLoading: true, modelsError: undefined });

    let outcome: AssistantModelCatalog | undefined;
    try {
      outcome = await this.deps.models(accountId);
    } catch {
      // A rejected injected/native promise: a bounded static failure, never a
      // raw exception. The catalog stays as it was.
      outcome = { ok: false, error: modelsErrorNotice(undefined) };
    }

    // Only the newest read that still owns the capture may apply its outcome.
    if (token !== this.catalogToken) return;
    const live = this.deps.eligibility();
    if (!this.mounted || !this.deps.isHostIdentityCurrent(identity) ||
      !live.eligible || live.accountId !== accountId ||
      !this.canInvokeState() || !this.identityMatches(subject, clientId)) {
      // No lifecycle notification is required to revoke an obsolete capture.
      // Clear account-bound data as well as loading; never expose the previous
      // identity's catalog or context to the now-current account.
      this.dropForRevocation(undefined);
      return;
    }

    if (!outcome || outcome.ok !== true) {
      // The injected outcome is untrusted: only its bounded static code is
      // mapped through the allowlist, so a raw injected/native message can
      // never reach the UI. A malformed `ok:false` (or a rejection, mapped to
      // `outcome` above) collapses to the fixed `catalog_unavailable` notice.
      const error =
        outcome && outcome.ok === false && outcome.error
          ? modelsErrorNotice(outcome.error)
          : modelsErrorNotice(undefined);
      // Fail closed on the catalog, but keep the RAM-only draft and the exact
      // reviewed preview: an ordinary metadata failure must not discard the
      // user's reviewed context. `models`/`selectedModel` are left untouched
      // (a previously loaded catalog is still the actual one for this account).
      this.setState({ modelsLoading: false, modelsError: error });
      return;
    }

    // A malformed injected success (a missing/non-array `models`) is a bounded
    // failure — never a throw and never an invented empty catalog.
    if (!Array.isArray(outcome.models) || outcome.models.length > 512 ||
      !outcome.models.every(isUsableAssistantModel)) {
      this.setState({
        modelsLoading: false,
        modelsError: modelsErrorNotice(undefined)
      });
      return;
    }

    const models = outcome.models;
    const slugs = new Set(models.map((model) => model.slug));
    const selected = this.state.selectedModel;
    this.setState({
      modelsLoading: false,
      modelsError: undefined,
      models,
      selectedModel: selected && slugs.has(selected) ? selected : undefined
    });
  }

  /**
   * The explicit, human-initiated "Modelle neu laden" control.
   *
   * It performs the same read-only catalog fetch as `refreshStatus` — no
   * inference, no write, no auth flow. Repeated presses while a reload is still
   * in flight are coalesced into the single in-flight read (singleflight), so a
   * click burst can never fan out into multiple native calls. A newer read (this
   * reload, or a later status refresh) always supersedes an older one through the
   * monotonic catalog token.
   */
  async reloadModels(): Promise<void> {
    if (!this.mounted || !this.state.platformSupported) return;
    if (this.reloadInFlight) return this.reloadInFlight;
    const run = this.loadModels().finally(() => {
      if (this.reloadInFlight === run) this.reloadInFlight = undefined;
    });
    this.reloadInFlight = run;
    return run;
  }

  /** Explicit human selection from the actual catalog only. No inference. */
  selectModel(slug: string | undefined): void {
    if (slug === undefined) {
      this.setState({ selectedModel: undefined });
      return;
    }
    if (!this.state.models.some((model) => model.slug === slug)) return;
    this.setState({ selectedModel: slug, error: undefined });
  }

  // ------------------------------------------------------------------ preview

  /**
   * Read the exact saved snapshot for the actual current tab note through one
   * bounded `get_note`. Read-only; never writes and never uploads a collection.
   */
  async loadPreview(): Promise<void> {
    if (!this.mounted || !this.state.platformSupported) return;
    const eligibility = this.deps.eligibility();
    // Fail closed on a missing/unverified identity: no note read happens
    // without a verified subject/clientId.
    if (
      !eligibility.eligible ||
      !eligibility.accountId ||
      !this.canInvokeState()
    ) {
      return;
    }
    const accountId = eligibility.accountId;
    const noteId = this.deps.currentNoteId();
    if (!noteId) {
      this.setState({ preview: undefined });
      return;
    }
    const generation = this.generation;
    const identity = this.deps.hostIdentity();
    const verified = verifiedAssistantIdentity(this.state.identity);
    if (!verified) return;
    const subject = verified.subject;
    const clientId = verified.clientId;

    const read = await this.deps.readNote(accountId, noteId, () => {
      // The trusted, synchronous ownership predicate. A stale generation, a
      // changed host identity, a revoked grant, a different verified
      // subject/clientId or a different current tab note throws and the read is
      // denied by the adapter.
      if (!this.ownsInference(generation, accountId, identity, subject, clientId)) {
        throw new Error("assistant_stale");
      }
      if (this.deps.currentNoteId() !== noteId) {
        throw new Error("assistant_note_changed");
      }
    });

    if (!this.ownsInference(generation, accountId, identity, subject, clientId))
      return;
    if (this.deps.currentNoteId() !== noteId) return;
    if (!read || read.noteId !== noteId) {
      this.setState({ preview: undefined });
      return;
    }
    this.setState({ preview: read, error: undefined });
  }

  // ------------------------------------------------------------------- edits

  setKind(kind: AssistantKind): void {
    this.setState({ kind });
  }

  setQuestion(question: string): void {
    this.setState({ question });
  }

  /** Edit the RAM-only answer draft. Never persisted anywhere. */
  setDraft(draft: string): void {
    this.setState({ draft });
  }

  // ------------------------------------------------------------------ send

  /** True only when an explicit Send would start a stream right now. */
  canSend(): boolean {
    if (!this.mounted || !this.state.platformSupported) return false;
    if (this.state.streaming) return false;
    if (this.sending) return false;
    if (this.actionBusy) return false;
    // The native cancel is global: Send stays disabled until it has settled, so
    // a rapid next stream can never be killed by a previous cancel.
    if (this.cancelInFlight) return false;
    if (!this.canInvokeState()) return false;
    // A catalog read still in flight, or a catalog that failed, blocks a Send:
    // the user must wait for (or reload) the truthful catalog state instead of
    // inferring against a model that may no longer be authorized. The RAM-only
    // draft and the reviewed preview are preserved across such a failure.
    if (this.state.modelsLoading) return false;
    if (this.state.modelsError) return false;
    if (!this.state.selectedModel) return false;
    const preview = this.state.preview;
    if (!preview) return false;
    // A partial (truncated) snapshot is never sent: the user must reload.
    if (preview.truncated) return false;
    if (preview.noteId !== this.deps.currentNoteId()) return false;
    return isSendable(this.state.kind, this.state.question);
  }

  /**
   * The one and only inference trigger. Before any network inference an explicit
   * Send *asynchronously revalidates* the current direct grant/status and re-reads
   * the exact current note through one bounded `get_note`. A changed saved note
   * updates the shown preview and returns **without** a stream, so the user must
   * explicitly review and press Send again. It starts exactly one stream and
   * never retries implicitly.
   */
  async send(): Promise<void> {
    if (!this.canSend()) return;
    if (this.sending) return;
    const eligibility = this.deps.eligibility();
    const summary = this.state.status;
    const preview = this.state.preview;
    const model = this.state.selectedModel;
    if (
      !eligibility.eligible ||
      !eligibility.accountId ||
      !summary ||
      !preview ||
      !model
    ) {
      return;
    }
    const accountId = eligibility.accountId;
    const generation = this.generation;
    const identity = this.deps.hostIdentity();
    const verified = verifiedAssistantIdentity(this.state.identity);
    if (!verified) return;
    const subject = verified.subject;
    const clientId = verified.clientId;
    const noteId = preview.noteId;
    const kind = this.state.kind;
    const question = kind === "question" ? this.state.question.trim() : "";

    // One-shot guard: a second press while the first preflight is pending must
    // never start a second stream, and a fresh Send resets the draft.
    this.sending = true;
    const token = ++this.streamToken;
    this.setState({ streaming: true, draft: "", error: undefined });

    try {
      // (a) Revalidate the current direct grant from authoritative status.
      const freshStatus = await this.deps.status(accountId);
      if (token !== this.streamToken) return;
      if (!this.ownsInference(generation, accountId, identity, subject, clientId)) {
        this.setState({ streaming: false });
        return;
      }
      const freshIdentity = freshStatus
        ? verifiedAssistantIdentity(freshStatus)
        : undefined;
      if (
        !freshStatus ||
        freshStatus.signedIn !== true ||
        !this.deps.canInvoke(freshStatus) ||
        !freshIdentity ||
        freshIdentity.subject !== subject ||
        freshIdentity.clientId !== clientId
      ) {
        // Revoked / reauthorized / signed out / identity lost during the
        // preflight: fail closed.
        this.dropForRevocation(freshStatus);
        return;
      }

      // (b) The exact current tab note must be unchanged.
      if (this.deps.currentNoteId() !== noteId) {
        this.setState({ preview: undefined, draft: "", streaming: false });
        return;
      }

      // (c) Re-read the exact saved note through one bounded `get_note`.
      const fresh = await this.deps.readNote(accountId, noteId, () => {
        if (!this.ownsInference(generation, accountId, identity, subject, clientId))
          throw new Error("assistant_stale");
        if (this.deps.currentNoteId() !== noteId)
          throw new Error("assistant_note_changed");
      });
      if (token !== this.streamToken) return;
      if (!this.ownsInference(generation, accountId, identity, subject, clientId)) {
        this.setState({ streaming: false });
        return;
      }
      if (this.deps.currentNoteId() !== noteId) {
        this.setState({ preview: undefined, draft: "", streaming: false });
        return;
      }
      if (!fresh || fresh.noteId !== noteId || fresh.truncated) {
        // Fail closed: a missing or partial snapshot is never sent.
        this.setState({ preview: undefined, draft: "", streaming: false });
        return;
      }
      if (
        fresh.revision !== preview.revision ||
        fresh.content !== preview.content ||
        fresh.title !== preview.title
      ) {
        // The saved note changed since the preview: show the fresh snapshot and
        // return WITHOUT a stream — a new explicit Send is required.
        this.setState({ preview: fresh, streaming: false, error: undefined });
        return;
      }

      // (d) The native cancel is process-global (no request id): never start a
      // stream while an older cancel is still in flight, or that cancel would
      // kill this new stream. Wait for the barrier, then re-prove ownership.
      await this.cancelBarrier;
      if (token !== this.streamToken) return;
      if (!this.ownsInference(generation, accountId, identity, subject, clientId)) {
        this.setState({ streaming: false });
        return;
      }
      if (this.deps.currentNoteId() !== noteId) {
        this.setState({ preview: undefined, draft: "", streaming: false });
        return;
      }

      // (e) Every ownership revalidated after the awaits; exactly one stream.
      const input = [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: buildAssistantInput(kind, fresh, question)
            }
          ]
        }
      ];
      let result: AssistantStreamResult;
      try {
        result = await this.deps.stream(
          accountId,
          model,
          input,
          [],
          ASSISTANT_INSTRUCTIONS
        );
      } catch {
        // A rejected injected/native promise: keep the partial draft, stop the
        // spinner and show a static safe error. No raw text, no silent retry.
        if (token !== this.streamToken) return;
        this.setState({ streaming: false, error: errorNotice(undefined) });
        return;
      }

      // Only the exact invocation that still owns the stream may finalize.
      if (token !== this.streamToken) return;
      if (!this.ownsInference(generation, accountId, identity, subject, clientId)) {
        // The capture was invalidated mid-flight: drop the outcome and the draft
        // rather than surfacing an answer for a different account/mount.
        this.setState({ streaming: false, draft: "" });
        return;
      }
      this.setState({
        streaming: false,
        // A failed stream surfaces only the bounded static notice for its
        // allowlisted code; a raw injected/native message never reaches the UI.
        error: result.completed
          ? undefined
          : errorNotice(result.error ? result.error.code : undefined)
      });
    } catch {
      // Any unexpected failure fails closed: no stream was started.
      if (token === this.streamToken) {
        this.setState({ streaming: false, error: errorNotice(undefined) });
      }
    } finally {
      this.sending = false;
    }
  }

  /**
   * Adopt one fenced stream emission. Only deltas extend the draft; a
   * functionCall is ignored in Slice 1 (functions are never offered).
   */
  onEmission(emission: AssistantStreamEmission): void {
    if (!this.state.streaming) return;
    if (emission.type !== "delta") return;
    if (!emission.text) return;
    this.setState({ draft: this.state.draft + emission.text });
  }

  /**
   * Explicit cancel. The invocation stops owning the stream; a late completion
   * is ignored (the token changed) and the partial draft is preserved. The
   * native cancel is serialized on the barrier and keeps Send disabled until it
   * settles, so a rapid next Send can never be killed by this cancel.
   */
  async cancel(): Promise<void> {
    if (!this.state.streaming) return;
    this.streamToken += 1;
    this.setState({ streaming: false, error: undefined });
    // A rejected native cancel must never surface a raw error or wedge the UI.
    await this.beginCancel();
  }

  // ----------------------------------------------------------- write actions

  /**
   * True only while this exact write capture still owns its result: the same
   * mounted controller, the same write generation, the same host identity, the
   * same eligible persisted account and the same verified subject/clientId.
   * For an append the current tab note must still be the captured note.
   * Synchronous, so it doubles as the adapter ownership predicate.
   */
  private ownsWrite(
    capture: WriteCapture,
    noteId: string | undefined
  ): boolean {
    if (!this.mounted) return false;
    if (capture.writeToken !== this.writeToken) return false;
    if (!this.deps.isHostIdentityCurrent(capture.identity)) return false;
    const eligibility = this.deps.eligibility();
    if (!eligibility.eligible || eligibility.accountId !== capture.accountId)
      return false;
    if (!this.canInvokeState()) return false;
    if (!this.identityMatches(capture.subject, capture.clientId)) return false;
    if (noteId !== undefined && this.deps.currentNoteId() !== noteId)
      return false;
    return true;
  }

  /**
   * A reviewed snapshot may only back a write while it is complete and still
   * the actual current-tab note: a truncated snapshot or one whose note is no
   * longer open makes **every** action unavailable (the user must reload and
   * review again). With no preview loaded there is no reviewed snapshot to be
   * stale, so the purely draft-based actions stay available.
   */
  private reviewContextOk(): boolean {
    const preview = this.state.preview;
    if (!preview) return true;
    if (preview.truncated) return false;
    if (preview.noteId !== this.deps.currentNoteId()) return false;
    return true;
  }

  /** The shared gate for every explicit write action. */
  private baseActionOk(): boolean {
    if (!this.mounted || !this.state.platformSupported) return false;
    if (this.state.streaming || this.actionBusy) return false;
    if (!this.canInvokeState()) return false;
    return this.reviewContextOk();
  }

  /** True only when one explicit "save as new note" press would write now. */
  canSaveAsNewNote(): boolean {
    return this.baseActionOk() && isNoteDraftSavable(this.state.draft);
  }

  /**
   * True only when the draft can be appended to the *exact* reviewed note: a
   * loaded, non-truncated preview that is still the actual current-tab note.
   */
  canAppendToReviewedNote(): boolean {
    return (
      this.baseActionOk() &&
      !!this.state.preview &&
      isNoteDraftSavable(this.state.draft)
    );
  }

  /** True only when one explicit "create task" press would write now. */
  canCreateTaskFromDraft(): boolean {
    return this.baseActionOk() && isTaskDraftSavable(this.state.draft);
  }

  /**
   * The immutable capture of one explicit write action. It is taken
   * synchronously before the first await, so the action is bound to exactly the
   * account/host/identity/draft the user reviewed.
   */
  private captureWrite(): WriteCapture | undefined {
    if (!this.mounted || !this.state.platformSupported) return undefined;
    const eligibility = this.deps.eligibility();
    const status = this.state.status;
    if (!eligibility.eligible || !eligibility.accountId || !status) return undefined;
    if (!this.deps.canInvoke(status)) return undefined;
    // Fail closed without a *verified* identity: a write is never captured (and
    // so never runs) when the subject/clientId are missing or malformed.
    const verified = verifiedAssistantIdentity(this.state.identity);
    if (!verified) return undefined;
    return {
      accountId: eligibility.accountId,
      identity: this.deps.hostIdentity(),
      subject: verified.subject,
      clientId: verified.clientId,
      writeToken: this.writeToken,
      draft: this.state.draft
    };
  }

  /** The stable operation id for one exact write capture (see `actionOperation`). */
  private operationIdFor(key: string): string {
    if (this.actionOperation && this.actionOperation.key === key)
      return this.actionOperation.id;
    const id = this.deps.makeOperationId();
    this.actionOperation = { key, id };
    return id;
  }

  /**
   * The one shared write path. Every explicit action goes through exactly this
   * method, so the same rules hold for all of them:
   *
   *  - `canRun` is the exact public guard (which the UI already disables on);
   *  - one write at a time — a duplicate press while a write is pending is
   *    ignored before any adapter call;
   *  - the live direct grant is re-read from authoritative status before the
   *    write and a revoked/reauthorized grant fails closed, keeping the draft;
   *  - the same capture reuses the same operation id, so a retry replays the
   *    adapter receipt instead of writing twice (true idempotency);
   *  - the result is adopted only when the capture still owns it, and the state
   *    reports saved only from the adapter's `local_saved` persistence state.
   */
  private async executeWrite(
    action: AssistantAction,
    noteId: string | undefined,
    expectedRevision: string | undefined,
    canRun: () => boolean,
    run: (
      capture: WriteCapture,
      operationId: string,
      assertCurrent: () => void
    ) => Promise<AssistantWriteOutcome>,
    saved: (
      outcome: { noteId?: string; taskId?: string; revision: string }
    ) => AssistantSavedResult | undefined
  ): Promise<void> {
    if (this.actionBusy) return;
    if (!canRun()) return;
    const capture = this.captureWrite();
    if (!capture) return;
    // The account is part of the key: a reused id from a previous account would
    // be refused by the adapter as a cross-account conflict, so an account
    // change must get its own fresh operation id for an otherwise identical
    // draft.
    const key = [
      action,
      capture.accountId,
      noteId ?? "",
      expectedRevision ?? "",
      capture.draft
    ].join("\u0000");
    const operationId = this.operationIdFor(key);
    const assertCurrent = () => {
      if (!this.ownsWrite(capture, noteId))
        throw new Error("assistant_stale");
    };

    this.actionBusy = true;
    this.setState({ actionBusy: true, actionError: undefined });
    try {
      // (a) Revalidate the live direct grant from authoritative status.
      const fresh = await this.deps.status(capture.accountId);
      if (!this.ownsWrite(capture, noteId)) return;
      const freshIdentity = fresh ? verifiedAssistantIdentity(fresh) : undefined;
      if (
        !fresh ||
        fresh.signedIn !== true ||
        !this.deps.canInvoke(fresh) ||
        !freshIdentity ||
        freshIdentity.subject !== capture.subject ||
        freshIdentity.clientId !== capture.clientId
      ) {
        this.setState({ actionError: assistantActionErrorNotice("NOT_AUTHORIZED") });
        return;
      }
      // (b) Revalidate the exact reviewed context for the append.
      if (noteId !== undefined && this.deps.currentNoteId() !== noteId) {
        this.setState({
          actionError: assistantActionErrorNotice("REVISION_CONFLICT")
        });
        return;
      }
      // (c) Exactly one adapter write, fenced by the capture's predicate.
      const outcome = await run(capture, operationId, assertCurrent);
      if (!this.ownsWrite(capture, noteId)) return;
      if (outcome.ok) {
        const result = saved(outcome);
        if (!result) {
          this.setState({ actionError: assistantActionErrorNotice("unknown") });
          return;
        }
        this.setState({ actionError: undefined, lastSaved: result });
        return;
      }
      this.setState({ actionError: assistantActionErrorNotice(outcome.code) });
    } catch {
      // A rejected injected/native promise: keep the draft, show the bounded
      // static error. Never a raw message.
      if (this.ownsWrite(capture, noteId)) {
        this.setState({ actionError: assistantActionErrorNotice("unknown") });
      }
    } finally {
      this.actionBusy = false;
      this.setState({ actionBusy: false });
    }
  }

  /**
   * Explicit: create the reviewed draft as a new note through the shared Core
   * adapter. No implicit write ever happens.
   */
  async saveAsNewNote(): Promise<void> {
    const draft = this.state.draft;
    await this.executeWrite(
      "create_note",
      undefined,
      undefined,
      () => this.canSaveAsNewNote(),
      (capture, operationId, assertCurrent) =>
        this.deps.createNote(capture.accountId, draft, operationId, assertCurrent),
      (outcome) =>
        typeof outcome.noteId === "string" && outcome.noteId
          ? {
              action: "create_note",
              noteId: outcome.noteId,
              revision: outcome.revision
            }
          : undefined
    );
  }

  /**
   * Explicit: append the reviewed draft to the exact currently reviewed note,
   * pinned to the captured note id *and* its captured revision. A changed note
   * is a conflict: the draft is kept and a truthful error is shown (the adapter
   * re-checks the revision inside the domain write lock).
   */
  async appendToReviewedNote(): Promise<void> {
    const preview = this.state.preview;
    const draft = this.state.draft;
    if (!preview) return;
    const noteId = preview.noteId;
    const expectedRevision = preview.revision;
    await this.executeWrite(
      "append_to_note",
      noteId,
      expectedRevision,
      () => this.canAppendToReviewedNote(),
      async (capture, operationId, assertCurrent) => {
        // Re-read the exact saved note before the write and require the
        // *captured* revision to still be current. A changed note refreshes the
        // shown snapshot and returns a truthful conflict WITHOUT a write — the
        // user must review the new revision and press again. (The adapter
        // re-checks the same revision inside the domain write lock, so a change
        // landing after this read is still refused.)
        const freshNote = await this.deps.readNote(
          capture.accountId,
          noteId,
          assertCurrent
        );
        if (
          !freshNote ||
          freshNote.noteId !== noteId ||
          freshNote.truncated ||
          freshNote.revision !== expectedRevision
        ) {
          if (freshNote && freshNote.noteId === noteId && !freshNote.truncated) {
            this.setState({ preview: freshNote });
          }
          return { ok: false, code: "REVISION_CONFLICT" };
        }
        return this.deps.appendToNote(
          capture.accountId,
          noteId,
          draft,
          expectedRevision,
          operationId,
          assertCurrent
        );
      },
      (outcome) => ({
        action: "append_to_note",
        noteId: outcome.noteId ?? noteId,
        revision: outcome.revision
      })
    );
  }

  /**
   * Explicit: create a real Core Task record from the reviewed draft (its
   * normalized text is the Task title). This is never a note checkbox.
   */
  async createTaskFromDraft(): Promise<void> {
    const title = normalizeAssistantTaskTitle(this.state.draft);
    await this.executeWrite(
      "create_task",
      undefined,
      undefined,
      () => this.canCreateTaskFromDraft(),
      (capture, operationId, assertCurrent) =>
        this.deps.createTask(capture.accountId, title, operationId, assertCurrent),
      (outcome) =>
        typeof outcome.taskId === "string" && outcome.taskId
          ? {
              action: "create_task",
              taskId: outcome.taskId,
              revision: outcome.revision
            }
          : undefined
    );
  }

  // ------------------------------------------------------------------- auth

  /**
   * Explicit, human-initiated provider sign-in. Never called from mount.
   *
   * A duplicate press while a start is pending is ignored (one flow per press).
   * A host block is answered with the truthful bounded reason (no silent
   * no-op), and a failed start (resolved `started:false` or a *rejected*
   * injected promise) surfaces a bounded static error instead of disappearing.
   * No raw exception, token or URL is ever stored or shown.
   */
  async beginAuth(mode: AssistantAuthMode = "returning"): Promise<void> {
    if (!this.mounted || !this.state.platformSupported) return;
    if (this.authInFlight) return;
    const eligibility = this.deps.eligibility();
    if (!eligibility.eligible || !eligibility.accountId) {
      // Not a silent no-op: present the same truthful reason status would.
      this.dropForRevocation(undefined);
      this.setState({ blockedReason: eligibility.reason ?? "unknown" });
      return;
    }
    const accountId = eligibility.accountId;
    const generation = this.generation;
    const identity = this.deps.hostIdentity();

    const authToken = ++this.authToken;
    this.authInFlight = true;
    this.setState({ authStarting: true, error: undefined });
    try {
      if (this.authCancelPending) await this.authCancelBarrier;
      if (
        authToken !== this.authToken ||
        !this.isCaptureCurrent(generation, accountId, identity)
      ) return;
      const result = await this.deps.beginAuth(mode);
      // A superseded/late attempt must never set `authenticating` (no stale
      // adoption, no duplicate flow).
      if (
        authToken !== this.authToken ||
        !this.isCaptureCurrent(generation, accountId, identity)
      ) return;
      if (!result?.started) {
        this.setState({
          error: errorNotice(beginAuthErrorCode({ code: result?.error }))
        });
        return;
      }
      this.setState({
        status: { signedIn: false, status: "authenticating" },
        error: undefined
      });
    } catch {
      // A rejected injected/native start must never vanish or throw.
      if (
        authToken !== this.authToken ||
        !this.isCaptureCurrent(generation, accountId, identity)
      ) return;
      this.setState({ error: errorNotice("start_failed") });
    } finally {
      if (authToken === this.authToken) {
        this.authInFlight = false;
        this.setState({ authStarting: false });
      }
    }
  }

  /**
   * Open the ordinary, non-destructive VeyraN sign-in screen through the
   * injected dependency. It performs zero credential work itself and never
   * signs out/resets; the headless tests inject a recorder, production routes
   * to `Navigation.navigate("Auth", { mode: AuthMode.login })`.
   */
  openVeyranSignIn(): void {
    if (!this.mounted || !this.state.platformSupported) return;
    const eligibility = this.deps.eligibility();
    if (!eligibility.eligible && offersVeyranSignIn(eligibility.reason)) {
      this.deps.openVeyranSignIn();
    } else if (!eligibility.eligible) {
      this.setState({ blockedReason: eligibility.reason ?? "unknown" });
    } else {
      // Setup may have finished between render and tap. Refresh the surface
      // rather than leaving a visible recovery control silently inert.
      void this.refreshStatus();
    }
  }

  async cancelAuth(): Promise<void> {
    // The pending sign-in is superseded: its late result can no longer set
    // `authenticating`, and the single-flight guard is released immediately so a
    // subsequent explicit press is not wedged behind a never-settling start.
    this.authToken += 1;
    this.authInFlight = false;
    this.setState({
      authStarting: false,
      ...(this.state.status?.status === "authenticating"
        ? { status: { signedIn: false, status: "canceled" as const } }
        : {})
    });
    this.authCancelPending = true;
    const barrier = this.authCancelBarrier
      .then(() => this.deps.cancelAuth())
      .catch(() => {
        // A raw provider error is never exposed.
      });
    this.authCancelBarrier = barrier;
    await barrier;
    if (this.authCancelBarrier === barrier) this.authCancelPending = false;
  }

  /** Called only for an already flow-fenced native auth event. */
  onAuthEvent(event: AssistantAuthEvent): void {
    if (!this.mounted) return;
    if (event.type === "authenticated") {
      void this.refreshStatus();
      return;
    }
    if (event.type === "authError") {
      const error = errorNotice(beginAuthErrorCode({ code: event.code }));
      this.authToken += 1;
      this.authInFlight = false;
      this.setState({
        authStarting: false,
        status: { signedIn: false, status: error.code === "canceled" ? "canceled" : "failed" },
        error
      });
    }
  }

  /** Explicit logout. Everything for this account is dropped first. */
  async logout(): Promise<void> {
    const eligibility = this.deps.eligibility();
    if (!eligibility.accountId) return;
    const accountId = eligibility.accountId;
    this.invalidate();
    await this.deps.logout(accountId);
    if (!this.mounted) return;
    await this.refreshStatus();
  }
}
