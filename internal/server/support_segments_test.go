package server_test

import (
	"encoding/json"
	"reflect"
	"testing"

	"rsm/internal/requests"
)

func TestGanttSupportSegments(t *testing.T) {
	f := newFixture(t)
	admin := f.cookie
	f.create("已有排期")
	f.create("协助的需求")
	state := f.create("已归档的需求")
	_, state = f.call("POST", "/api/requests/3/archive", map[string]any{"baseRevision": state.Revision, "archived": true}, 200, true)
	target := state.Requests[1]
	anchor := state.Requests[0]
	anchor.Developer, anchor.Start = state.Me.ID, "2026-11-16"
	anchor.Vacation = []string{"2026-11-19"}
	write := func(row any, status int) {
		t.Helper()
		_, saved := f.call("PUT", "/api/requests/1", map[string]any{"baseRevision": state.Revision, "request": row}, status, true)
		if status == 200 {
			state = saved
		}
	}
	write(anchor, 200)
	anchor = state.Requests[0]
	anchorBefore := anchor
	for _, tc := range []struct {
		name string
		date string
		id   int64
	}{
		{"休假", "2026-11-19", 2},
		{"未加班的休息日", "2026-11-22", 2},
		{"归档目标", "2026-11-20", 3},
		{"不存在的目标", "2026-11-20", 99},
		{"引用当前需求", "2026-11-20", 1},
	} {
		t.Log(tc.name)
		candidate := anchor
		candidate.SupportSegments = []requests.SupportSegment{{RequestID: tc.id, Start: tc.date, End: tc.date}}
		write(candidate, 400)
	}
	if current := f.state(); current.Revision != state.Revision || !reflect.DeepEqual(current.Requests, state.Requests) {
		t.Fatal("invalid support changed saved data")
	}

	anchor.Overtime = []string{"2026-11-22"}
	write(anchor, 200)
	anchor = state.Requests[0]
	anchor.SupportSegments = []requests.SupportSegment{{RequestID: target.ID, Start: "2026-11-22", End: "2026-11-22"}}
	write(anchor, 200)
	anchor = state.Requests[0]
	anchor.SupportSegments = []requests.SupportSegment{{RequestID: target.ID, Start: "2026-11-20", End: "2026-11-24"}}
	write(anchor, 200)
	anchor = state.Requests[0]
	anchor.Overtime = nil
	write(anchor, 200)
	anchor = state.Requests[0]
	if len(anchor.SupportSegments) != 1 || len(anchor.Overtime) != 0 {
		t.Fatal("clearing overtime changed the saved range", anchor)
	}
	if anchor.Start != anchorBefore.Start || anchor.Delivery != anchorBefore.Delivery || anchor.Days != anchorBefore.Days || !reflect.DeepEqual(anchor.Segments, anchorBefore.Segments) || !reflect.DeepEqual(state.Requests[1], target) {
		t.Fatal("support changed the source or target's normal schedule")
	}

	_, state = f.call("POST", "/api/users", map[string]any{"username": "协作者", "password": "test-password", "role": "collaborator"}, 200, true)
	_, state = f.call("POST", "/api/login", map[string]any{"username": "协作者", "password": "test-password"}, 200, true)
	oldClient := state.Requests[0]
	oldClient.SupportSegments = nil
	oldClient.Notes = "旧版客户端正常编辑"
	write(oldClient, 200)
	if !reflect.DeepEqual(state.Requests[0].SupportSegments, anchor.SupportSegments) {
		t.Fatal("omitting supportSegments discarded the saved support")
	}
	raw, err := json.Marshal(state.Requests[0])
	if err != nil {
		t.Fatal(err)
	}
	var clear map[string]any
	if err = json.Unmarshal(raw, &clear); err != nil {
		t.Fatal(err)
	}
	clear["supportSegments"] = []requests.SupportSegment{}
	write(clear, 403)
	f.cookie = admin
	write(clear, 200)
	if got := f.state(); len(got.Requests[0].SupportSegments) != 0 || !reflect.DeepEqual(got.Requests[1], target) {
		t.Fatal("cancelling support changed the target or kept the cancelled range")
	}
}
