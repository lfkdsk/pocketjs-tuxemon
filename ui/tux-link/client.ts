import { fetch as pocketFetch, type FetchOptions, type PocketResponse } from "@pocketjs/framework/net";
import {
  openSocket,
  type PocketSocket,
  type SocketCloseEvent,
  type SocketOptions,
} from "@pocketjs/framework/socket";

import {
  TUX_REQUIRED_CAPS,
  TUX_SUPPORTED_CAPS,
  TUX_WIRE_VERSION,
  decodeTuxCapabilities,
  decodeTuxCreateMatchResponse,
  decodeTuxServerFrame,
  encodeTuxClientFrame,
  splitTuxInvite,
  supportsTuxLinkV1,
  type TuxCapabilitiesResponse,
  type TuxCreateMatchSuccess,
  type TuxPublicObservation,
  type TuxPublicPresentation,
  type TuxServerFrame,
} from "../../battle/tux-link-wire.ts";

export interface TuxLinkRuntimeConfig {
  readonly httpBase: string;
  readonly wsBase: string;
  readonly trustedReplayBase: string;
}

export type TuxLinkCapabilityState =
  | { kind: "unconfigured" | "probing" | "unavailable"; reason?: string }
  | { kind: "ready"; response: TuxCapabilitiesResponse };

export type TuxLinkPhase =
  | "idle"
  | "creating"
  | "connecting"
  | "waiting"
  | "decision"
  | "submitted"
  | "reconnecting"
  | "ended"
  | "error";

export interface TuxLinkClientState {
  readonly capability: TuxLinkCapabilityState;
  readonly phase: TuxLinkPhase;
  readonly matchId: string | null;
  readonly invite: string | null;
  readonly inviteExpiresAtMs: number | null;
  readonly connectionEpoch: number | null;
  readonly reconnectAttempt: number;
  readonly turnRevision: number | null;
  readonly deadlineAtMs: number | null;
  readonly selfSubmitted: boolean;
  readonly submitPending: boolean;
  readonly observation: TuxPublicObservation | null;
  readonly presentation: TuxPublicPresentation;
  readonly presentationTicks: number;
  readonly actionIndex: number;
  readonly result: { winner: "self" | "opponent" | null; reason: string } | null;
  readonly error: string | null;
}

export interface TuxLinkHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly url: string;
  json<T = unknown>(): Promise<T>;
}

export type TuxLinkFetch = (
  url: string,
  options?: FetchOptions,
) => Promise<TuxLinkHttpResponse>;

export type TuxLinkSocketFactory = (
  url: string,
  options?: SocketOptions,
) => PocketSocket;

export interface TuxLinkClientOptions {
  readonly config: TuxLinkRuntimeConfig | null;
  readonly fetch?: TuxLinkFetch;
  readonly socketFactory?: TuxLinkSocketFactory;
  readonly now?: () => number;
  readonly requestId?: () => string;
  readonly onChange?: (state: TuxLinkClientState) => void;
  readonly onInviteCreated?: (match: TuxCreateMatchSuccess) => void;
  readonly onInviteConsumed?: () => void;
}

const MAX_HTTP_BYTES = 16 * 1024;
const NON_RETRYABLE_CLOSE_REASONS = new Set([
  "auth",
  "invite",
  "admission",
  "rate",
  "ended",
  "protocol",
]);

let requestSequence = 0;

function defaultRequestId(): string {
  requestSequence = (requestSequence + 1) >>> 0;
  return `tuxlink_${Date.now().toString(36).padStart(9, "0")}_${requestSequence.toString(36).padStart(5, "0")}`;
}

function joinBase(base: string, path: string): string {
  return `${base}${path}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function initialState(config: TuxLinkRuntimeConfig | null): TuxLinkClientState {
  return {
    capability: config ? { kind: "probing" } : { kind: "unconfigured" },
    phase: "idle",
    matchId: null,
    invite: null,
    inviteExpiresAtMs: null,
    connectionEpoch: null,
    reconnectAttempt: 0,
    turnRevision: null,
    deadlineAtMs: null,
    selfSubmitted: false,
    submitPending: false,
    observation: null,
    presentation: [],
    presentationTicks: 0,
    actionIndex: 0,
    result: null,
    error: null,
  };
}

/** Wire-v1 state machine. It owns transport epochs and interactive state, but
 * keeps sanitized presentation in a separate queue so no replay projection is
 * ever treated as an authoritative decision snapshot. */
export class TuxLinkClient {
  private readonly config: TuxLinkRuntimeConfig | null;
  private readonly fetcher: TuxLinkFetch;
  private readonly sockets: TuxLinkSocketFactory;
  private readonly now: () => number;
  private readonly nextRequestId: () => string;
  private readonly onChange?: TuxLinkClientOptions["onChange"];
  private readonly onInviteCreated?: TuxLinkClientOptions["onInviteCreated"];
  private readonly onInviteConsumed?: TuxLinkClientOptions["onInviteConsumed"];
  private current: TuxLinkClientState;
  private socket: PocketSocket | null = null;
  private generation = 0;
  private reconnectAtMs = 0;
  private stopped = false;
  private ticket: string | null = null;
  private inviteSecret: string | null = null;
  private helloRequestId: string | null = null;
  private submitRequestId: string | null = null;

  constructor(options: TuxLinkClientOptions) {
    this.config = options.config;
    this.fetcher = options.fetch ?? (pocketFetch as unknown as TuxLinkFetch);
    this.sockets = options.socketFactory ?? openSocket;
    this.now = options.now ?? Date.now;
    this.nextRequestId = options.requestId ?? defaultRequestId;
    this.onChange = options.onChange;
    this.onInviteCreated = options.onInviteCreated;
    this.onInviteConsumed = options.onInviteConsumed;
    this.current = initialState(options.config);
  }

  state(): TuxLinkClientState {
    return this.current;
  }

  private publish(patch: Partial<TuxLinkClientState>): void {
    this.current = { ...this.current, ...patch };
    this.onChange?.(this.current);
  }

  async probe(): Promise<boolean> {
    if (!this.config) return false;
    this.publish({ capability: { kind: "probing" } });
    try {
      const endpoint = joinBase(this.config.httpBase, "tux/v1/capabilities");
      const response = await this.fetcher(endpoint, {
        method: "GET",
        timeoutMs: 5_000,
        maxBytes: 4_096,
      });
      if (!response.ok || response.status !== 200 || response.url !== endpoint) {
        throw new Error(`capability probe returned HTTP ${response.status}`);
      }
      const decoded = decodeTuxCapabilities(await response.json());
      if (!decoded || !supportsTuxLinkV1(decoded)) {
        this.publish({ capability: { kind: "unavailable", reason: "incompatible" } });
        return false;
      }
      this.publish({ capability: { kind: "ready", response: decoded } });
      return true;
    } catch (error) {
      this.publish({ capability: { kind: "unavailable", reason: message(error) } });
      return false;
    }
  }

  ready(): boolean {
    return this.current.capability.kind === "ready";
  }

  enter(ticket: string, inviteToken: string | null = null): boolean {
    if (!this.ready() || ticket.length === 0) return false;
    this.ticket = ticket;
    this.stopped = false;
    if (inviteToken !== null) {
      const invite = splitTuxInvite(inviteToken);
      if (!invite) {
        this.publish({ phase: "error", error: "invalid-invite" });
        return false;
      }
      this.connect(invite.matchId, invite.secret, false);
      return true;
    }
    this.publish({
      phase: "idle",
      error: null,
      result: null,
      presentation: [],
      presentationTicks: 0,
    });
    return true;
  }

  async createMatch(): Promise<boolean> {
    if (!this.config || !this.ready() || !this.ticket || this.current.phase === "creating") return false;
    const requestId = this.nextRequestId();
    this.publish({ phase: "creating", error: null });
    try {
      const endpoint = joinBase(this.config.httpBase, "tux/v1/matches");
      const response = await this.fetcher(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ v: TUX_WIRE_VERSION, ticket: this.ticket, requestId }),
        timeoutMs: 10_000,
        maxBytes: MAX_HTTP_BYTES,
      });
      if (!response.ok || response.status !== 200 || response.url !== endpoint) {
        throw new Error(`match creation returned HTTP ${response.status}`);
      }
      const decoded = decodeTuxCreateMatchResponse(await response.json());
      if (!decoded) throw new Error("match creation returned an invalid document");
      if (!decoded.ok) throw new Error(`match creation rejected: ${decoded.reason}`);
      this.onInviteCreated?.(decoded);
      this.publish({
        matchId: decoded.matchId,
        invite: decoded.invite,
        inviteExpiresAtMs: decoded.expiresAtMs,
      });
      this.connect(decoded.matchId, null, true);
      return true;
    } catch (error) {
      this.publish({ phase: "error", error: message(error) });
      return false;
    }
  }

  private connect(matchId: string, inviteSecret: string | null, creator: boolean): void {
    if (!this.config || !this.ticket) return;
    this.detachSocket();
    this.generation++;
    const generation = this.generation;
    this.inviteSecret = inviteSecret;
    this.helloRequestId ??= this.nextRequestId();
    this.publish({
      phase: this.current.reconnectAttempt > 0 ? "reconnecting" : "connecting",
      matchId,
      error: null,
      submitPending: false,
    });
    const endpoint = `${joinBase(this.config.wsBase, "ws/tux/v1")}?match=${encodeURIComponent(matchId)}`;
    let socket: PocketSocket;
    try {
      socket = this.sockets(endpoint, { timeoutMs: 10_000 });
    } catch (error) {
      this.scheduleReconnect(message(error));
      return;
    }
    this.socket = socket;
    socket.onOpen = () => {
      if (!this.isCurrent(socket, generation) || !this.ticket || !this.helloRequestId) return;
      try {
        socket.send(encodeTuxClientFrame({
          type: "hello",
          v: TUX_WIRE_VERSION,
          caps: TUX_SUPPORTED_CAPS,
          ticket: this.ticket,
          requestId: this.helloRequestId,
          ...(this.inviteSecret ? { invite: this.inviteSecret } : {}),
        }));
        if (creator) this.publish({ phase: "waiting" });
      } catch (error) {
        this.scheduleReconnect(message(error));
      }
    };
    socket.onMessage = (data) => {
      if (!this.isCurrent(socket, generation)) return;
      if (typeof data !== "string") {
        socket.close(1008, "protocol");
        this.publish({ phase: "error", error: "binary-frame" });
        return;
      }
      const frame = decodeTuxServerFrame(data);
      if (!frame) {
        socket.close(1008, "protocol");
        this.publish({ phase: "error", error: "invalid-frame" });
        return;
      }
      this.applyFrame(frame);
    };
    socket.onError = () => {
      // The close event owns retry policy and is guaranteed to follow.
    };
    socket.onClose = (event) => {
      if (!this.isCurrent(socket, generation)) return;
      this.socket = null;
      if (this.stopped || this.current.phase === "ended") return;
      if (event.code === 1008 && NON_RETRYABLE_CLOSE_REASONS.has(event.reason)) {
        this.publish({ phase: "error", error: event.reason || "connection-rejected" });
        return;
      }
      this.scheduleReconnect(event.reason || "disconnected");
    };
  }

  private isCurrent(socket: PocketSocket, generation: number): boolean {
    return this.socket === socket && this.generation === generation;
  }

  private applyFrame(frame: TuxServerFrame): void {
    if (frame.type === "welcome") {
      const consumedInvite = this.inviteSecret !== null;
      this.inviteSecret = null;
      this.helloRequestId = null;
      this.submitRequestId = null;
      this.reconnectAtMs = 0;
      this.publish({
        phase: frame.selfSubmitted ? "submitted" : "decision",
        connectionEpoch: frame.connectionEpoch,
        reconnectAttempt: 0,
        turnRevision: frame.turnRevision,
        deadlineAtMs: frame.deadlineAtMs,
        selfSubmitted: frame.selfSubmitted,
        submitPending: false,
        observation: frame.observation,
        presentation: [],
        presentationTicks: 0,
        actionIndex: 0,
        error: null,
      });
      if (consumedInvite) this.onInviteConsumed?.();
      return;
    }
    if (frame.type === "accepted") {
      if (frame.turnRevision !== this.current.turnRevision || frame.requestId !== this.submitRequestId) return;
      this.submitRequestId = null;
      this.publish({ phase: "submitted", selfSubmitted: true, submitPending: false });
      return;
    }
    if (frame.type === "resolved") {
      if (this.current.turnRevision !== null && frame.turnRevision <= this.current.turnRevision) return;
      this.submitRequestId = null;
      this.publish({
        phase: "decision",
        turnRevision: frame.turnRevision,
        deadlineAtMs: frame.deadlineAtMs,
        selfSubmitted: false,
        submitPending: false,
        observation: frame.observation,
        presentation: frame.presentation,
        presentationTicks: frame.presentation.length > 0 ? 60 : 0,
        actionIndex: 0,
        error: null,
      });
      return;
    }
    if (frame.type === "rejected") {
      if (frame.requestId !== this.submitRequestId) return;
      if (frame.reason === "STALE") {
        this.reconnectNow("stale-revision");
      } else if (frame.reason === "ALREADY_SUBMITTED") {
        this.submitRequestId = null;
        this.publish({ phase: "submitted", selfSubmitted: true, submitPending: false });
      } else {
        this.submitRequestId = null;
        this.publish({ phase: "decision", submitPending: false, error: frame.reason });
      }
      return;
    }
    this.submitRequestId = null;
    this.publish({
      phase: "ended",
      turnRevision: frame.turnRevision,
      observation: frame.observation,
      result: frame.result,
      selfSubmitted: false,
      submitPending: false,
      presentation: [],
      presentationTicks: 0,
    });
  }

  moveAction(delta: -1 | 1): void {
    const length = this.current.observation?.legalActions.length ?? 0;
    if (this.current.phase !== "decision" || length === 0) return;
    this.publish({ actionIndex: (this.current.actionIndex + delta + length) % length });
  }

  selectAction(index: number): boolean {
    const length = this.current.observation?.legalActions.length ?? 0;
    if (this.current.phase !== "decision" || !Number.isInteger(index) || index < 0 || index >= length) {
      return false;
    }
    this.publish({ actionIndex: index });
    return true;
  }

  submitSelected(): boolean {
    const state = this.current;
    const action = state.observation?.legalActions[state.actionIndex];
    if (state.phase !== "decision" || !action || state.turnRevision === null ||
      state.selfSubmitted || state.submitPending || !this.socket || this.socket.readyState !== "open") return false;
    const requestId = this.nextRequestId();
    this.submitRequestId = requestId;
    // Lock before send: two confirm edges in one host turn cannot enqueue two
    // different idempotency keys even if the socket callback is delayed.
    this.publish({ submitPending: true, error: null });
    try {
      const queued = this.socket.send(encodeTuxClientFrame({
        type: "submit",
        v: TUX_WIRE_VERSION,
        turnRevision: state.turnRevision,
        requestId,
        action,
      }));
      if (!queued) throw new Error("socket backpressure");
      return true;
    } catch (error) {
      this.publish({ submitPending: false, error: message(error) });
      this.reconnectNow("submit-failed");
      return false;
    }
  }

  tick(): void {
    if (this.current.presentationTicks > 0) {
      this.publish({ presentationTicks: this.current.presentationTicks - 1 });
    }
    if (!this.stopped && this.reconnectAtMs > 0 && this.now() >= this.reconnectAtMs && this.current.matchId) {
      this.reconnectAtMs = 0;
      this.connect(this.current.matchId, this.inviteSecret, false);
    }
    if (this.current.phase === "waiting" && this.current.inviteExpiresAtMs !== null &&
      this.now() >= this.current.inviteExpiresAtMs) {
      this.publish({ phase: "error", error: "invite-expired" });
      this.detachSocket();
    }
  }

  private reconnectNow(reason: string): void {
    this.detachSocket();
    this.reconnectAtMs = this.now();
    this.publish({
      phase: "reconnecting",
      reconnectAttempt: this.current.reconnectAttempt + 1,
      submitPending: false,
      error: reason,
    });
  }

  private scheduleReconnect(reason: string): void {
    this.detachSocket();
    const attempt = this.current.reconnectAttempt + 1;
    const delay = Math.min(10_000, 1_000 * 2 ** Math.min(attempt - 1, 4));
    this.reconnectAtMs = this.now() + delay;
    this.publish({
      phase: "reconnecting",
      reconnectAttempt: attempt,
      submitPending: false,
      error: reason,
    });
  }

  private detachSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onOpen = undefined;
    socket.onMessage = undefined;
    socket.onError = undefined;
    socket.onClose = undefined;
    if (socket.readyState === "open" || socket.readyState === "connecting") {
      try {
        socket.close(1000, "client reset");
      } catch {
        // The transport may already be closing between service-pump events.
      }
    }
  }

  leave(): void {
    this.stopped = true;
    this.generation++;
    this.reconnectAtMs = 0;
    this.detachSocket();
    this.ticket = null;
    this.inviteSecret = null;
    this.helloRequestId = null;
    this.submitRequestId = null;
    const capability = this.current.capability;
    this.current = { ...initialState(this.config), capability };
    this.onChange?.(this.current);
  }
}

// Keep the default fetch structurally checked against PocketResponse while the
// injectable test boundary remains deliberately smaller.
void (null as PocketResponse | null);
void (null as SocketCloseEvent | null);
