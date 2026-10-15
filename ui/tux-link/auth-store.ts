// Web auth handoff shared with Wander Online. GitHub OAuth tokens are
// deliberately kept out of storage: the player page publishes one through
// __pocketAuth, and the game consumes it once before exchanging it for the
// persistent session ticket.

/** Wander and Tux Link intentionally share this key so one GitHub session can
 * move between the two games without another OAuth redirect. */
export const TUX_LINK_TICKET_KEY = "pocket-rpgkit:wander-online:ticket";

export interface AuthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type TuxLinkPageAuthEvent =
  | { type: "login"; login: string }
  | { type: "logout" }
  | { type: "invite"; token: string; expiresIn: number }
  | { type: "inviteEnd" }
  | { type: "inviteConsumed" };

export type TuxLinkAuthCommand = "signout" | "inviteEnd";

export interface TuxLinkAuthGlobals {
  /** Installed by the Web player before it evaluates the guest bundle. */
  __pocketWebStore?: AuthStorage;
  /** Useful for an ordinary browser host; the QuickJS guest uses the bridge. */
  localStorage?: AuthStorage;
  __pocketAuth?: { token?: unknown };
  __pocketInvite?: unknown;
  __pocketAuthEvent?: (event: TuxLinkPageAuthEvent) => void;
  __pocketAuthCommand?: (command: string, value?: string) => void;
}

function browserGlobals(): TuxLinkAuthGlobals {
  return globalThis as unknown as TuxLinkAuthGlobals;
}

/** Resolve the small Web storage bridge without requiring browser globals in
 * tests or in non-Web builds. Every lookup fails soft for restricted storage. */
export function resolveAuthStorage(
  globals: TuxLinkAuthGlobals = browserGlobals(),
): AuthStorage | null {
  try {
    return globals.__pocketWebStore ?? globals.localStorage ?? null;
  } catch {
    return null;
  }
}

function defaultStorage(): AuthStorage | null {
  return resolveAuthStorage();
}

export function loadTicket(storage: AuthStorage | null = defaultStorage()): string | null {
  if (!storage) return null;
  try {
    const encoded = storage.getItem(TUX_LINK_TICKET_KEY);
    if (encoded === null) return null;
    const ticket = (JSON.parse(encoded) as { ticket?: unknown }).ticket;
    if (typeof ticket === "string" && ticket.length > 0) return ticket;
    storage.removeItem(TUX_LINK_TICKET_KEY);
  } catch {
    // Malformed or inaccessible storage is equivalent to being signed out.
    try {
      storage.removeItem(TUX_LINK_TICKET_KEY);
    } catch {
      // The store may also reject cleanup (private mode, disabled storage).
    }
  }
  return null;
}

export function saveTicket(ticket: string, storage: AuthStorage | null = defaultStorage()): void {
  if (!storage) return;
  if (ticket.length === 0) {
    clearTicket(storage);
    return;
  }
  try {
    storage.setItem(TUX_LINK_TICKET_KEY, JSON.stringify({ ticket }));
  } catch {
    // A private-mode/quota failure leaves the session usable for this load.
  }
}

export function clearTicket(storage: AuthStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(TUX_LINK_TICKET_KEY);
  } catch {
    // Already gone or inaccessible.
  }
}

/** Take the page's OAuth credential exactly once. The token is removed before
 * it is returned and is never copied into either local or session storage. */
export function consumePocketAuthToken(
  globals: TuxLinkAuthGlobals = browserGlobals(),
): string | null {
  let envelope: TuxLinkAuthGlobals["__pocketAuth"];
  try {
    envelope = globals.__pocketAuth;
    // Clear the complete envelope even when it is malformed, so it cannot be
    // retried as a credential on a later controller mount.
    globals.__pocketAuth = undefined;
  } catch {
    // If the host does not let us clear the value, fail closed rather than
    // returning a credential that could be consumed again.
    return null;
  }
  try {
    const token = envelope?.token;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Read the invite handed over by the player page without consuming it. It is
 * kept until admission succeeds so reconnects can continue using the code. */
export function peekPocketInvite(
  globals: TuxLinkAuthGlobals = browserGlobals(),
): string | null {
  try {
    const invite = globals.__pocketInvite;
    return typeof invite === "string" && invite.length > 0 ? invite : null;
  } catch {
    return null;
  }
}

export function clearPocketInvite(
  globals: TuxLinkAuthGlobals = browserGlobals(),
): void {
  try {
    globals.__pocketInvite = undefined;
  } catch {
    // A host-owned, read-only hook simply cannot be cleared by the guest.
  }
}

function pageEvent(
  event: TuxLinkPageAuthEvent,
  globals: TuxLinkAuthGlobals,
): void {
  try {
    globals.__pocketAuthEvent?.(event);
  } catch {
    // Desktop/tests may have no page, and page chrome must not break gameplay.
  }
}

export function pageLogin(
  login: string,
  globals: TuxLinkAuthGlobals = browserGlobals(),
): void {
  pageEvent({ type: "login", login }, globals);
}

export function pageLogout(
  globals: TuxLinkAuthGlobals = browserGlobals(),
): void {
  pageEvent({ type: "logout" }, globals);
}

export function pageInvite(
  token: string,
  expiresIn: number,
  globals: TuxLinkAuthGlobals = browserGlobals(),
): void {
  pageEvent({ type: "invite", token, expiresIn }, globals);
}

export function pageInviteEnd(
  globals: TuxLinkAuthGlobals = browserGlobals(),
): void {
  pageEvent({ type: "inviteEnd" }, globals);
}

/** Complete an incoming invite handoff. Clearing the guest copy prevents a
 * second controller mount from redeeming it, while the event tells the page to
 * clear its sessionStorage copy retained across the OAuth redirect. */
export function pageInviteConsumed(
  globals: TuxLinkAuthGlobals = browserGlobals(),
): void {
  clearPocketInvite(globals);
  pageEvent({ type: "inviteConsumed" }, globals);
}

export interface TuxLinkAuthCommandHandlers {
  globals?: TuxLinkAuthGlobals;
  /** `undefined` resolves the global Web bridge; `null` disables persistence. */
  storage?: AuthStorage | null;
  onSignout?: () => void;
  onInviteEnd?: () => void;
}

/** Install the two commands understood by Tux Link and return an idempotent
 * restoration function. Unknown commands are delegated to a previous handler.
 * Restoration is ownership-safe: a later replacement is never overwritten. */
export function installPocketAuthCommandHandler(
  handlers: TuxLinkAuthCommandHandlers = {},
): () => void {
  const globals = handlers.globals ?? browserGlobals();
  const storage = handlers.storage === undefined ? resolveAuthStorage(globals) : handlers.storage;
  let previous: TuxLinkAuthGlobals["__pocketAuthCommand"];
  let hadOwnHandler = false;
  try {
    hadOwnHandler = Object.prototype.hasOwnProperty.call(globals, "__pocketAuthCommand");
    previous = globals.__pocketAuthCommand;
  } catch {
    return () => {};
  }

  const installed: NonNullable<TuxLinkAuthGlobals["__pocketAuthCommand"]> = (command, value) => {
    if (command === "signout") {
      clearTicket(storage);
      try {
        handlers.onSignout?.();
      } finally {
        pageLogout(globals);
      }
      return;
    }
    if (command === "inviteEnd") {
      handlers.onInviteEnd?.();
      return;
    }
    previous?.(command, value);
  };

  try {
    globals.__pocketAuthCommand = installed;
  } catch {
    return () => {};
  }

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    try {
      if (globals.__pocketAuthCommand === installed) {
        if (hadOwnHandler) globals.__pocketAuthCommand = previous;
        else delete globals.__pocketAuthCommand;
      }
    } catch {
      // Host teardown can make the bridge inaccessible before game cleanup.
    }
  };
}
