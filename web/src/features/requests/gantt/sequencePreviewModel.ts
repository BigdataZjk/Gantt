import type { ApiRequest, Calendar } from "../../../api/types";
import { diffDays } from "../../../lib/dates";
import { planOf, type SequencePlan } from "./ganttMath";

export interface SequencePreviewRow {
  before: ApiRequest;
  after: ApiRequest;
  selected: boolean;
  changed: boolean;
}

export function sequencePreviewRows(requests: ApiRequest[], sequence: SequencePlan, calendar: Calendar) {
  const selected = new Set(sequence.ids);
  const changes = new Map(sequence.changes.map((change) => [change.before.id, change]));
  const rows: SequencePreviewRow[] = requests.flatMap((request) => {
    const change = changes.get(request.id);
    if (!selected.has(request.id) && !change) return [];
    return [{ before: change?.before ?? request, after: change?.after ?? request, selected: selected.has(request.id), changed: Boolean(change) }];
  });
  let start = "";
  let end = "";
  for (const row of rows) {
    for (const request of [row.before, row.after]) {
      const plan = planOf(request, calendar);
      const first = plan.segments[0]?.start;
      if (first && (!start || first < start)) start = first;
      if (plan.delivery > end) end = plan.delivery;
    }
  }
  return { rows, start, end, days: start && end ? diffDays(start, end) + 1 : 0 };
}
