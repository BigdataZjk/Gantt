package server_test

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"

	"rsm/internal/history"
	"rsm/internal/store"
)

func logPreview(t *testing.T, response *httptest.ResponseRecorder) history.CleanupPreview {
	t.Helper()
	var preview history.CleanupPreview
	if e := json.Unmarshal(response.Body.Bytes(), &preview); e != nil {
		t.Fatal(e)
	}
	return preview
}

func confirmCleanup(base int64, preview history.CleanupPreview) map[string]any {
	return map[string]any{"baseRevision": base, "scope": preview.Scope, "days": preview.Days, "before": preview.Before, "token": preview.Token}
}

func TestLogManagementAPIEnforcesAdministratorPermissions(t *testing.T) {
	f := newFixture(t)
	for _, role := range []string{"guest", "readonly", "collaborator", "admin", "superadmin"} {
		if role != "guest" {
			if _, e := f.db.DB.Exec("update users set role=? where id=(select user_id from sessions limit 1)", role); e != nil {
				t.Fatal(e)
			}
		}
		want := 403
		if role == "guest" {
			want = 401
		}
		if role == "admin" || role == "superadmin" {
			want = 200
		}
		f.call("GET", "/api/logs/management", nil, want, role != "guest")
		f.call("POST", "/api/logs/cleanup/preview", map[string]any{"scope": "operations", "days": 30}, want, role != "guest")
		f.call("PUT", "/api/logs/policy", map[string]any{"baseRevision": f.state().Revision, "operationRetentionDays": 0, "archiveRetentionDays": 0}, want, role != "guest")
		cleanupWant := want
		if want == 200 {
			cleanupWant = 409
		}
		f.call("POST", "/api/logs/cleanup", map[string]any{"baseRevision": f.state().Revision, "scope": "operations", "days": 30, "before": "2020-01-01T00:00:00Z", "token": "untrusted"}, cleanupWant, role != "guest")
	}
	if _, e := f.db.DB.Exec("update users set disabled=1"); e != nil {
		t.Fatal(e)
	}
	f.call("GET", "/api/logs/management", nil, 401, true)
}

func TestLogAPIRejectsMissingInvalidAndUnknownFields(t *testing.T) {
	f := newFixture(t)
	base := f.state().Revision
	for _, input := range []map[string]any{
		{}, {"baseRevision": base},
		{"baseRevision": base, "operationRetentionDays": nil, "archiveRetentionDays": 0},
		{"baseRevision": base, "operationRetentionDays": -1, "archiveRetentionDays": 0},
		{"baseRevision": base, "operationRetentionDays": 0, "archiveRetentionDays": 3651},
		{"baseRevision": base, "operationRetentionDays": 1.5, "archiveRetentionDays": 0},
		{"baseRevision": base, "operationRetentionDays": 0, "archiveRetentionDays": 0, "unknown": true},
	} {
		f.call("PUT", "/api/logs/policy", input, 400, true)
	}
	for _, input := range []map[string]any{
		{}, {"scope": "operations"}, {"scope": "operations", "days": nil},
		{"scope": "operations", "days": 0}, {"scope": "operations", "days": 3651},
		{"scope": "operations", "days": 1.5}, {"scope": "all", "days": 7},
		{"scope": "archives", "days": 7, "path": "../../data"},
	} {
		f.call("POST", "/api/logs/cleanup/preview", input, 400, true)
	}
	f.call("POST", "/api/logs/cleanup", map[string]any{"baseRevision": base, "scope": "operations", "days": 7}, 400, true)
	if f.state().Revision != base {
		t.Fatal("invalid requests mutated data")
	}
}

func TestLogCleanupAPIRefreshesStateAndPreservesRetainedUndo(t *testing.T) {
	f := newFixture(t)
	first := f.create("保留需求甲")
	oldID := first.Logs[0].ID
	if _, e := f.db.DB.Exec("update history set created_at='2000-01-01T00:00:00Z' where id=?", oldID); e != nil {
		t.Fatal(e)
	}
	second := f.create("可撤回需求乙")
	undoID := second.Logs[0].ID
	res, _ := f.call("POST", "/api/logs/cleanup/preview", map[string]any{"scope": "operations", "days": 7}, 200, true)
	preview := logPreview(t, res)
	if preview.Count != 1 || preview.ReversibleCount != 1 {
		t.Fatal(preview)
	}
	f.call("POST", "/api/logs/cleanup", confirmCleanup(second.Revision-1, preview), 409, true)
	res, _ = f.call("POST", "/api/logs/cleanup", confirmCleanup(second.Revision, preview), 200, true)
	var result struct {
		State   store.Snapshot     `json:"state"`
		Cleanup history.CleanupRun `json:"cleanup"`
	}
	if e := json.Unmarshal(res.Body.Bytes(), &result); e != nil {
		t.Fatal(e)
	}
	if result.Cleanup.OperationsDeleted != 1 || result.State.Revision != second.Revision+1 || len(result.State.Requests) != 2 || result.State.Me == nil {
		t.Fatal("cleanup response did not include fresh application state", res.Body.String())
	}
	f.call("POST", fmt.Sprintf("/api/history/%d/undo", oldID), map[string]any{"baseRevision": result.State.Revision}, 404, true)
	_, restored := f.call("POST", fmt.Sprintf("/api/history/%d/undo", undoID), map[string]any{"baseRevision": result.State.Revision}, 200, true)
	if len(restored.Requests) != 1 || restored.Requests[0].Name != "保留需求甲" {
		t.Fatal("retained undo was broken by cleanup", restored.Requests)
	}
	for _, item := range restored.Logs {
		if item.ID == oldID {
			t.Fatal("undo restored a deleted log entry")
		}
	}
}
