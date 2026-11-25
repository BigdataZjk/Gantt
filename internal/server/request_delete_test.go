package server_test

import (
	"fmt"
	"net/http/httptest"
	"reflect"
	"testing"

	"rsm/internal/requests"
	"rsm/internal/schedule"
	"rsm/internal/store"
)

func TestDeleteCompactsScheduleWithConfirmationAndUndo(t *testing.T) {
	f := newFixture(t)
	state := f.state()
	save := func(name, start, end string, days float64, edit func(*requests.Request)) requests.Request {
		row := example(name)
		row.Developer, row.Start, row.Delivery, row.Days = state.Me.ID, start, end, days
		if edit != nil {
			edit(&row)
		}
		_, state = f.call("POST", "/api/requests", map[string]any{"baseRevision": state.Revision, "request": row}, 200, true)
		return state.Requests[len(state.Requests)-1]
	}
	deleted := save("删掉的排期", "2026-11-16", "2026-11-20", 5, nil)
	parallel := save("并行需求", "2026-11-26", "2026-11-30", 3, func(row *requests.Request) {
		row.Vacation, row.Overtime = []string{"2026-11-27"}, []string{"2026-11-28"}
	})
	moved := save("分段需求", "2026-11-23", "2026-12-03", 7, func(row *requests.Request) {
		row.Priority = "P0"
		row.Segments = []schedule.Segment{
			{Start: "2026-11-23", End: "2026-11-28"},
			{Start: "2026-12-02", End: "2026-12-03", HoldBefore: true},
		}
		row.Vacation, row.Overtime = []string{"2026-11-25"}, []string{"2026-11-28"}
		row.SupportSegments = []requests.SupportSegment{{RequestID: parallel.ID, Start: "2026-12-04", End: "2026-12-07"}}
	})
	historyRow := save("历史排期", "2026-12-09", "2026-12-10", 2, nil)
	archivePath := fmt.Sprintf("/api/requests/%d/archive", historyRow.ID)
	_, state = f.call("POST", archivePath, map[string]any{"baseRevision": state.Revision, "archived": true}, 200, true)
	historyRow = state.Requests[len(state.Requests)-1]
	later := save("固定边界后的需求", "2026-12-14", "2026-12-15", 2, nil)
	unscheduled := save("待排期需求", "", "", 3, nil)

	path := fmt.Sprintf("/api/requests/%d", deleted.ID)
	input := map[string]any{"baseRevision": state.Revision}
	changes := []store.P0DeliveryChange{{RequestID: moved.ID, Name: moved.Name, Before: "2026-12-03", After: "2026-11-26"}}
	header := f.requireDeliveryConfirmation("DELETE", path, input, changes)
	f.assertDeliveryPreviewDidNotSave(state)
	result, after := f.call("DELETE", path, input, 200, true, header)
	if result.Header().Get("X-RSM-Reflowed-Requests") != "2" || after.Revision != state.Revision+1 || len(after.Requests) != 5 {
		t.Fatalf("unexpected deletion result: %v %+v", result.Header(), after.Requests)
	}
	wantParallel, wantMoved := parallel, moved
	wantParallel.Revision++
	wantParallel.Start, wantParallel.Delivery = "2026-11-19", "2026-11-23"
	wantParallel.Vacation, wantParallel.Overtime = []string{"2026-11-20"}, []string{"2026-11-21"}
	wantMoved.Revision++
	wantMoved.Start, wantMoved.Delivery = "2026-11-16", "2026-11-26"
	wantMoved.Vacation, wantMoved.Overtime = []string{"2026-11-18"}, []string{"2026-11-21"}
	wantMoved.Segments = []schedule.Segment{
		{Start: "2026-11-16", End: "2026-11-21"},
		{Start: "2026-11-25", End: "2026-11-26", HoldBefore: true},
	}
	wantMoved.SupportSegments = []requests.SupportSegment{{RequestID: parallel.ID, Start: "2026-11-27", End: "2026-11-30"}}
	want := []requests.Request{wantParallel, wantMoved, historyRow, later, unscheduled}
	if !reflect.DeepEqual(after.Requests, want) {
		t.Fatalf("unexpected compacted schedules:\n got %+v\nwant %+v", after.Requests, want)
	}

	reverse := func(res *httptest.ResponseRecorder, before store.Snapshot, redo bool, changes []store.P0DeliveryChange) (*httptest.ResponseRecorder, store.Snapshot) {
		path := "/api/requests/operations/" + requestOperationID(t, res) + "/reverse"
		input := map[string]any{"baseRevision": before.Revision, "redo": redo}
		header := f.requireDeliveryConfirmation("POST", path, input, changes)
		f.assertDeliveryPreviewDidNotSave(before)
		return f.call("POST", path, input, 200, true, header)
	}
	undo, restored := reverse(result, after, false, []store.P0DeliveryChange{{
		RequestID: moved.ID, Name: moved.Name, Before: changes[0].After, After: changes[0].Before,
	}})
	if len(restored.Requests) != 6 || restored.Requests[len(restored.Requests)-1].ID != deleted.ID {
		t.Fatal("undo did not restore the deleted request")
	}
	gotParallel, gotMoved := restored.Requests[0], restored.Requests[1]
	gotParallel.Revision, gotMoved.Revision = parallel.Revision, moved.Revision
	if !reflect.DeepEqual(gotParallel, parallel) || !reflect.DeepEqual(gotMoved, moved) {
		t.Fatalf("undo did not restore both schedules: %+v %+v", gotParallel, gotMoved)
	}
	_, redone := reverse(undo, restored, true, changes)
	if len(redone.Requests) != 5 || redone.Requests[0].Start != wantParallel.Start || redone.Requests[1].Delivery != wantMoved.Delivery {
		t.Fatal("redo did not reapply the complete operation")
	}
}

func TestCollaboratorDeleteDoesNotChangeSchedules(t *testing.T) {
	f := newFixture(t)
	state := f.state()
	for i, day := range []string{"2026-11-16", "2026-11-17"} {
		row := example(fmt.Sprintf("需求 %d", i+1))
		row.Developer, row.Start, row.Days = state.Me.ID, day, 1
		_, state = f.call("POST", "/api/requests", map[string]any{"baseRevision": state.Revision, "request": row}, 200, true)
	}
	f.call("POST", "/api/users", map[string]any{"username": "同事", "password": "test-pass", "role": "collaborator"}, 200, true)
	_, state = f.call("POST", "/api/login", map[string]any{"username": "同事", "password": "test-pass"}, 200, true)
	path := fmt.Sprintf("/api/requests/%d", state.Requests[0].ID)
	input := map[string]any{"baseRevision": state.Revision}
	f.call("DELETE", path, input, 401, false)
	result, after := f.call("DELETE", path, input, 200, true)
	if result.Header().Get("X-RSM-Reflowed-Requests") != "0" || !reflect.DeepEqual(after.Requests, state.Requests[1:]) {
		t.Fatal("delete allowed a collaborator to edit another schedule")
	}
}
