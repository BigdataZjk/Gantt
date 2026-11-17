package server_test

import (
	"fmt"
	"net/http"
	"reflect"
	"testing"

	"rsm/internal/schedule"
	"rsm/internal/server"
	"rsm/internal/store"
)

func TestCalendarImportIsPersistentAndUsedForNewSchedules(t *testing.T) {
	f := newFixture(t)
	state := f.state()
	row := example("日历更新前需求")
	row.Developer = state.Me.ID
	row.Start = "2028-01-03"
	row.Days = 1
	_, before := f.call("POST", "/api/requests", map[string]any{"baseRevision": state.Revision, "request": row}, 200, true)
	original := before.Requests[0]
	imported := map[string]any{"year": 2028, "papers": []string{"https://example.test/notice"}, "days": []map[string]any{
		{"date": "2028-01-03", "name": "元旦", "isOffDay": true},
		{"date": "2028-01-08", "name": "元旦", "isOffDay": false},
	}}
	input := map[string]any{"baseRevision": before.Revision, "year": 2028, "calendar": imported}
	f.call("POST", "/api/calendar/import", input, 401, false)
	_, updated := f.call("POST", "/api/calendar/import", input, 200, true)
	if updated.Revision != before.Revision+1 || len(updated.Calendar.Years) != 4 || schedule.IsWorkday("2028-01-03", updated.Calendar) || !schedule.IsWorkday("2028-01-08", updated.Calendar) || !reflect.DeepEqual(original, updated.Requests[0]) {
		t.Fatal("import lost other years, moved an existing request or failed to publish calendar")
	}
	if updated.Logs[0].Reversible || updated.Calendar.Editions[3].UpdatedAt == "" {
		t.Fatal("calendar metadata or audit contract")
	}
	f.call("POST", "/api/calendar/import", input, 409, true)
	bad := map[string]any{"baseRevision": updated.Revision, "year": 2028, "calendar": map[string]any{"year": 2028, "days": []any{}}}
	f.call("POST", "/api/calendar/import", bad, 400, true)
	if after := f.state(); after.Revision != updated.Revision || !reflect.DeepEqual(after.Calendar, updated.Calendar) {
		t.Fatal("failed import altered calendar")
	}
	row.Name = "日历更新后需求"
	_, created := f.call("POST", "/api/requests", map[string]any{"baseRevision": updated.Revision, "request": row}, 200, true)
	for _, request := range created.Requests {
		if request.Name == row.Name && request.Delivery != "2028-01-04" {
			t.Fatalf("server did not use imported calendar: %+v", request)
		}
	}
	home := f.db.Home
	if err := f.db.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := store.Open(home)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { reopened.Close() })
	f.app = server.New(reopened, nil, "test")
	_, guest := f.call("GET", "/api/state", nil, 200, false)
	if !reflect.DeepEqual(guest.Calendar, updated.Calendar) {
		t.Fatal("calendar lost after restart or omitted for guests")
	}
}

func TestCalendarManagementPermissions(t *testing.T) {
	f := newFixture(t)
	owner := f.cookie
	for _, role := range []string{"readonly", "collaborator", "admin"} {
		f.cookie = owner
		name := fmt.Sprint("日历权限", role)
		f.call("POST", "/api/users", map[string]any{"username": name, "password": "calendar-test-password", "role": role}, 200, true)
		f.call("POST", "/api/login", map[string]any{"username": name, "password": "calendar-test-password"}, 200, true)
		state := f.state()
		want := http.StatusForbidden
		if role == "admin" {
			want = http.StatusBadRequest
		}
		f.call("POST", "/api/calendar/import", map[string]any{"baseRevision": state.Revision, "year": 2028, "calendar": nil}, want, true)
		f.call("POST", "/api/calendar/refresh", map[string]any{"baseRevision": state.Revision, "year": 1999}, want, true)
	}
}
