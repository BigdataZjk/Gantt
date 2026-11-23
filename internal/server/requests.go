package server

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"rsm/internal/auth"
	"rsm/internal/history"
	"rsm/internal/requests"
	"rsm/internal/settings"
	"rsm/internal/store"
)

type requestInput struct {
	Base    *int64           `json:"baseRevision"`
	Request requests.Request `json:"request"`
}

type requestUpdateInput struct {
	requestInput
	Operation string `json:"operation"`
}

type revisionInput struct {
	Base *int64 `json:"baseRevision"`
}

func (s *Server) createRequest(w http.ResponseWriter, r *http.Request) {
	var in requestInput
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	if e := revision(in.Base); e != nil {
		s.fail(w, e)
		return
	}
	detail := history.Detail{Label: "新增需求", Subject: in.Request.Name}
	rev, e := s.Store.ChangeLogged(r.Context(), actor(r).ID, in.Base, "edit", &detail, true, func(tx *sql.Tx, d *requests.Data, u auth.User) error {
		item := in.Request
		if item.Archived {
			return store.Bad("新增需求不能直接归档")
		}
		if !u.Admin() {
			defaults := settings.Default()
			var raw string
			if e := tx.QueryRowContext(r.Context(), "select preferences from users where id=?", u.ID).Scan(&raw); e != nil {
				return e
			}
			_ = json.Unmarshal([]byte(raw), &defaults)
			blank := requests.Request{Days: 3, RequestType: defaults.DefaultRequestType}
			if !requests.SameSchedule(item, blank) {
				return store.ErrForbidden
			}
		}
		calendar, e := store.ReadCalendar(r.Context(), tx)
		if e != nil {
			return e
		}
		developers, e := store.Developers(r.Context(), tx)
		if e != nil {
			return e
		}
		if e = requests.Validate(&item, *d, developers, calendar); e != nil {
			return store.Bad(e.Error())
		}
		detail.Tags = []history.Value{logValue(item.Priority, "priority"), logValue(item.Status, "status")}
		for _, domain := range d.Domains {
			if domain.Name == item.Domain {
				detail.Tags = append(detail.Tags, history.Value{Text: domain.Name, Kind: "domain", Color: domain.Color})
				break
			}
		}
		item.ID = d.NextID
		item.Revision = 1
		item.RequesterRank = 0
		item.PoolEnteredAt = time.Now().UTC().Format(time.RFC3339Nano)
		item.ArchivedAt = ""
		d.NextID++
		d.Requests = append(d.Requests, item)
		return nil
	})
	s.finish(w, r, rev, e)
}
func requestIndex(d *requests.Data, id int64) int {
	for i, x := range d.Requests {
		if x.ID == id {
			return i
		}
	}
	return -1
}
func (s *Server) updateRequest(w http.ResponseWriter, r *http.Request) {
	var in requestUpdateInput
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	if e := revision(in.Base); e != nil {
		s.fail(w, e)
		return
	}
	if e := validateRequestOperation(in.Operation); e != nil {
		s.fail(w, e)
		return
	}
	id, e := pathID(r)
	if e != nil {
		s.fail(w, e)
		return
	}
	var detail history.Detail
	rev, e := s.Store.ChangeLogged(r.Context(), actor(r).ID, in.Base, "edit", &detail, true, func(tx *sql.Tx, d *requests.Data, u auth.User) error {
		index := requestIndex(d, id)
		if index < 0 {
			return store.ErrNotFound
		}
		old := d.Requests[index]
		item := in.Request
		if old.Archived {
			return store.Bad("归档需求需恢复到需求池后修改")
		}
		if item.Archived != old.Archived || item.ID != id {
			return store.Bad("需求标识或归档属性无效")
		}
		if item.Revision != old.Revision {
			return store.ErrConflict
		}
		if item.SupportSegments == nil {
			item.SupportSegments = old.SupportSegments
		}
		if !u.Admin() && (in.Operation != "" || !requests.SameSchedule(old, item)) {
			return store.ErrForbidden
		}
		calendar, e := store.ReadCalendar(r.Context(), tx)
		if e != nil {
			return e
		}
		developers, e := store.Developers(r.Context(), tx)
		if e != nil {
			return e
		}
		if e = requests.ValidateUpdate(&item, old, *d, developers, calendar); e != nil {
			return store.Bad(e.Error())
		}
		lookup, e := readRequestLogLookup(r.Context(), tx, d)
		if e != nil {
			return e
		}
		detail = lookup.describeRequestEdit(old, item, calendar, in.Operation)
		item.Revision = old.Revision + 1
		item.RequesterRank = old.RequesterRank
		item.PoolEnteredAt, item.ArchivedAt = old.PoolEnteredAt, old.ArchivedAt
		if item.Developer != old.Developer {
			removeGanttOrder(d, old)
		}
		d.Requests[index] = item
		return nil
	})
	s.finish(w, r, rev, e)
}

func validateRequestOperation(operation string) error {
	switch operation {
	case "", "sequence", "ganttUndo":
		return nil
	default:
		return store.Bad("排期操作类型无效")
	}
}

func (s *Server) deleteRequest(w http.ResponseWriter, r *http.Request) {
	var in revisionInput
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	if e := revision(in.Base); e != nil {
		s.fail(w, e)
		return
	}
	id, e := pathID(r)
	if e != nil {
		s.fail(w, e)
		return
	}
	detail := history.Detail{Label: "删除需求"}
	rev, e := s.Store.ChangeLogged(r.Context(), actor(r).ID, in.Base, "edit", &detail, true, func(_ *sql.Tx, d *requests.Data, _ auth.User) error {
		index := requestIndex(d, id)
		if index < 0 {
			return store.ErrNotFound
		}
		if d.Requests[index].Archived {
			return store.Bad("归档需求只能恢复到需求池")
		}
		detail.Subject = d.Requests[index].Name
		detail.Add("位置", history.Text("需求池"), history.Text("已删除"))
		removeGanttOrder(d, d.Requests[index])
		unrankRequest(d, index, &detail)
		d.Requests = append(d.Requests[:index], d.Requests[index+1:]...)
		return nil
	})
	s.finish(w, r, rev, e)
}
func (s *Server) archiveRequest(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Base     *int64 `json:"baseRevision"`
		Archived bool   `json:"archived"`
	}
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	if e := revision(in.Base); e != nil {
		s.fail(w, e)
		return
	}
	id, e := pathID(r)
	if e != nil {
		s.fail(w, e)
		return
	}
	label := "归档需求"
	if !in.Archived {
		label = "恢复到需求池"
	}
	detail := history.Detail{Label: label}
	rev, e := s.Store.ChangeLogged(r.Context(), actor(r).ID, in.Base, "edit", &detail, true, func(_ *sql.Tx, d *requests.Data, _ auth.User) error {
		index := requestIndex(d, id)
		if index < 0 {
			return store.ErrNotFound
		}
		if d.Requests[index].Archived == in.Archived {
			return store.Bad("需求已经处于该归档状态")
		}
		detail.Subject = d.Requests[index].Name
		before, after := "需求池", "已归档"
		if !in.Archived {
			before, after = after, before
		}
		detail.Add("位置", history.Text(before), history.Text(after))
		d.Requests[index].Archived = in.Archived
		stamp := time.Now().UTC().Format(time.RFC3339Nano)
		if in.Archived {
			unrankRequest(d, index, &detail)
			d.Requests[index].ArchivedAt = stamp
		} else {
			d.Requests[index].PoolEnteredAt = stamp
		}
		d.Requests[index].Revision++
		return nil
	})
	s.finish(w, r, rev, e)
}
func (s *Server) batchRequests(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Base      *int64             `json:"baseRevision"`
		Requests  []requests.Request `json:"requests"`
		Operation string             `json:"operation"`
	}
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	if e := revision(in.Base); e != nil {
		s.fail(w, e)
		return
	}
	if len(in.Requests) < 1 || len(in.Requests) > 1000 {
		s.fail(w, store.Bad("批量排期需要1至1000条需求"))
		return
	}
	if e := validateRequestOperation(in.Operation); e != nil {
		s.fail(w, e)
		return
	}
	detail := history.Detail{Label: "应用顺排", SummaryOnly: true}
	if in.Operation == "ganttUndo" {
		detail.Label = "撤回甘特操作"
	}
	rev, e := s.Store.ChangeLogged(r.Context(), actor(r).ID, in.Base, "admin", &detail, true, func(tx *sql.Tx, d *requests.Data, _ auth.User) error {
		calendar, e := store.ReadCalendar(r.Context(), tx)
		if e != nil {
			return e
		}
		developers, e := store.Developers(r.Context(), tx)
		if e != nil {
			return e
		}
		lookup, e := readRequestLogLookup(r.Context(), tx, d)
		if e != nil {
			return e
		}
		changed := 0
		seen := map[int64]bool{}
		for _, item := range in.Requests {
			index := requestIndex(d, item.ID)
			if index < 0 {
				return store.ErrNotFound
			}
			old := d.Requests[index]
			if seen[item.ID] || item.Archived || old.Archived {
				return store.Bad("批量排期不能包含重复或归档需求")
			}
			seen[item.ID] = true
			if item.Revision != old.Revision {
				return store.ErrConflict
			}
			if e = requests.ValidateUpdate(&item, old, *d, developers, calendar); e != nil {
				return store.Bad(e.Error())
			}
			edit := lookup.describeRequestEdit(old, item, calendar, in.Operation)
			if len(edit.Changes) != 0 {
				changed++
				if edit.Label == "编辑需求" || edit.Label == "调整优先级" {
					detail.Label = "批量编辑需求"
				}
				for _, change := range edit.Changes {
					if change.Subject == "" {
						change.Subject = old.Name
					}
					detail.Changes = append(detail.Changes, change)
				}
			}
			item.Revision++
			item.RequesterRank = old.RequesterRank
			item.PoolEnteredAt, item.ArchivedAt = old.PoolEnteredAt, old.ArchivedAt
			if item.Developer != old.Developer {
				removeGanttOrder(d, old)
			}
			d.Requests[index] = item
		}
		detail.Tags = []history.Value{history.Text(fmt.Sprintf("%d 条需求", changed))}
		return nil
	})
	s.finish(w, r, rev, e)
}

type domainInput struct {
	Base  *int64 `json:"baseRevision"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

func (s *Server) createDomain(w http.ResponseWriter, r *http.Request) {
	var in domainInput
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	if e := revision(in.Base); e != nil {
		s.fail(w, e)
		return
	}
	detail := history.Detail{Label: "新增业务域", Subject: in.Name, Tags: []history.Value{{Text: in.Color, Kind: "color"}}}
	rev, e := s.Store.ChangeLogged(r.Context(), actor(r).ID, in.Base, "super", &detail, true, func(_ *sql.Tx, d *requests.Data, _ auth.User) error {
		if in.Name == "" || in.Name != strings.TrimSpace(in.Name) || len([]rune(in.Name)) > 80 || !requests.Color.MatchString(in.Color) {
			return store.Bad("业务域名称或颜色无效")
		}
		for _, x := range d.Domains {
			if x.Name == in.Name {
				return store.Bad("业务域已存在")
			}
		}
		d.Domains = append(d.Domains, requests.Domain{ID: auth.ID(), Name: in.Name, Color: in.Color})
		return nil
	})
	s.finish(w, r, rev, e)
}
func (s *Server) updateDomain(w http.ResponseWriter, r *http.Request) {
	var in domainInput
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	if e := revision(in.Base); e != nil {
		s.fail(w, e)
		return
	}
	detail := history.Detail{Label: "调整业务域颜色"}
	rev, e := s.Store.ChangeLogged(r.Context(), actor(r).ID, in.Base, "super", &detail, true, func(_ *sql.Tx, d *requests.Data, _ auth.User) error {
		for i, x := range d.Domains {
			if x.ID != r.PathValue("id") {
				continue
			}
			if !requests.Color.MatchString(in.Color) {
				return store.Bad("颜色无效")
			}
			if in.Name != "" && in.Name != x.Name {
				return store.Bad("业务域不支持改名或合并")
			}
			detail.Subject = x.Name
			detail.Add("颜色", logValue(x.Color, "color"), logValue(in.Color, "color"))
			d.Domains[i].Color = in.Color
			return nil
		}
		return store.ErrNotFound
	})
	s.finish(w, r, rev, e)
}
func (s *Server) deleteDomain(w http.ResponseWriter, r *http.Request) {
	var in revisionInput
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	if e := revision(in.Base); e != nil {
		s.fail(w, e)
		return
	}
	detail := history.Detail{Label: "删除业务域"}
	rev, e := s.Store.ChangeLogged(r.Context(), actor(r).ID, in.Base, "super", &detail, true, func(_ *sql.Tx, d *requests.Data, _ auth.User) error {
		for i, x := range d.Domains {
			if x.ID != r.PathValue("id") {
				continue
			}
			for _, row := range d.Requests {
				if row.Domain == x.Name {
					return store.Bad("业务域仍有需求引用（包括已归档），请先调整")
				}
			}
			detail.Subject = x.Name
			detail.Tags = []history.Value{logValue(x.Color, "color")}
			d.Domains = append(d.Domains[:i], d.Domains[i+1:]...)
			return nil
		}
		return store.ErrNotFound
	})
	s.finish(w, r, rev, e)
}
func (s *Server) mergeField(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Base   *int64   `json:"baseRevision"`
		Field  string   `json:"field"`
		Values []string `json:"values"`
		Target string   `json:"target"`
	}
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	if e := revision(in.Base); e != nil {
		s.fail(w, e)
		return
	}
	if (in.Field != "project" && in.Field != "requester") || in.Target == "" || in.Target != strings.TrimSpace(in.Target) || len([]rune(in.Target)) > 160 || len(in.Values) == 0 {
		s.fail(w, store.Bad("统一字段参数无效"))
		return
	}
	chosen := map[string]bool{}
	for _, v := range in.Values {
		chosen[v] = true
	}
	field := "项目"
	if in.Field == "requester" {
		field = "提需人"
	}
	detail := history.Detail{Label: "统一" + field, SummaryOnly: true}
	rev, e := s.Store.ChangeLogged(r.Context(), actor(r).ID, in.Base, "super", &detail, true, func(_ *sql.Tx, d *requests.Data, _ auth.User) error {
		for i := range d.Requests {
			item := &d.Requests[i]
			value := &item.Project
			if in.Field == "requester" {
				value = &item.Requester
			}
			if chosen[*value] && *value != in.Target {
				before, after := logValue(*value, ""), history.Text(in.Target)
				detail.Changes = append(detail.Changes, history.Change{Subject: item.Name, Field: field, Before: &before, After: &after})
				*value = in.Target
				item.Revision++
			}
		}
		if len(detail.Changes) == 0 {
			return store.Bad("没有需要统一的需求")
		}
		detail.Tags = []history.Value{history.Text(in.Target), history.Text(fmt.Sprintf("影响 %d 条需求", len(detail.Changes)))}
		return nil
	})
	s.finish(w, r, rev, e)
}

// Round-trip domain values without sharing transport types with business modules.
func jsonValue(v any) string { b, _ := json.Marshal(v); return string(b) }
