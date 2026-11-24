package server_test

import (
	"fmt"
	"net/http/httptest"
	"slices"
	"testing"

	"rsm/internal/store"
)

func requestOperationID(t *testing.T, result *httptest.ResponseRecorder) string {
	t.Helper()
	id := result.Header().Get("X-RSM-Request-Operation")
	if id == "" {
		t.Fatal("missing request operation ID")
	}
	return id
}

func TestPersonalRequestOperations(t *testing.T) {
	f := newFixture(t)
	state := f.state()
	reverse := func(id string, redo bool, want int) (*httptest.ResponseRecorder, store.Snapshot) {
		return f.call("POST", "/api/requests/operations/"+id+"/reverse", map[string]any{"baseRevision": f.state().Revision, "redo": redo}, want, true)
	}
	draft := example("待估人天需求")
	draft.Developer, draft.Start, draft.Days = state.Me.ID, "2026-11-16", 0
	created, state := f.call("POST", "/api/requests", map[string]any{"baseRevision": state.Revision, "request": draft}, 200, true)
	create := requestOperationID(t, created)
	row := state.Requests[0]
	path := fmt.Sprintf("/api/requests/%d", row.ID)
	row.Days, row.Delivery = 4, ""
	save, state := f.call("PUT", path, map[string]any{"baseRevision": state.Revision, "request": row}, 200, true)
	saveID := requestOperationID(t, save)
	if state.Requests[0].Days != 4 || state.Requests[0].Delivery != "2026-11-19" {
		t.Fatal(state.Requests[0])
	}

	alice := f.cookie
	f.call("POST", "/api/users", map[string]any{"username": "同事", "password": "test-pass", "role": "collaborator"}, 200, true)
	f.call("POST", "/api/login", map[string]any{"username": "同事", "password": "test-pass"}, 200, true)
	reverse(saveID, false, 403)
	state = f.state()
	row = state.Requests[0]
	row.Notes = "来自同事的备注"
	f.call("PUT", path, map[string]any{"baseRevision": state.Revision, "request": row}, 200, true)
	f.cookie = alice

	undo, state := reverse(saveID, false, 200)
	if row := state.Requests[0]; row.Days != 0 || row.Delivery != "2026-11-18" || row.Notes != "来自同事的备注" {
		t.Fatalf("undo failed to restore estimated schedule or overwrote another field: %+v", row)
	}
	reverse(saveID, false, 400)
	reverse(create, false, 400)
	redo, state := reverse(requestOperationID(t, undo), true, 200)
	if row := state.Requests[0]; row.Days != 4 || row.Delivery != "2026-11-19" || row.Notes != "来自同事的备注" {
		t.Fatalf("redo did not restore the saved schedule: %+v", row)
	}
	row = state.Requests[0]
	row.Days, row.Delivery = 5, ""
	f.call("PUT", path, map[string]any{"baseRevision": state.Revision, "request": row}, 200, true)
	reverse(requestOperationID(t, redo), false, 400)
	if f.state().Requests[0].Days != 5 {
		t.Fatal("a conflicting undo overwrote newer schedule data")
	}
}

func TestRequestOperationsRestoreOrderRankAndDeletedRows(t *testing.T) {
	f := newFixture(t)
	state := f.state()
	dev := state.Me.ID
	reverse := func(result *httptest.ResponseRecorder, redo bool) (*httptest.ResponseRecorder, store.Snapshot) {
		return f.call("POST", "/api/requests/operations/"+requestOperationID(t, result)+"/reverse", map[string]any{"baseRevision": f.state().Revision, "redo": redo}, 200, true)
	}
	var ids []int64
	for _, name := range []string{"甲", "乙"} {
		draft := example(name)
		draft.Developer, draft.Start = dev, "2026-11-16"
		created, next := f.call("POST", "/api/requests", map[string]any{"baseRevision": state.Revision, "request": draft}, 200, true)
		if len(ids) == 0 {
			undo, empty := reverse(created, false)
			if len(empty.Requests) != 0 {
				t.Fatal("undo create should remove the request")
			}
			_, next = reverse(undo, true)
		}
		state = next
		ids = append(ids, state.Requests[len(state.Requests)-1].ID)
	}
	orderInput := func(developer string, ids []int64) []map[string]any {
		return []map[string]any{{"developer": developer, "requestIds": ids}}
	}
	ordered, state := f.call("PUT", "/api/requests/gantt-order", map[string]any{"baseRevision": state.Revision, "orders": orderInput(dev, []int64{ids[1], ids[0]})}, 200, true)
	undoOrder, state := reverse(ordered, false)
	if len(state.GanttRowOrder[dev]) != 0 {
		t.Fatal("undo should restore automatic ordering")
	}
	_, state = reverse(undoOrder, true)
	if !slices.Equal(state.GanttRowOrder[dev], []int64{ids[1], ids[0]}) {
		t.Fatal("redo failed to restore custom ordering")
	}
	rank := func(id int64) *httptest.ResponseRecorder {
		result, _ := f.call("POST", "/api/requests/priority", map[string]any{"baseRevision": f.state().Revision, "action": "toggle", "requestId": id}, 200, true)
		return result
	}
	rank(ids[0])
	rank(ids[1])
	canceled := rank(ids[0])
	_, state = reverse(canceled, false)
	if state.Requests[0].RequesterRank != 1 || state.Requests[1].RequesterRank != 2 {
		t.Fatal("undo did not restore both ranks")
	}
	path := fmt.Sprintf("/api/requests/%d", ids[0])
	archived, state := f.call("POST", path+"/archive", map[string]any{"baseRevision": state.Revision, "archived": true}, 200, true)
	_, state = reverse(archived, false)
	if state.Requests[0].Archived || state.Requests[0].RequesterRank != 1 || state.Requests[1].RequesterRank != 2 {
		t.Fatal("undo archive did not restore status and ranks")
	}
	moved, state := f.call("PUT", "/api/requests/gantt-order", map[string]any{"baseRevision": state.Revision, "orders": orderInput("", []int64{ids[0]}), "move": map[string]any{"requestId": ids[0], "developer": ""}}, 200, true)
	_, state = reverse(moved, false)
	if state.Requests[0].Developer != dev || !slices.Equal(state.GanttRowOrder[dev], []int64{ids[1], ids[0]}) || len(state.GanttRowOrder[""]) != 0 {
		t.Fatal("undo move did not restore developer and both groups")
	}
	deleted, _ := f.call("DELETE", path, map[string]any{"baseRevision": state.Revision}, 200, true)
	undoDelete, state := reverse(deleted, false)
	if row := state.Requests[len(state.Requests)-1]; row.ID != ids[0] || row.RequesterRank != 1 || !slices.Equal(state.GanttRowOrder[dev], []int64{ids[1], ids[0]}) {
		t.Fatal("undo delete did not restore the request with the same ID and position")
	}
	_, state = reverse(undoDelete, true)
	if len(state.Requests) != 1 || state.Requests[0].ID != ids[1] || state.Requests[0].RequesterRank != 1 {
		t.Fatal("redo deletion did not restore remaining ranks")
	}
}
