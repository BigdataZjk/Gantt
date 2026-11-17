package server_test

import (
	"encoding/json"
	"testing"

	"rsm/internal/server"
	"rsm/internal/store"
)

func TestNonemptyPasswordsAcrossAccountFlows(t *testing.T) {
	db, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	f := &fixture{t: t, db: db, app: server.New(db, nil, "test")}
	f.call("POST", "/api/setup", map[string]any{"password": ""}, 400, true)
	f.call("POST", "/api/setup", map[string]any{"password": "初"}, 200, true)
	f.call("POST", "/api/logout", nil, 200, true)
	f.call("POST", "/api/login", map[string]any{"username": "张金科", "password": "初"}, 200, true)
	f.call("POST", "/api/auth/password", map[string]any{"currentPassword": "初", "password": ""}, 400, true)
	f.call("POST", "/api/auth/password", map[string]any{"currentPassword": "初", "password": " "}, 200, true)
	f.call("POST", "/api/logout", nil, 200, true)
	f.call("POST", "/api/login", map[string]any{"username": "张金科", "password": ""}, 401, true)
	f.call("POST", "/api/login", map[string]any{"username": "张金科", "password": " "}, 200, true)
	f.call("POST", "/api/users", map[string]any{"username": "单字符账号", "password": "", "role": "collaborator"}, 400, true)
	_, state := f.call("POST", "/api/users", map[string]any{"username": "单字符账号", "password": "🙂", "role": "collaborator"}, 200, true)
	id := ""
	for _, user := range state.Users {
		if user.Username == "单字符账号" {
			id = user.ID
		}
	}
	if id == "" {
		t.Fatal("single-character account not created")
	}
	superSession := f.cookie
	f.call("POST", "/api/login", map[string]any{"username": "单字符账号", "password": "🙂"}, 200, true)
	f.cookie = superSession
	f.call("PATCH", "/api/users/"+id, map[string]any{"password": "x"}, 200, true)
	f.call("PATCH", "/api/users/"+id, map[string]any{"role": "collaborator", "password": ""}, 200, true)
	reveal, _ := f.call("GET", "/api/auth/password/"+id, nil, 200, true)
	var result struct {
		Password string `json:"password"`
	}
	if err := json.Unmarshal(reveal.Body.Bytes(), &result); err != nil || result.Password != "x" {
		t.Fatal("administrator reset did not preserve single-character password")
	}
	f.call("POST", "/api/login", map[string]any{"username": "单字符账号", "password": "x"}, 200, true)
}
