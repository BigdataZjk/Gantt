package server_test

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
	"time"

	"rsm/internal/requests"
	"rsm/internal/store"
)

func TestRequestTimesAreServerOwnedAndSurviveEdits(t *testing.T) {
	f := newFixture(t)
	input := example("时间顺序")
	input.PoolEnteredAt, input.ArchivedAt = "2099-01-01T00:00:00Z", "2099-01-01T00:00:00Z"
	_, state := f.call("POST", "/api/requests", map[string]any{"baseRevision": f.state().Revision, "request": input}, 200, true)
	row := state.Requests[0]
	entered := row.PoolEnteredAt
	if _, err := time.Parse(time.RFC3339Nano, entered); err != nil || entered == input.PoolEnteredAt || row.ArchivedAt != "" {
		t.Fatal("create must assign actual server time", row)
	}
	row.PoolEnteredAt, row.ArchivedAt = input.PoolEnteredAt, input.ArchivedAt
	row.Name = "修改说明"
	_, state = f.call("PUT", fmt.Sprint("/api/requests/", row.ID), map[string]any{"baseRevision": state.Revision, "request": row}, 200, true)
	if state.Requests[0].PoolEnteredAt != entered || state.Requests[0].ArchivedAt != "" {
		t.Fatal("editing overwrote lifecycle timestamps")
	}
	row = state.Requests[0]
	row.PoolEnteredAt, row.ArchivedAt = "", input.ArchivedAt
	_, state = f.call("POST", "/api/requests/batch", map[string]any{"baseRevision": state.Revision, "requests": []requests.Request{row}}, 200, true)
	if state.Requests[0].PoolEnteredAt != entered || state.Requests[0].ArchivedAt != "" {
		t.Fatal("batch overwrote lifecycle timestamps")
	}
	_, state = f.call("POST", fmt.Sprint("/api/requests/", row.ID, "/archive"), map[string]any{"baseRevision": state.Revision, "archived": true}, 200, true)
	archived := state.Requests[0].ArchivedAt
	if !requestTimeAfter(t, archived, entered) || state.Requests[0].PoolEnteredAt != entered {
		t.Fatal("archive time was not recorded")
	}
	_, state = f.call("POST", fmt.Sprint("/api/requests/", row.ID, "/archive"), map[string]any{"baseRevision": state.Revision, "archived": false}, 200, true)
	if !requestTimeAfter(t, state.Requests[0].PoolEnteredAt, archived) || state.Requests[0].ArchivedAt != archived {
		t.Fatal("restoring must record the new pool entry")
	}
	_, state = f.call("POST", fmt.Sprint("/api/requests/", row.ID, "/archive"), map[string]any{"baseRevision": state.Revision, "archived": true}, 200, true)
	if !requestTimeAfter(t, state.Requests[0].ArchivedAt, archived) {
		t.Fatal("rearchiving must refresh archive time")
	}
}

func TestLegacyRequestTimesBackfillFromHistory(t *testing.T) {
	f := newFixture(t)
	f.create("早期创建后归档")
	state := f.create("后期创建先归档")
	for _, id := range []int{2, 1} {
		_, state = f.call("POST", fmt.Sprint("/api/requests/", id, "/archive"), map[string]any{"baseRevision": state.Revision, "archived": true}, 200, true)
	}
	expected := append([]requests.Request(nil), state.Requests...)
	for i := range state.Requests {
		state.Requests[i].PoolEnteredAt, state.Requests[i].ArchivedAt = "", ""
	}
	var raw string
	if err := f.db.DB.QueryRow("select payload from metadata where id=1").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	data, err := store.DecodeData(raw)
	if err != nil {
		t.Fatal(err)
	}
	data.Requests = state.Requests
	payload, _ := json.Marshal(data)
	if _, err = f.db.DB.Exec("update metadata set payload=? where id=1", string(payload)); err != nil {
		t.Fatal(err)
	}
	home := f.db.Home
	f.db.Close()
	reopened, err := store.Open(home)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if err = reopened.DB.QueryRow("select payload from metadata where id=1").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	got, err := store.DecodeData(raw)
	if err != nil {
		t.Fatal(err)
	}
	for i, row := range got.Requests {
		if row.PoolEnteredAt == "" || row.ArchivedAt == "" || row.Archived != expected[i].Archived || row.Revision != expected[i].Revision {
			t.Fatal("backfill changed business data or lost timestamps", row)
		}
		original := expected[i]
		row.PoolEnteredAt, row.ArchivedAt = "", ""
		original.PoolEnteredAt, original.ArchivedAt = "", ""
		if !reflect.DeepEqual(row, original) {
			t.Fatal("backfill changed request data", row, original)
		}
	}
	if !requestTimeAfter(t, got.Requests[0].ArchivedAt, got.Requests[1].ArchivedAt) {
		t.Fatal("legacy archive order incorrectly followed creation order")
	}
	if _, err = reopened.DB.Exec("delete from history"); err != nil {
		t.Fatal(err)
	}
	reopened.Close()
	persisted, err := store.Open(home)
	if err != nil {
		t.Fatal(err)
	}
	defer persisted.Close()
	var after string
	if err = persisted.DB.QueryRow("select payload from metadata where id=1").Scan(&after); err != nil || after != raw {
		t.Fatal("clearing history changed persisted request times", err)
	}
}

func requestTimeAfter(t *testing.T, later, earlier string) bool {
	t.Helper()
	next, err := time.Parse(time.RFC3339Nano, later)
	if err != nil {
		t.Fatal(err)
	}
	previous, err := time.Parse(time.RFC3339Nano, earlier)
	if err != nil {
		t.Fatal(err)
	}
	return next.After(previous)
}
