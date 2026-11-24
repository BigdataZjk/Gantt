import type { Route } from "@playwright/test";
import type { ApiRequest, State } from "../src/api/types";

export function mockRequestHistory(state: State, write: (rows: ApiRequest[]) => void) {
  let nextId = 0;
  const steps = new Map<string, { before: ApiRequest[]; after: ApiRequest[] }>();
  const snapshot = (rows: ApiRequest[]) => JSON.stringify(rows.map(({ revision: _revision, ...row }) => row));
  const save = (route: Route, changes: ApiRequest[]) => {
    const before = state.requests.filter((row) => changes.some(({ id }) => id === row.id));
    write(changes);
    const after = state.requests.filter((row) => changes.some(({ id }) => id === row.id));
    const id = String(++nextId);
    steps.set(id, { before, after });
    return route.fulfill({ json: state, headers: { "X-RSM-Request-Operation": id } });
  };
  const reverse = (route: Route, id: string) => {
    const step = steps.get(id);
    const current = state.requests.filter((row) => step?.after.some(({ id }) => id === row.id));
    if (!step || snapshot(current) !== snapshot(step.after)) {
      return route.fulfill({ status: 400, json: { error: "相关需求或顺序已被后续操作修改，保留最新数据" } });
    }
    steps.delete(id);
    return save(route, step.before);
  };
  return { save, reverse };
}

export function operationToReverse(path: string): string | undefined {
  return /^\/api\/requests\/operations\/(\d+)\/reverse$/.exec(path)?.[1];
}
