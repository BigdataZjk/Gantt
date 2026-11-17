package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"rsm/internal/auth"
	"rsm/internal/requests"
	"rsm/internal/schedule"
	"rsm/internal/server"
	"rsm/internal/store"
)

type fixture struct {
	t      *testing.T
	db     *store.Store
	app    *server.Server
	cookie *http.Cookie
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	db, e := store.Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.Close() })
	f := &fixture{t: t, db: db, app: server.New(db, nil, "test")}
	_, state := f.call("POST", "/api/setup", map[string]any{"password": "test-password-123"}, 200, true)
	if state.Me == nil || state.Me.Username != "张金科" || state.Me.Role != "superadmin" {
		t.Fatal("missing initial superadmin")
	}
	return f
}
func (f *fixture) call(method, path string, value any, want int, logged bool) (*httptest.ResponseRecorder, store.Snapshot) {
	f.t.Helper()
	var body io.Reader
	switch b := value.(type) {
	case []byte:
		body = bytes.NewReader(b)
	case nil:
	default:
		raw, e := json.Marshal(value)
		if e != nil {
			f.t.Fatal(e)
		}
		body = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, body)
	req.Header.Set("Content-Type", "application/json")
	if logged && f.cookie != nil {
		req.AddCookie(f.cookie)
	}
	res := httptest.NewRecorder()
	f.app.ServeHTTP(res, req)
	if res.Code != want {
		f.t.Fatalf("%s %s: status %d want %d: %s", method, path, res.Code, want, res.Body.String())
	}
	for _, cookie := range res.Result().Cookies() {
		if cookie.Name == "rsm_session" && logged {
			f.cookie = cookie
		}
	}
	var snap store.Snapshot
	if want == 200 {
		_ = json.Unmarshal(res.Body.Bytes(), &snap)
	}
	return res, snap
}
func (f *fixture) state() store.Snapshot {
	_, snap := f.call("GET", "/api/state", nil, 200, true)
	return snap
}
func example(name string) requests.Request {
	return requests.Request{Name: name, Priority: "P1", Status: "待评审", RequestType: "常规需求", PRD: "https://example.test/prd", Requester: "产品团队", RequestedAt: "2026-11-16", Days: 3, Segments: []schedule.Segment{}, Vacation: []string{}, Overtime: []string{}}
}

func TestLoginRememberControlsCookieLifetime(t *testing.T) {
	f := newFixture(t)
	for _, tc := range []struct {
		name     string
		remember any
		maxAge   int
	}{
		{"default", nil, 30 * 24 * 60 * 60},
		{"persistent", true, 30 * 24 * 60 * 60},
		{"session", false, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := map[string]any{"username": "张金科", "password": "test-password-123"}
			if tc.remember != nil {
				input["remember"] = tc.remember
			}
			res, state := f.call("POST", "/api/login", input, 200, true)
			c := f.cookie
			if state.Me == nil || c == nil || c.MaxAge != tc.maxAge || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/" {
				t.Fatal("login cookie contract", res.Header().Get("Set-Cookie"))
			}
			if tc.maxAge == 0 && (!c.Expires.IsZero() || strings.Contains(res.Header().Get("Set-Cookie"), "Max-Age")) {
				t.Fatal("session cookie has a persistent lifetime")
			}
			if f.state().Me == nil {
				t.Fatal("login did not establish a session")
			}
			f.call("POST", "/api/logout", nil, 200, true)
			if f.cookie.MaxAge >= 0 {
				t.Fatal("logout did not clear cookie")
			}
			f.cookie = c
			if f.state().Me != nil {
				t.Fatal("logged out session remained usable")
			}
		})
	}
}
func (f *fixture) create(name string) store.Snapshot {
	returnVal := f.state()
	_, out := f.call("POST", "/api/requests", map[string]any{"baseRevision": returnVal.Revision, "request": example(name)}, 200, true)
	return out
}
func TestCRUDArchiveConflictAndUndo(t *testing.T) {
	f := newFixture(t)
	_, guest := f.call("GET", "/api/state", nil, 200, false)
	if guest.Me != nil || guest.SetupRequired || len(guest.Requests) != 0 {
		t.Fatal("guest state")
	}
	f.call("POST", "/api/requests", map[string]any{"baseRevision": guest.Revision, "request": example("游客需求")}, 401, false)
	first := f.create("订单数据接口")
	row := first.Requests[0]
	original := row
	row.Start = "2026-11-16"
	row.Developer = first.Me.ID
	_, planned := f.call("PUT", fmt.Sprint("/api/requests/", row.ID), map[string]any{"baseRevision": first.Revision, "request": row}, 200, true)
	if planned.Requests[0].Delivery != "2026-11-18" || planned.Requests[0].Days != 3 {
		t.Fatal("schedule normalization", planned.Requests[0])
	}
	f.call("PUT", fmt.Sprint("/api/requests/", row.ID), map[string]any{"baseRevision": first.Revision, "request": original}, 409, true)
	afterFailure := f.state()
	if afterFailure.Revision != planned.Revision || len(afterFailure.Logs) != len(planned.Logs) {
		t.Fatal("failed mutation changed database")
	}
	_, archived := f.call("POST", fmt.Sprint("/api/requests/", row.ID, "/archive"), map[string]any{"baseRevision": planned.Revision, "archived": true}, 200, true)
	row = archived.Requests[0]
	row.Name = "should be rejected"
	f.call("PUT", fmt.Sprint("/api/requests/", row.ID), map[string]any{"baseRevision": archived.Revision, "request": row}, 400, true)
	f.call("DELETE", fmt.Sprint("/api/requests/", row.ID), map[string]any{"baseRevision": archived.Revision}, 400, true)
	_, undone := f.call("POST", fmt.Sprint("/api/history/", archived.Logs[0].ID, "/undo"), map[string]any{"baseRevision": archived.Revision}, 200, true)
	if undone.Requests[0].Archived || !undone.Logs[1].Undone {
		t.Fatal("undo did not restore archive state")
	}
}
func TestRoleEnforcementAndImmediateRevocation(t *testing.T) {
	f := newFixture(t)
	adminCookie := f.cookie
	_, state := f.call("POST", "/api/users", map[string]any{"username": "协作甲", "password": "collab-password", "role": "collaborator"}, 200, true)
	var id string
	for _, u := range state.Users {
		if u.Username == "协作甲" {
			id = u.ID
		}
	}
	f.call("POST", "/api/login", map[string]any{"username": "协作甲", "password": "collab-password"}, 200, true)
	collabCookie := f.cookie
	created := f.create("协作者提交")
	row := created.Requests[0]
	row.Start = "2026-11-16"
	f.call("PUT", fmt.Sprint("/api/requests/", row.ID), map[string]any{"baseRevision": created.Revision, "request": row}, 403, true)
	f.call("POST", "/api/domains", map[string]any{"baseRevision": created.Revision, "name": "新域", "color": "#336699"}, 403, true)
	f.call("GET", "/api/auth/password/"+id, nil, 403, true)
	f.cookie = adminCookie
	f.call("PATCH", "/api/users/"+id, map[string]any{"disabled": true}, 200, true)
	f.cookie = collabCookie
	_, guest := f.call("GET", "/api/state", nil, 200, true)
	if guest.Me != nil {
		t.Fatal("disabled session remains active")
	}
	f.call("POST", "/api/requests", map[string]any{"baseRevision": guest.Revision, "request": example("blocked")}, 401, true)
	f.call("POST", "/api/login", map[string]any{"username": "协作甲", "password": "collab-password"}, 401, true)
	if len(guest.Requests) != 1 || guest.Requests[0].Requester != "产品团队" {
		t.Fatal("historical request lost")
	}
}
func TestPublicSnapshotsKeepAccountChanges(t *testing.T) {
	f := newFixture(t)
	created := f.create("快照原始需求")
	_, snap := f.call("POST", "/api/versions", map[string]any{"baseRevision": created.Revision, "label": "迭代前"}, 200, true)
	if len(snap.Versions) != 1 || len(snap.Versions[0].ID) != 4 {
		t.Fatal("snapshot metadata")
	}
	row := snap.Requests[0]
	row.Name = "之后修改"
	f.call("PUT", fmt.Sprint("/api/requests/", row.ID), map[string]any{"baseRevision": snap.Revision, "request": row}, 200, true)
	_, now := f.call("POST", "/api/users", map[string]any{"username": "快照后创建", "password": "snapshot-password", "role": "readonly"}, 200, true)
	_, restored := f.call("POST", "/api/versions/"+snap.Versions[0].ID+"/restore", map[string]any{"baseRevision": now.Revision}, 200, true)
	if restored.Requests[0].Name != "快照原始需求" || len(restored.Users) != 2 {
		t.Fatal("restore rewound account")
	}
	f.call("POST", "/api/login", map[string]any{"username": "快照后创建", "password": "snapshot-password"}, 200, true)
}
func TestTransactionsOnlyOneConcurrentWriterWins(t *testing.T) {
	f := newFixture(t)
	snap := f.state()
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			raw, _ := json.Marshal(map[string]any{"baseRevision": snap.Revision, "request": example(fmt.Sprint("并发", i))})
			r := httptest.NewRequest("POST", "/api/requests", bytes.NewReader(raw))
			r.AddCookie(f.cookie)
			w := httptest.NewRecorder()
			f.app.ServeHTTP(w, r)
			statuses <- w.Code
		}(i)
	}
	wg.Wait()
	close(statuses)
	ok, conflict := 0, 0
	for status := range statuses {
		if status == 200 {
			ok++
		}
		if status == 409 {
			conflict++
		}
	}
	if ok != 1 || conflict != 1 || len(f.state().Requests) != 1 {
		t.Fatal("concurrency lost update", ok, conflict)
	}
}
func TestSecurityValidationPasswordsAndAvatarBytes(t *testing.T) {
	f := newFixture(t)
	snap := f.state()
	f.call("POST", "/api/requests", map[string]any{"request": example("无版本")}, 400, true)
	row := example("非法地址")
	row.PRD = "javascript:alert(1)"
	f.call("POST", "/api/requests", map[string]any{"baseRevision": snap.Revision, "request": row}, 400, true)
	req := httptest.NewRequest("POST", "/api/logout", nil)
	req.Header.Set("Origin", "https://attacker.test")
	req.AddCookie(f.cookie)
	res := httptest.NewRecorder()
	f.app.ServeHTTP(res, req)
	if res.Code != 403 {
		t.Fatal("cross-origin mutation accepted")
	}
	reveal, _ := f.call("GET", "/api/auth/password/"+snap.Me.ID, nil, 200, true)
	if !strings.Contains(reveal.Body.String(), "test-password-123") || reveal.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("superadmin reveal contract")
	}
	// A two-frame GIF must survive upload and retrieval byte for byte.
	image := append([]byte("GIF89a"), bytes.Repeat([]byte{0, 1, 2, 3}, 20)...)
	f.call("POST", "/api/avatar", image, 200, true)
	avatar, _ := f.call("GET", "/api/avatars/"+snap.Me.ID, nil, 200, false)
	if !bytes.Equal(image, avatar.Body.Bytes()) {
		t.Fatal("avatar bytes transformed")
	}
	raw, _ := f.call("GET", "/api/state", nil, 200, false)
	if strings.Contains(raw.Body.String(), "test-password-123") || strings.Contains(raw.Body.String(), "password_hash") || strings.Contains(raw.Body.String(), "password_cipher") {
		t.Fatal("password leaked through public state")
	}
	oldCookie := f.cookie
	f.call("POST", "/api/auth/password", map[string]any{"currentPassword": "test-password-123", "password": "new-test-password"}, 200, true)
	newCookie := f.cookie
	f.cookie = oldCookie
	_, oldState := f.call("GET", "/api/state", nil, 200, true)
	if oldState.Me != nil {
		t.Fatal("old session survived password change")
	}
	f.cookie = newCookie
	if f.state().Me == nil {
		t.Fatal("new session missing after password change")
	}
	var stored string
	if e := f.db.DB.QueryRow("select password_hash from users where id=?", snap.Me.ID).Scan(&stored); e != nil {
		t.Fatal(e)
	}
	if !strings.HasPrefix(stored, "$argon2id$") || auth.Verify("test-password-123", stored) || !auth.Verify("new-test-password", stored) {
		t.Fatal("argon2id verification")
	}
	if _, e := f.db.Session(context.Background(), oldCookie.Value); e == nil {
		t.Fatal("stale persistent session")
	}
}

func TestHistoryUndoBoundaryCountsAllLogsAndKeepsAccounts(t *testing.T) {
	f := newFixture(t)
	created := f.create("起始需求")
	firstID := created.Logs[0].ID
	for i := 0; i < 49; i++ {
		_, state := f.call("POST", "/api/versions", map[string]any{"baseRevision": f.state().Revision, "label": fmt.Sprint("记录", i)}, 200, true)
		if len(state.Logs) != i+3 {
			t.Fatal("missing audit entry")
		}
	}
	snap := f.state()
	if !snap.Logs[49].Reversible || snap.Logs[49].ID != firstID {
		t.Fatal("50th log incorrectly disabled")
	}
	_, now := f.call("POST", "/api/users", map[string]any{"username": "撤回外的账号", "password": "history-password", "role": "readonly"}, 200, true)
	if now.Logs[50].Reversible {
		t.Fatal("51st log incorrectly enabled")
	}
	f.call("POST", fmt.Sprint("/api/history/", firstID, "/undo"), map[string]any{"baseRevision": now.Revision}, 400, true)
	if len(f.state().Requests) != 1 {
		t.Fatal("out of range undo changed requests")
	}
	fresh := f.create("可撤回需求")
	_, undone := f.call("POST", fmt.Sprint("/api/history/", fresh.Logs[0].ID, "/undo"), map[string]any{"baseRevision": fresh.Revision}, 200, true)
	if len(undone.Users) != 2 || len(undone.Requests) != 1 || !undone.Logs[1].Undone {
		t.Fatal("undo affected account or failed to mark history")
	}
	f.call("POST", fmt.Sprint("/api/history/", fresh.Logs[0].ID, "/undo"), map[string]any{"baseRevision": undone.Revision}, 400, true)
}

func TestFieldManagementIncludesArchiveAndBatchFailuresRollbackEverything(t *testing.T) {
	f := newFixture(t)
	first := f.create("需求甲")
	second := f.create("需求乙")
	row := second.Requests[0]
	row.Domain = "流量域"
	row.Project = "原项目"
	_, edited := f.call("PUT", fmt.Sprint("/api/requests/", row.ID), map[string]any{"baseRevision": second.Revision, "request": row}, 200, true)
	_, archived := f.call("POST", fmt.Sprint("/api/requests/", row.ID, "/archive"), map[string]any{"baseRevision": edited.Revision, "archived": true}, 200, true)
	f.call("DELETE", "/api/domains/traffic", map[string]any{"baseRevision": archived.Revision}, 400, true)
	_, merged := f.call("POST", "/api/fields/merge", map[string]any{"baseRevision": archived.Revision, "field": "project", "values": []string{"原项目"}, "target": "统一项目"}, 200, true)
	if merged.Requests[0].Project != "统一项目" || !merged.Requests[0].Archived {
		t.Fatal("archive not included in field merge")
	}
	_, restored := f.call("POST", fmt.Sprint("/api/requests/", row.ID, "/archive"), map[string]any{"baseRevision": merged.Revision, "archived": false}, 200, true)
	changes := append([]requests.Request(nil), restored.Requests...)
	changes[0].Name = "不得部分提交"
	changes[1].Revision = first.Requests[0].Revision - 1
	f.call("POST", "/api/requests/batch", map[string]any{"baseRevision": restored.Revision, "requests": changes}, 409, true)
	after := f.state()
	if after.Requests[0].Name != restored.Requests[0].Name || after.Revision != restored.Revision || len(after.Logs) != len(restored.Logs) {
		t.Fatal("batch was partly committed")
	}
}

func TestPreferencesArePersonalAndPresenceDeduplicatesRegisteredUser(t *testing.T) {
	f := newFixture(t)
	before := f.state()
	p := before.Preferences
	p.DefaultRequestType = "数据需求"
	p.DefaultPriority = "P0"
	_, after := f.call("PUT", "/api/preferences", p, 200, true)
	if after.Revision != before.Revision || len(after.Logs) != len(before.Logs) || after.Preferences.DefaultRequestType != "数据需求" {
		t.Fatal("preference changed shared history")
	}
	_, guest := f.call("GET", "/api/state", nil, 200, false)
	if guest.Preferences.DefaultRequestType != "常规需求" {
		t.Fatal("personal preference leaked to guest")
	}
	f.call("POST", "/api/presence", map[string]any{"clientId": "registered-client-1"}, 200, true)
	f.call("POST", "/api/presence", map[string]any{"clientId": "registered-client-2"}, 200, true)
	res, _ := f.call("POST", "/api/presence", map[string]any{"clientId": "guest-client-3"}, 200, false)
	var presence struct {
		Users  []string `json:"users"`
		Guests int      `json:"guests"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &presence); err != nil {
		t.Fatal(err)
	}
	if len(presence.Users) != 1 || presence.Users[0] != before.Me.ID || presence.Guests != 1 {
		t.Fatal("presence slots wrong", presence)
	}
}

func TestReadOnlyPasswordAndUnchangedAccountKeepSessionsAndHistory(t *testing.T) {
	f := newFixture(t)
	before := f.create("保持撤回窗口")
	for i := 0; i < 55; i++ {
		f.call("GET", "/api/auth/password/"+before.Me.ID, nil, 200, true)
	}
	_, unchanged := f.call("PATCH", "/api/users/"+before.Me.ID, map[string]any{}, 200, true)
	if unchanged.Me == nil || unchanged.Revision != before.Revision || len(unchanged.Logs) != len(before.Logs) {
		t.Fatal("read or unchanged account revoked the session or wrote shared history")
	}
	_, unchanged = f.call("PATCH", "/api/users/"+before.Me.ID, map[string]any{"role": "superadmin", "disabled": false, "deleted": false}, 200, true)
	if unchanged.Me == nil || unchanged.Revision != before.Revision {
		t.Fatal("resaving the same account changed its session")
	}
	f.call("POST", fmt.Sprint("/api/history/", before.Logs[0].ID, "/undo"), map[string]any{"baseRevision": unchanged.Revision}, 200, true)
}

func TestSuccessfulLoginsDoNotExhaustFailedAttemptLimit(t *testing.T) {
	f := newFixture(t)
	for i := 0; i < 14; i++ {
		f.call("POST", "/api/login", map[string]any{"username": "张金科", "password": "test-password-123"}, 200, true)
	}
	for i := 0; i < 12; i++ {
		f.call("POST", "/api/login", map[string]any{"username": "张金科", "password": "incorrect-password"}, 401, false)
	}
	f.call("POST", "/api/login", map[string]any{"username": "张金科", "password": "incorrect-password"}, 429, false)
}

func TestDisabledDeveloperKeepsHistoryButCannotReceiveNewAssignments(t *testing.T) {
	f := newFixture(t)
	_, users := f.call("POST", "/api/users", map[string]any{"username": "历史开发人", "password": "developer-password", "role": "readonly"}, 200, true)
	id := ""
	for _, u := range users.Users {
		if u.Username == "历史开发人" {
			id = u.ID
		}
	}
	item := example("已有开发关联")
	item.Developer = id
	_, created := f.call("POST", "/api/requests", map[string]any{"baseRevision": users.Revision, "request": item}, 200, true)
	_, disabled := f.call("PATCH", "/api/users/"+id, map[string]any{"disabled": true}, 200, true)
	item = created.Requests[0]
	item.Notes = "账号停用后仍可维护已有需求"
	_, edited := f.call("PUT", fmt.Sprint("/api/requests/", item.ID), map[string]any{"baseRevision": disabled.Revision, "request": item}, 200, true)
	if edited.Requests[0].Developer != id {
		t.Fatal("historical developer was lost")
	}
	item = example("禁止新分配")
	item.Developer = id
	f.call("POST", "/api/requests", map[string]any{"baseRevision": edited.Revision, "request": item}, 400, true)
	_, deleted := f.call("PATCH", "/api/users/"+id, map[string]any{"deleted": true}, 200, true)
	item = deleted.Requests[0]
	item.Notes = "删除后仍保留原关联"
	f.call("PUT", fmt.Sprint("/api/requests/", item.ID), map[string]any{"baseRevision": deleted.Revision, "request": item}, 200, true)
}

func TestRemovingFinalMarkerDoesNotRecalculateStoredSchedule(t *testing.T) {
	f := newFixture(t)
	state := f.state()
	item := example("标记后的已存排期")
	item.Days = 4
	item.Start, item.Delivery = "2026-12-07", "2026-12-11"
	item.Segments = []schedule.Segment{{Start: "2026-12-07", End: "2026-12-08"}, {Start: "2026-12-10", End: "2026-12-11", HoldBefore: true}}
	item.Vacation = []string{"2026-12-07"}
	_, created := f.call("POST", "/api/requests", map[string]any{"baseRevision": state.Revision, "request": item}, 200, true)
	item = created.Requests[0]
	plan, err := schedule.SetDays(schedule.Plan{Segments: item.Segments, Days: item.Days, Start: item.Start, Delivery: item.Delivery, Vacation: item.Vacation}, schedule.DefaultCalendar(), 5)
	if err != nil {
		t.Fatal(err)
	}
	item.Segments, item.Start, item.Delivery, item.Days = plan.Segments, plan.Start, plan.Delivery, plan.Days
	_, resized := f.call("PUT", fmt.Sprint("/api/requests/", item.ID), map[string]any{"baseRevision": created.Revision, "request": item}, 200, true)
	item = resized.Requests[0]
	before := item
	item.Vacation = []string{}
	_, cleared := f.call("PUT", fmt.Sprint("/api/requests/", item.ID), map[string]any{"baseRevision": resized.Revision, "request": item}, 200, true)
	got := cleared.Requests[0]
	if got.Delivery != before.Delivery || got.Days != before.Days || got.Segments[1] != before.Segments[1] {
		t.Fatal("removing final marker changed the stored estimate or dates", before, got)
	}
	got.Notes = "只改备注"
	_, edited := f.call("PUT", fmt.Sprint("/api/requests/", item.ID), map[string]any{"baseRevision": cleared.Revision, "request": got}, 200, true)
	if edited.Requests[0].Delivery != before.Delivery || edited.Requests[0].Days != before.Days {
		t.Fatal("ordinary edit changed a previously marked schedule")
	}
	invalid := example("拒绝任意人天")
	invalid.Start, invalid.Delivery, invalid.Days = "2026-12-07", "2026-12-07", 100
	invalid.Vacation = []string{"2026-12-07"}
	f.call("POST", "/api/requests", map[string]any{"baseRevision": edited.Revision, "request": invalid}, 400, true)
}
