import { describe, expect, test } from "bun:test";

import {
  TUX_LINK_TICKET_KEY,
  clearPocketInvite,
  clearTicket,
  consumePocketAuthToken,
  installPocketAuthCommandHandler,
  loadTicket,
  pageInvite,
  pageInviteEnd,
  pageInviteConsumed,
  pageLogin,
  pageLogout,
  peekPocketInvite,
  resolveAuthStorage,
  saveTicket,
  type AuthStorage,
  type TuxLinkAuthGlobals,
  type TuxLinkPageAuthEvent,
} from "../ui/tux-link/auth-store.ts";

function memoryStorage(initial: Readonly<Record<string, string>> = {}): AuthStorage & {
  readonly values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

describe("Tux Link Web auth storage", () => {
  test("shares Wander's ticket and removes it on clear or malformed input", () => {
    expect(TUX_LINK_TICKET_KEY).toBe("pocket-rpgkit:wander-online:ticket");
    const storage = memoryStorage();

    saveTicket("cross-game-ticket", storage);
    expect(storage.values).toEqual(new Map([
      [TUX_LINK_TICKET_KEY, JSON.stringify({ ticket: "cross-game-ticket" })],
    ]));
    expect(loadTicket(storage)).toBe("cross-game-ticket");

    saveTicket("", storage);
    expect(loadTicket(storage)).toBeNull();

    saveTicket("cross-game-ticket", storage);

    clearTicket(storage);
    expect(loadTicket(storage)).toBeNull();
    expect(storage.values.size).toBe(0);

    storage.values.set(TUX_LINK_TICKET_KEY, "not-json");
    expect(loadTicket(storage)).toBeNull();
    expect(storage.values.has(TUX_LINK_TICKET_KEY)).toBeFalse();
  });

  test("uses an injected Web store before localStorage", () => {
    const bridge = memoryStorage();
    const local = memoryStorage();
    const globals: TuxLinkAuthGlobals = {
      __pocketWebStore: bridge,
      localStorage: local,
    };

    expect(resolveAuthStorage(globals)).toBe(bridge);
  });

  test("consumes an OAuth token once without persisting it", () => {
    const storage = memoryStorage();
    const globals: TuxLinkAuthGlobals = {
      __pocketWebStore: storage,
      __pocketAuth: { token: "github-one-time" },
    };

    expect(consumePocketAuthToken(globals)).toBe("github-one-time");
    expect(globals.__pocketAuth).toBeUndefined();
    expect(consumePocketAuthToken(globals)).toBeNull();
    expect(storage.values.size).toBe(0);
  });

  test("hands invites to the client and forgets them only after admission", () => {
    const events: TuxLinkPageAuthEvent[] = [];
    const globals: TuxLinkAuthGlobals = {
      __pocketInvite: "battle.ABCDEFGH",
      __pocketAuthEvent: (event) => { events.push(event); },
    };

    expect(peekPocketInvite(globals)).toBe("battle.ABCDEFGH");
    expect(peekPocketInvite(globals)).toBe("battle.ABCDEFGH");
    pageInvite("battle.ZYXWVUTS", 900, globals);
    pageInviteEnd(globals);
    pageInviteConsumed(globals);

    expect(peekPocketInvite(globals)).toBeNull();
    expect(events).toEqual([
      { type: "invite", token: "battle.ZYXWVUTS", expiresIn: 900 },
      { type: "inviteEnd" },
      { type: "inviteConsumed" },
    ]);

    globals.__pocketInvite = "battle.SECOND";
    clearPocketInvite(globals);
    expect(peekPocketInvite(globals)).toBeNull();
  });

  test("publishes login and logout through the optional page hook", () => {
    const events: TuxLinkPageAuthEvent[] = [];
    const globals: TuxLinkAuthGlobals = {
      __pocketAuthEvent: (event) => { events.push(event); },
    };

    pageLogin("octo", globals);
    pageLogout(globals);
    expect(events).toEqual([
      { type: "login", login: "octo" },
      { type: "logout" },
    ]);
  });

  test("signout clears the ticket and command cleanup restores its predecessor", () => {
    const storage = memoryStorage();
    saveTicket("signed-in", storage);
    const previousCalls: string[] = [];
    const events: TuxLinkPageAuthEvent[] = [];
    const previous = (command: string) => { previousCalls.push(command); };
    const globals: TuxLinkAuthGlobals = {
      __pocketAuthCommand: previous,
      __pocketAuthEvent: (event) => { events.push(event); },
    };
    let signouts = 0;
    let inviteEnds = 0;

    const restore = installPocketAuthCommandHandler({
      globals,
      storage,
      onSignout: () => { signouts++; },
      onInviteEnd: () => { inviteEnds++; },
    });
    const installed = globals.__pocketAuthCommand;
    expect(installed).not.toBe(previous);

    installed?.("inviteEnd");
    installed?.("signout");
    installed?.("futureCommand");
    expect(inviteEnds).toBe(1);
    expect(signouts).toBe(1);
    expect(loadTicket(storage)).toBeNull();
    expect(events).toEqual([{ type: "logout" }]);
    expect(previousCalls).toEqual(["futureCommand"]);

    restore();
    restore();
    expect(globals.__pocketAuthCommand).toBe(previous);
  });

  test("restore never overwrites a newer command owner", () => {
    const globals: TuxLinkAuthGlobals = {};
    const restore = installPocketAuthCommandHandler({ globals, storage: null });
    const replacement = () => {};
    globals.__pocketAuthCommand = replacement;

    restore();
    expect(globals.__pocketAuthCommand).toBe(replacement);
  });

  test("restore removes a handler property that was originally absent", () => {
    const globals: TuxLinkAuthGlobals = {};
    const restore = installPocketAuthCommandHandler({ globals, storage: null });
    expect(Object.prototype.hasOwnProperty.call(globals, "__pocketAuthCommand")).toBeTrue();

    restore();
    expect(Object.prototype.hasOwnProperty.call(globals, "__pocketAuthCommand")).toBeFalse();
  });
});
