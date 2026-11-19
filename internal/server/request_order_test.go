package server_test

import (
	"fmt"
	"reflect"
	"slices"
	"testing"
)

func TestSharedGanttOrderMovesAndValidatesAtomically(t *testing.T) {
	f := newFixture(t)
	_, state := f.call("POST", "/api/users", map[string]any{"username": "测试开发人", "password": "test", "role": "admin"}, 200, true)
	developer := state.Users[1].ID
	state = f.create("未分配需求")
	source := state.Requests[0]
	assigned := example("已分配需求")
	assigned.Developer = developer
	assigned.Start = "2026-11-16"
	_, state = f.call("POST", "/api/requests", map[string]any{"baseRevision": state.Revision, "request": assigned}, 200, true)
	assigned = state.Requests[1]
	order := func(ids ...int64) []map[string]any {
		return []map[string]any{{"developer": developer, "requestIds": ids}}
	}
	move := map[string]any{"requestId": source.ID, "developer": developer}
	base := state.Revision
	f.call("PUT", "/api/requests/gantt-order", map[string]any{"baseRevision": base, "move": move, "orders": order(source.ID)}, 400, true)
	if after := f.state(); after.Revision != base || !reflect.DeepEqual(after.Requests, state.Requests) {
		t.Fatal("invalid order changed the developer or data revision")
	}
	_, state = f.call("PUT", "/api/requests/gantt-order", map[string]any{"baseRevision": base, "move": move, "orders": order(assigned.ID, source.ID)}, 200, true)
	f.call("PUT", "/api/requests/gantt-order", map[string]any{"baseRevision": base, "orders": order(source.ID, assigned.ID)}, 409, true)
	_, guest := f.call("GET", "/api/state", nil, 200, false)
	source.Developer, source.Revision = developer, source.Revision+1
	if !reflect.DeepEqual(guest.Requests, state.Requests) || !reflect.DeepEqual(guest.Requests[0], source) || !reflect.DeepEqual(guest.Requests[1], assigned) {
		t.Fatal("assignment changed unrelated request fields or was not shared")
	}
	if !slices.Equal(guest.GanttRowOrder[developer], []int64{assigned.ID, source.ID}) {
		t.Fatal("shared order was not saved", guest.GanttRowOrder)
	}
	_, state = f.call("POST", fmt.Sprintf("/api/requests/%d/archive", assigned.ID), map[string]any{"baseRevision": state.Revision, "archived": true}, 200, true)
	if !slices.Equal(state.GanttRowOrder[developer], []int64{source.ID}) {
		t.Fatal("archived row remained in the shared order", state.GanttRowOrder)
	}
}

func TestRequesterRankKeepsContiguousOrder(t *testing.T) {
	f := newFixture(t)
	f.create("第一条需求")
	f.create("第二条需求")
	state := f.create("第三条需求")
	toggle := func(index int) {
		t.Helper()
		_, state = f.call("POST", "/api/requests/priority", map[string]any{"baseRevision": state.Revision, "action": "toggle", "requestId": state.Requests[index].ID}, 200, true)
	}
	checkRanks := func(want ...int) {
		t.Helper()
		got := make([]int, 0, len(state.Requests))
		for _, row := range state.Requests {
			got = append(got, row.RequesterRank)
			if row.Priority != "P1" {
				t.Fatal("requester rank overwrote the existing priority")
			}
		}
		if !slices.Equal(got, want) {
			t.Fatalf("ranks = %v, want %v", got, want)
		}
	}
	toggle(2)
	toggle(0)
	toggle(1)
	checkRanks(2, 3, 1)
	row := state.Requests[1]
	row.RequesterRank = 100
	_, state = f.call("PUT", fmt.Sprintf("/api/requests/%d", row.ID), map[string]any{"baseRevision": state.Revision, "request": row}, 200, true)
	checkRanks(2, 3, 1)
	toggle(0)
	checkRanks(0, 2, 1)
	_, state = f.call("POST", fmt.Sprintf("/api/requests/%d/archive", state.Requests[2].ID), map[string]any{"baseRevision": state.Revision, "archived": true}, 200, true)
	checkRanks(0, 1, 0)
	_, state = f.call("POST", "/api/requests/priority", map[string]any{"baseRevision": state.Revision, "action": "clear"}, 200, true)
	checkRanks(0, 0, 0)
}
