package server_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"testing"

	"rsm/internal/requests"
	"rsm/internal/server"
	"rsm/internal/store"
)

func (f *fixture) scheduledRequest(name, priority, start string) store.Snapshot {
	f.t.Helper()
	snap := f.state()
	row := example(name)
	row.Priority, row.Start, row.Developer = priority, start, snap.Me.ID
	_, result := f.call("POST", "/api/requests", map[string]any{"baseRevision": snap.Revision, "request": row}, 200, true)
	return result
}

func (f *fixture) requireDeliveryConfirmation(method, path string, input any, want []store.P0DeliveryChange) http.Header {
	f.t.Helper()
	res, _ := f.call(method, path, input, http.StatusPreconditionRequired, true)
	var response server.P0DeliveryConfirmationError
	if err := json.Unmarshal(res.Body.Bytes(), &response); err != nil {
		f.t.Fatal(err)
	}
	if response.Code != "p0_delivery_confirmation_required" || response.Confirmation.Token == "" || len(response.Confirmation.Changes) != len(want) {
		f.t.Fatalf("unexpected confirmation: %+v", response)
	}
	for index, got := range response.Confirmation.Changes {
		change := store.P0DeliveryChange{
			RequestID: got.RequestId, Name: got.Name, Before: got.Before, After: got.After,
			BeforeDays: got.BeforeDays, AfterDays: got.AfterDays,
		}
		if !reflect.DeepEqual(change, want[index]) {
			f.t.Fatalf("unexpected schedule change: %+v, want %+v", got, want[index])
		}
	}
	return http.Header{"X-RSM-Confirm-P0-Delivery": {response.Confirmation.Token}}
}

func (f *fixture) assertDeliveryPreviewDidNotSave(before store.Snapshot) {
	f.t.Helper()
	got := f.state()
	if got.Revision != before.Revision || !reflect.DeepEqual(got.Requests, before.Requests) ||
		!reflect.DeepEqual(got.Logs, before.Logs) || !reflect.DeepEqual(got.Calendar, before.Calendar) {
		f.t.Fatal("the unconfirmed operation changed requests, calendar, revision or history")
	}
}

func TestP0DeliveryConfirmationBindsOperationAndRevision(t *testing.T) {
	f := newFixture(t)
	owner := f.cookie
	f.call("POST", "/api/users", map[string]any{"username": "测试管理员", "password": "p0-test-password", "role": "admin"}, 200, true)
	f.call("POST", "/api/login", map[string]any{"username": "测试管理员", "password": "p0-test-password"}, 200, true)
	other := f.cookie
	f.cookie = owner

	scheduled := f.scheduledRequest("核心交付", "P0", "2026-11-16")
	row := scheduled.Requests[0]
	path := fmt.Sprintf("/api/requests/%d", row.ID)
	row.Notes = "补充备注"
	row.Days = 5
	_, before := f.call("PUT", path, map[string]any{"baseRevision": scheduled.Revision, "request": row}, 200, true)
	if before.Requests[0].Delivery != row.Delivery {
		t.Fatal("retaining the explicit delivery date must not require confirmation")
	}
	row = before.Requests[0]
	row.Days, row.Delivery = 5, ""
	input := map[string]any{"baseRevision": before.Revision, "request": row}
	changes := []store.P0DeliveryChange{{RequestID: row.ID, Name: row.Name, Before: "2026-11-18", After: "2026-11-20", BeforeDays: new(3), AfterDays: new(5)}}
	header := f.requireDeliveryConfirmation("PUT", path, input, changes)
	f.assertDeliveryPreviewDidNotSave(before)

	f.cookie = other
	f.call("PUT", path, input, 409, true, header)
	f.cookie = owner
	tampered := row
	tampered.Notes = "与确认时不同的备注"
	f.call("PUT", path, map[string]any{"baseRevision": before.Revision, "request": tampered}, 409, true, header)
	f.assertDeliveryPreviewDidNotSave(before)

	advanced := f.create("并发提交的其他需求")
	f.call("PUT", path, input, 409, true, header)
	f.assertDeliveryPreviewDidNotSave(advanced)

	input["baseRevision"] = advanced.Revision
	header = f.requireDeliveryConfirmation("PUT", path, input, changes)
	_, confirmed := f.call("PUT", path, input, 200, true, header)
	if confirmed.Requests[0].Delivery != changes[0].After || confirmed.Revision != advanced.Revision+1 || len(confirmed.Logs) != len(advanced.Logs)+1 {
		t.Fatal("confirmation must save the operation once", confirmed.Requests[0])
	}
	f.call("PUT", path, input, 409, true, header)
	f.assertDeliveryPreviewDidNotSave(confirmed)

	row = confirmed.Requests[0]
	row.Start, row.Delivery, row.Segments = "", "", nil
	f.requireDeliveryConfirmation("PUT", path, map[string]any{"baseRevision": confirmed.Revision, "request": row},
		[]store.P0DeliveryChange{{RequestID: row.ID, Name: row.Name, Before: "2026-11-20", BeforeDays: new(5), AfterDays: new(0)}})
	f.assertDeliveryPreviewDidNotSave(confirmed)
}

func TestP0LeaveConfirmsEffectiveDaysWithSameDates(t *testing.T) {
	f := newFixture(t)
	before := f.scheduledRequest("一日核心排期", "P0", "2026-11-16")
	row := before.Requests[0]
	path := fmt.Sprintf("/api/requests/%d", row.ID)
	row.Days, row.Delivery = 1, row.Start
	input := map[string]any{"baseRevision": before.Revision, "request": row}
	header := f.requireDeliveryConfirmation("PUT", path, input, []store.P0DeliveryChange{{
		RequestID: row.ID, Name: row.Name, Before: "2026-11-18", After: row.Start, BeforeDays: new(3), AfterDays: new(1),
	}})
	_, before = f.call("PUT", path, input, 200, true, header)
	row = before.Requests[0]
	row.Vacation = []string{"2026-11-17"}
	_, before = f.call("PUT", path, map[string]any{"baseRevision": before.Revision, "request": row}, 200, true)
	row = before.Requests[0]
	row.Vacation = []string{"2026-11-16", "2026-11-17"}
	input = map[string]any{"baseRevision": before.Revision, "request": row}
	header = f.requireDeliveryConfirmation("PUT", path, input, []store.P0DeliveryChange{{
		RequestID: row.ID, Name: row.Name, Before: row.Delivery, After: row.Delivery, BeforeDays: new(1), AfterDays: new(0),
	}})
	f.assertDeliveryPreviewDidNotSave(before)
	_, saved := f.call("PUT", path, input, 200, true, header)
	if got := saved.Requests[0]; got.Start != row.Start || got.Delivery != row.Delivery || !reflect.DeepEqual(got.Vacation, row.Vacation) {
		t.Fatalf("confirmed leave did not preserve the original dates: %+v", got)
	}
}

func TestP0DeliveryConfirmationCoversBatchRestoreAndUndo(t *testing.T) {
	f := newFixture(t)
	f.scheduledRequest("首个核心交付", "P0", "2026-11-16")
	scheduled := f.scheduledRequest("后续交付", "P1", "2026-11-17")
	_, before := f.call("POST", "/api/versions", map[string]any{"baseRevision": scheduled.Revision, "label": "变更前"}, 200, true)
	first, second := before.Requests[0], before.Requests[1]
	first.Days, first.Delivery = 5, ""
	second.Days, second.Delivery = 4, ""
	first.Priority, second.Priority = "P1", "P0"
	input := map[string]any{"baseRevision": before.Revision, "requests": []requests.Request{second, first}, "operation": "sequence"}
	changes := []store.P0DeliveryChange{
		{RequestID: first.ID, Name: first.Name, Before: "2026-11-18", After: "2026-11-20", BeforeDays: new(3), AfterDays: new(5)},
		{RequestID: second.ID, Name: second.Name, Before: "2026-11-19", After: "2026-11-20", BeforeDays: new(3), AfterDays: new(4)},
	}
	header := f.requireDeliveryConfirmation("POST", "/api/requests/batch", input, changes)
	f.assertDeliveryPreviewDidNotSave(before)
	_, after := f.call("POST", "/api/requests/batch", input, 200, true, header)
	if after.Revision != before.Revision+1 || after.Requests[0].Delivery != changes[0].After || after.Requests[1].Delivery != changes[1].After {
		t.Fatal("batch did not save both delivery changes")
	}

	restoreInput := map[string]any{"baseRevision": after.Revision}
	restorePath := "/api/versions/" + before.Versions[0].ID + "/restore"
	reversed := append([]store.P0DeliveryChange(nil), changes...)
	for index := range reversed {
		reversed[index].Before, reversed[index].After = reversed[index].After, reversed[index].Before
		reversed[index].BeforeDays, reversed[index].AfterDays = reversed[index].AfterDays, reversed[index].BeforeDays
	}
	header = f.requireDeliveryConfirmation("POST", restorePath, restoreInput, reversed)
	f.assertDeliveryPreviewDidNotSave(after)
	_, restored := f.call("POST", restorePath, restoreInput, 200, true, header)

	undoInput := map[string]any{"baseRevision": restored.Revision}
	undoPath := fmt.Sprintf("/api/history/%d/undo", restored.Logs[0].ID)
	header = f.requireDeliveryConfirmation("POST", undoPath, undoInput, changes)
	f.assertDeliveryPreviewDidNotSave(restored)
	_, undone := f.call("POST", undoPath, undoInput, 200, true, header)
	if undone.Requests[0].Delivery != changes[0].After || undone.Requests[1].Delivery != changes[1].After || !undone.Logs[1].Undone {
		t.Fatal("confirmed undo did not restore the previous deliveries and mark the log")
	}
}

func TestCalendarImportConfirmsCalculatedP0Delivery(t *testing.T) {
	f := newFixture(t)
	planned := f.scheduledRequest("已归档的旧排期", "P0", "2028-01-03")
	data := requests.Empty()
	row := planned.Requests[0]
	row.Archived, row.Delivery, row.Segments = true, "", nil
	data.Requests, data.NextID = []requests.Request{row}, row.ID+1
	payload, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.DB.Exec("update metadata set payload=? where id=1", string(payload)); err != nil {
		t.Fatal(err)
	}
	before := f.state()
	input := map[string]any{"baseRevision": before.Revision, "year": 2028, "calendar": map[string]any{
		"year": 2028, "days": []map[string]any{{"date": "2028-01-03", "name": "元旦", "isOffDay": true}},
	}}
	header := f.requireDeliveryConfirmation("POST", "/api/calendar/import", input,
		[]store.P0DeliveryChange{{RequestID: row.ID, Name: row.Name, Before: "2028-01-05", After: "2028-01-06"}})
	f.assertDeliveryPreviewDidNotSave(before)
	_, confirmed := f.call("POST", "/api/calendar/import", input, 200, true, header)
	if confirmed.Revision != before.Revision+1 || len(confirmed.Calendar.Years) != len(before.Calendar.Years)+1 {
		t.Fatal("calendar import was not committed")
	}
}
