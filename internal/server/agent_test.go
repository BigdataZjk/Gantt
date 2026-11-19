package server_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"slices"
	"testing"

	"rsm/internal/requests"
	"rsm/internal/schedule"
	"rsm/internal/server"
)

func TestAgentSnapshot(t *testing.T) {
	f := newFixture(t)
	const path = "/api/agent/snapshot"
	fetch := func() server.AgentSnapshot {
		t.Helper()
		res, _ := f.call(http.MethodGet, path, nil, http.StatusOK, false)
		if res.Header().Get("Cache-Control") != "no-store" || len(res.Result().Cookies()) != 0 {
			t.Fatal("agent snapshot should not be cached or establish a session")
		}
		var snap server.AgentSnapshot
		decoder := json.NewDecoder(res.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&snap); err != nil {
			t.Fatal(err)
		}
		return snap
	}
	if snap := fetch(); snap.Requests == nil || snap.Support == nil || len(snap.Requests)+len(snap.Support) != 0 {
		t.Fatal("empty snapshot should return empty arrays", snap.Requests, snap.Support)
	}
	_, state := f.call(http.MethodPost, "/api/users", map[string]any{
		"username": "协作同事", "password": "fixture", "role": "admin",
	}, http.StatusOK, true)
	create := func(row requests.Request) requests.Request {
		t.Helper()
		_, state = f.call(http.MethodPost, "/api/requests", map[string]any{
			"baseRevision": state.Revision, "request": row,
		}, http.StatusOK, true)
		return state.Requests[len(state.Requests)-1]
	}
	target := example("补位目标")
	target.Developer = state.Users[1].ID
	target.Start, target.Delivery = "2026-09-22", "2026-09-24"
	target = create(target)
	anchor := example("安排补位的需求行")
	anchor.Developer, anchor.Days, anchor.Status = state.Me.ID, 5, "开发中"
	anchor.Notes = "保留所有需求字段"
	anchor.Segments = []schedule.Segment{
		{Start: "2026-09-17", End: "2026-09-20"},
		{Start: "2026-09-22", End: "2026-09-23", HoldBefore: true},
	}
	anchor.Vacation = []string{"2026-09-18", "2026-09-23"}
	anchor.Overtime = []string{"2026-09-19"}
	anchor.SupportSegments = []requests.SupportSegment{{RequestID: target.ID, Start: "2026-09-19", End: "2026-09-28"}}
	anchor = create(anchor)
	unscheduled := create(example("未排期需求"))
	placeholder := example("待估占位需求")
	placeholder.Start, placeholder.Days = "2026-09-25", 0
	placeholder = create(placeholder)
	_, state = f.call(http.MethodPost, fmt.Sprintf("/api/requests/%d/archive", target.ID), map[string]any{
		"baseRevision": state.Revision, "archived": true,
	}, http.StatusOK, true)

	report := fetch()
	if report.Revision != state.Revision || report.ServerVersion != "test" || len(report.Requests) != 4 || len(report.Support) != 1 {
		t.Fatal("incomplete snapshot", report.Revision, len(report.Requests), len(report.Support))
	}
	if !slices.Equal(report.Calendar.WorkDays, state.Calendar.WorkDays) || !slices.Equal(report.Calendar.RestDays, state.Calendar.RestDays) {
		t.Fatal("snapshot uses a different calendar")
	}
	rows := make(map[int64]server.AgentRequest, len(report.Requests))
	for _, row := range report.Requests {
		rows[row.Request.Id] = row
	}
	owner := rows[anchor.ID]
	if owner.DeveloperName != state.Me.Username || owner.Request.Notes != anchor.Notes || owner.Request.Days != 5 || len(owner.Schedule.Segments) != 2 {
		t.Fatal("missing demand fields or schedule segments", owner)
	}
	if got, want := owner.Schedule.ScheduledDates, []string{"2026-09-17", "2026-09-19", "2026-09-20", "2026-09-22"}; !slices.Equal(got, want) || owner.Schedule.ScheduledDays != len(want) {
		t.Fatalf("development dates = %v, want %v", got, want)
	}
	hold := []server.AgentScheduleGap{{Start: "2026-09-21", End: "2026-09-21", Workdays: 1, Hold: true}}
	if !reflect.DeepEqual(owner.Schedule.Gaps, hold) {
		t.Fatal("HOLD gap was lost or counted as development", owner.Schedule.Gaps)
	}
	archived := rows[target.ID]
	if !archived.Request.Archived || archived.DeveloperName != "协作同事" || archived.Schedule.ScheduledDays != 3 {
		t.Fatal("archived single-segment schedule was lost", archived)
	}
	if row := rows[unscheduled.ID]; row.Schedule.Segments == nil || len(row.Schedule.Segments) != 0 || row.Schedule.ScheduledDays != 0 || row.Schedule.Placeholder {
		t.Fatal("an unscheduled estimate must occupy no dates", row.Schedule)
	}
	if row := rows[placeholder.ID]; !row.Schedule.Placeholder || !slices.Equal(row.Schedule.ScheduledDates, []string{"2026-09-28", "2026-09-29", "2026-09-30"}) {
		t.Fatal("estimated placeholder differs from the Gantt schedule", row.Schedule)
	}
	support := report.Support[0]
	if support.GanttRowRequestId != anchor.ID || support.TargetRequestId != target.ID || support.TargetRequestName != target.Name || support.SupporterId != anchor.Developer || support.SupporterName != owner.DeveloperName {
		t.Fatal("support was not attributed to the person on the Gantt row", support)
	}
	if got, want := support.ScheduledDates, []string{"2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-24", "2026-09-28"}; !slices.Equal(got, want) || support.ScheduledDays != len(want) {
		t.Fatalf("support dates = %v, want %v", got, want)
	}
	if f.state().Revision != state.Revision {
		t.Fatal("reading the snapshot changed state")
	}

	anchor.Overtime = []string{}
	f.call(http.MethodPut, fmt.Sprintf("/api/requests/%d", anchor.ID), map[string]any{
		"baseRevision": state.Revision, "request": anchor,
	}, http.StatusOK, true)
	updated := fetch().Support[0]
	if updated.Start != support.Start || updated.End != support.End || !slices.Equal(updated.ScheduledDates, support.ScheduledDates[1:]) {
		t.Fatal("revoking overtime must update effective dates and retain the saved support range", updated)
	}
}
