package server_test

import "testing"

func TestAnnouncementUpdateRequiresSuperAdmin(t *testing.T) {
	f := newFixture(t)
	const path = "/api/announcement"
	before := f.state()
	if before.Announcement != "" {
		t.Fatal("an instance without an announcement should have no default text")
	}
	input := map[string]any{"baseRevision": before.Revision, "text": "  排期同步：本周五评审。  "}
	f.call("PUT", path, input, 401, false)
	f.call("PUT", path, map[string]any{"baseRevision": before.Revision, "text": " \n "}, 400, true)
	f.call("PUT", path, map[string]any{"baseRevision": before.Revision}, 400, true)

	_, after := f.call("PUT", path, input, 200, true)
	if after.Announcement != "排期同步：本周五评审。" || after.Revision != before.Revision+1 || after.Logs[0].Action != "更新系统公告" {
		t.Fatal("announcement was not saved and logged at the next shared revision")
	}
	f.call("PUT", path, input, 409, true)
	_, guest := f.call("GET", "/api/state", nil, 200, false)
	if guest.Announcement != after.Announcement {
		t.Fatal("guests should receive the same announcement")
	}

	input["baseRevision"], input["text"] = after.Revision, "尝试覆盖公告"
	for _, role := range []string{"admin", "collaborator", "readonly"} {
		t.Run(role, func(t *testing.T) {
			if _, err := f.db.DB.Exec("update users set role=? where id=?", role, before.Me.ID); err != nil {
				t.Fatal(err)
			}
			f.call("PUT", path, input, 403, true)
			current := f.state()
			if current.Announcement != after.Announcement || current.Revision != after.Revision {
				t.Fatal("a denied update changed the announcement or shared revision")
			}
		})
	}
}
