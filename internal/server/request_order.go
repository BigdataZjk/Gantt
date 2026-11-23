package server

import (
	"cmp"
	"database/sql"
	"fmt"
	"net/http"
	"slices"

	"rsm/internal/auth"
	"rsm/internal/history"
	"rsm/internal/requests"
	"rsm/internal/schedule"
	"rsm/internal/store"
)

type ganttOrderInput struct {
	Base            *int64 `json:"baseRevision"`
	DraggedID       int64  `json:"draggedRequestId"`
	SortByAdmission bool   `json:"sortByAdmission"`
	Orders          []struct {
		Developer string  `json:"developer"`
		IDs       []int64 `json:"requestIds"`
	} `json:"orders"`
	Move *struct {
		ID        int64  `json:"requestId"`
		Developer string `json:"developer"`
	} `json:"move"`
}

func (s *Server) orderGantt(w http.ResponseWriter, r *http.Request) {
	var in ganttOrderInput
	if err := decode(w, r, &in); err != nil {
		s.fail(w, err)
		return
	}
	if err := revision(in.Base); err != nil {
		s.fail(w, err)
		return
	}
	if len(in.Orders) == 0 {
		s.fail(w, store.Bad("请选择要调整的开发人分组"))
		return
	}
	detail := history.Detail{Label: "调整甘特图顺序"}
	if in.SortByAdmission {
		detail.Label = "按准入日期排序"
	}
	rev, err := s.Store.ChangeLogged(r.Context(), actor(r).ID, in.Base, "edit", &detail, true, func(tx *sql.Tx, data *requests.Data, user auth.User) error {
		if in.SortByAdmission && !user.Admin() {
			return store.ErrForbidden
		}
		lookup, err := readRequestLogLookup(r.Context(), tx, data)
		if err != nil {
			return err
		}
		var moved requests.Request
		prior := make(map[string][]int64, len(in.Orders)+1)
		for _, order := range in.Orders {
			prior[order.Developer] = ganttOrderForLog(data, order.Developer)
		}
		if move := in.Move; move != nil {
			if !user.Admin() {
				return store.ErrForbidden
			}
			index := requestIndex(data, move.ID)
			if index < 0 || data.Requests[index].Archived {
				return store.ErrNotFound
			}
			row := &data.Requests[index]
			moved = *row
			if _, ok := prior[moved.Developer]; !ok {
				prior[moved.Developer] = ganttOrderForLog(data, moved.Developer)
			}
			if move.Developer == "" && len(row.SupportSegments) != 0 {
				return store.Bad("此需求有补位安排，需保留开发人")
			}
			if move.Developer != "" {
				developers, err := store.Developers(r.Context(), tx)
				if err != nil {
					return err
				}
				if !developers[move.Developer] {
					return store.Bad("请选择可用的开发人")
				}
			}
			if move.Developer != row.Developer {
				removeGanttOrder(data, *row)
				row.Developer = move.Developer
				row.Revision++
			}
		}
		people := make(map[int64]string, len(data.Requests))
		counts := make(map[string]int)
		for _, row := range data.Requests {
			people[row.ID] = row.Developer
			counts[row.Developer]++
		}
		groups := make(map[string]bool, len(in.Orders))
		seen := make(map[int64]bool)
		if data.GanttRowOrder == nil {
			data.GanttRowOrder = make(map[string][]int64)
		}
		for _, order := range in.Orders {
			if groups[order.Developer] || len(order.IDs) == 0 || len(order.IDs) != counts[order.Developer] {
				return store.Bad("甘特图顺序必须包含对应分组的全部需求")
			}
			groups[order.Developer] = true
			for _, id := range order.IDs {
				developer, exists := people[id]
				if !exists || developer != order.Developer || seen[id] {
					return store.Bad("甘特图顺序含无效或重复需求")
				}
				seen[id] = true
			}
			data.GanttRowOrder[order.Developer] = order.IDs
		}
		if in.Move != nil && !groups[in.Move.Developer] {
			return store.Bad("缺少目标开发人分组顺序")
		}
		if in.Move != nil && moved.Developer != in.Move.Developer {
			detail.Label, detail.Subject = "调整开发人", moved.Name
			detail.Add("开发人", history.Text(lookup.developer(moved.Developer)), history.Text(lookup.developer(in.Move.Developer)))
			appendGanttPosition(&detail, "", moved.ID, prior[moved.Developer], ganttOrderForLog(data, in.Move.Developer), lookup)
			return nil
		}
		for _, order := range in.Orders {
			before, after := prior[order.Developer], ganttOrderForLog(data, order.Developer)
			if slices.Equal(before, after) {
				continue
			}
			if len(in.Orders) == 1 && in.DraggedID > 0 &&
				slices.Contains(after, in.DraggedID) && sameGanttOrderExcept(before, after, in.DraggedID) {
				detail.Subject = lookup.requestName(in.DraggedID)
				detail.Tags = []history.Value{history.Text(lookup.developer(order.Developer))}
				appendGanttPosition(&detail, "", in.DraggedID, before, after, lookup)
				return nil
			}
			for _, id := range after {
				appendGanttPosition(&detail, lookup.requestName(id), id, before, after, lookup)
			}
			detail.Tags = append(detail.Tags, history.Text(lookup.developer(order.Developer)))
		}
		detail.SummaryOnly = len(detail.Changes) > 1
		detail.Tags = append(detail.Tags, history.Text(fmt.Sprintf("%d 条需求", len(detail.Changes))))
		return nil
	})
	s.finish(w, r, rev, err)
}

func ganttOrderForLog(data *requests.Data, developer string) []int64 {
	ranks := make(map[int64]int, len(data.GanttRowOrder[developer]))
	for index, id := range data.GanttRowOrder[developer] {
		ranks[id] = index + 1
	}
	type entry struct {
		id    int64
		start string
		rank  int
	}
	rows := make([]entry, 0)
	for _, row := range data.Requests {
		if row.Developer != developer {
			continue
		}
		start := row.Start
		if len(row.Segments) > 0 {
			start = row.Segments[0].Start
		}
		if !schedule.ValidDate(start) {
			start = ""
		}
		rows = append(rows, entry{id: row.ID, start: start, rank: ranks[row.ID]})
	}
	scheduledFirst := func(a, b entry) int {
		switch {
		case a.start != "" && b.start == "":
			return -1
		case a.start == "" && b.start != "":
			return 1
		}
		return 0
	}
	slices.SortFunc(rows, func(a, b entry) int {
		return cmp.Or(scheduledFirst(a, b), cmp.Compare(a.start, b.start), cmp.Compare(a.id, b.id))
	})
	ranked := make([]entry, 0, len(ranks))
	for _, row := range rows {
		if row.rank > 0 {
			ranked = append(ranked, row)
		}
	}
	slices.SortFunc(ranked, func(a, b entry) int {
		return cmp.Or(scheduledFirst(a, b), cmp.Compare(a.rank, b.rank))
	})
	ids := make([]int64, 0, len(rows))
	next := 0
	for _, row := range rows {
		if row.rank > 0 {
			row = ranked[next]
			next++
		}
		ids = append(ids, row.id)
	}
	return ids
}

func sameGanttOrderExcept(before, after []int64, id int64) bool {
	without := func(ids []int64) []int64 {
		return slices.DeleteFunc(slices.Clone(ids), func(candidate int64) bool { return candidate == id })
	}
	return slices.Equal(without(before), without(after))
}

func appendGanttPosition(detail *history.Detail, subject string, id int64, before, after []int64, lookup requestLogLookup) {
	previous, current := slices.Index(before, id), slices.Index(after, id)
	if previous < 0 || current < 0 || (previous == current && (subject != "" || len(detail.Changes) == 0)) {
		return
	}
	old, next := history.Text(fmt.Sprintf("第 %d 行", previous+1)), history.Text(fmt.Sprintf("第 %d 行", current+1))
	var tags []history.Value
	if subject == "" {
		position := "分组末尾"
		if current+1 < len(after) {
			position = "在 " + lookup.requestName(after[current+1]) + " 前"
		}
		tags = []history.Value{history.Text(position)}
	}
	detail.Changes = append(detail.Changes, history.Change{Subject: subject, Field: "行位置", Before: &old, After: &next, Tags: tags})
}

func removeGanttOrder(data *requests.Data, row requests.Request) {
	order := slices.DeleteFunc(data.GanttRowOrder[row.Developer], func(id int64) bool { return id == row.ID })
	if len(order) == 0 {
		delete(data.GanttRowOrder, row.Developer)
	} else {
		data.GanttRowOrder[row.Developer] = order
	}
}

func (s *Server) rankRequests(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Base   *int64 `json:"baseRevision"`
		Action string `json:"action"`
		ID     *int64 `json:"requestId"`
	}
	if err := decode(w, r, &in); err != nil {
		s.fail(w, err)
		return
	}
	if err := revision(in.Base); err != nil {
		s.fail(w, err)
		return
	}
	detail := history.Detail{Label: "标记需求方优先级"}
	switch in.Action {
	case "toggle":
		if in.ID == nil || *in.ID < 1 {
			s.fail(w, store.Bad("请选择一条需求"))
			return
		}
	case "clear":
		if in.ID != nil {
			s.fail(w, store.Bad("清除优先级适用于整个需求池"))
			return
		}
		detail.Label, detail.SummaryOnly = "清除需求方优先级", true
	default:
		s.fail(w, store.Bad("优先级操作无效"))
		return
	}
	rev, err := s.Store.ChangeLogged(r.Context(), actor(r).ID, in.Base, "edit", &detail, true, func(_ *sql.Tx, data *requests.Data, _ auth.User) error {
		if in.Action == "clear" {
			for i := range data.Requests {
				row := &data.Requests[i]
				if !row.Archived && row.RequesterRank > 0 {
					logRankChange(&detail, row.Name, row.RequesterRank, 0)
					row.RequesterRank = 0
					row.Revision++
				}
			}
			detail.Tags = []history.Value{history.Text(fmt.Sprintf("影响 %d 条需求", len(detail.Changes)))}
			return nil
		}
		index := requestIndex(data, *in.ID)
		if index < 0 || data.Requests[index].Archived {
			return store.ErrNotFound
		}
		row := &data.Requests[index]
		detail.Subject = row.Name
		if row.RequesterRank > 0 {
			detail.Label = "取消需求方优先级"
			unrankRequest(data, index, &detail)
		} else {
			last := 0
			for _, candidate := range data.Requests {
				if !candidate.Archived {
					last = max(last, candidate.RequesterRank)
				}
			}
			row.RequesterRank = last + 1
			logRankChange(&detail, "", 0, row.RequesterRank)
		}
		row.Revision++
		return nil
	})
	s.finish(w, r, rev, err)
}

func logRankChange(detail *history.Detail, subject string, before, after int) {
	rank := func(value int) history.Value {
		if value == 0 {
			return history.Text("未标记")
		}
		return history.Value{Text: fmt.Sprintf("第 %d 位", value), Kind: "rank"}
	}
	old, next := rank(before), rank(after)
	detail.Changes = append(detail.Changes, history.Change{Subject: subject, Field: "需求方优先级", Before: &old, After: &next})
}

func unrankRequest(data *requests.Data, index int, detail *history.Detail) {
	rank := data.Requests[index].RequesterRank
	if rank == 0 {
		return
	}
	logRankChange(detail, "", rank, 0)
	data.Requests[index].RequesterRank = 0
	shifted := 0
	for i := range data.Requests {
		row := &data.Requests[i]
		if !row.Archived && row.RequesterRank > rank {
			logRankChange(detail, row.Name, row.RequesterRank, row.RequesterRank-1)
			row.RequesterRank--
			row.Revision++
			shifted++
		}
	}
	if shifted > 0 {
		detail.Tags = []history.Value{history.Text(fmt.Sprintf("后续 %d 条自动前移", shifted))}
	}
}
