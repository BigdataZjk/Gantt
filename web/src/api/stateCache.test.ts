import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createStateWriter, STATE_KEY } from "./stateCache";
import type { State } from "./types";
import { calendar, domains, users } from "../test/fixtures";

function snapshot(me: State["me"]): State {
  return {
    revision: 1, requests: [], domains, users, me,
    preferences: { theme: "light", density: "compact", defaultPriority: "P1", defaultRequestType: "常规需求", domainColors: {}, ui: {} },
    logs: [], versions: [], calendar, setupRequired: false, serverVersion: "test",
  };
}

describe("session state", () => {
  for (const direction of ["login", "logout"] as const) {
    it(`cancels an earlier state read on ${direction}, even when revisions match`, async () => {
      const client = new QueryClient();
      const previous = snapshot(direction === "login" ? null : users[0]);
      const next = snapshot(direction === "login" ? users[0] : null);
      client.setQueryData(STATE_KEY, previous);
      let resolve!: (state: State) => void;
      const read = client.fetchQuery({ queryKey: STATE_KEY, queryFn: () => new Promise<State>((done) => { resolve = done; }) });
      const settled = read.catch(() => undefined);
      await createStateWriter(client, true)(next);
      resolve(previous);
      await settled;
      expect(client.getQueryData(STATE_KEY)).toEqual(next);
      client.clear();
    });
  }

  it("ignores pending saves after logout and a new login by the same user", async () => {
    const client = new QueryClient();
    client.setQueryData(STATE_KEY, snapshot(users[0]));
    const lateSave = createStateWriter(client);
    await createStateWriter(client, true)(snapshot(null));
    const next = { ...snapshot(users[0]), revision: 3 };
    await createStateWriter(client, true)(next);
    expect(await lateSave(snapshot(users[0]))).toBe(false);
    expect(client.getQueryData(STATE_KEY)).toEqual(next);
    client.clear();
  });

  it("ignores pending saves when a state refresh discovers an expired session", async () => {
    const client = new QueryClient();
    client.setQueryData(STATE_KEY, snapshot(users[0]));
    const lateSave = createStateWriter(client);
    client.setQueryData(STATE_KEY, snapshot(null));
    expect(await lateSave(snapshot(users[0]))).toBe(false);
    expect(client.getQueryData<State>(STATE_KEY)?.me).toBeNull();
    client.clear();
  });

  it("accepts an ordinary save by the current user", async () => {
    const client = new QueryClient();
    client.setQueryData(STATE_KEY, snapshot(users[0]));
    const next = { ...snapshot(users[0]), revision: 2 };
    expect(await createStateWriter(client)(next)).toBe(true);
    expect(client.getQueryData(STATE_KEY)).toEqual(next);
    client.clear();
  });

  it("completes a session change already discovered by a concurrent state refresh", async () => {
    const client = new QueryClient();
    client.setQueryData(STATE_KEY, snapshot(null));
    const login = createStateWriter(client, true);
    const next = snapshot(users[0]);
    client.setQueryData(STATE_KEY, next);
    expect(await login(next)).toBe(true);
    expect(client.getQueryData(STATE_KEY)).toEqual(next);
    client.clear();
  });
});
