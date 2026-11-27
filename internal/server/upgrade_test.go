package server_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"rsm/internal/server"
	"rsm/internal/upgrade"
)

func TestWebUpgradePermissions(t *testing.T) {
	f := newFixture(t)
	routes := []struct{ method, path string }{
		{"GET", "/api/upgrade"},
		{"POST", "/api/upgrade/source"},
		{"POST", "/api/upgrade/apply"},
	}
	for _, route := range routes {
		f.call(route.method, route.path, nil, 401, false)
		if route.method == "POST" {
			f.call(route.method, route.path, nil, 403, true, http.Header{"Origin": {"https://other.example"}})
		}
	}
	res, _ := f.call("GET", "/api/upgrade", nil, 200, true)
	var status server.UpgradeState
	if err := json.Unmarshal(res.Body.Bytes(), &status); err != nil || status.Available || status.MaxSourceBytes != upgrade.MaxSourceBytes {
		t.Fatalf("development instance offered web upgrade: %v (%v)", status, err)
	}
	f.call("POST", "/api/upgrade/source", nil, 400, true)
	f.call("POST", "/api/upgrade/apply", nil, 400, true)
	id := f.state().Me.ID
	for _, role := range []string{"admin", "collaborator", "readonly"} {
		if _, err := f.db.DB.Exec("update users set role=? where id=?", role, id); err != nil {
			t.Fatal(err)
		}
		for _, route := range routes {
			f.call(route.method, route.path, nil, 403, true)
		}
	}
}
