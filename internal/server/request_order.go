package server

import (
	"database/sql"
	"net/http"
	"slices"

	"rsm/internal/auth"
	"rsm/internal/requests"
	"rsm/internal/store"
)

type ganttOrderInput struct {
	Base   *int64 `json:"baseRevision"`
	Orders []struct {
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
	action := "调整甘特图需求顺序"
	if in.Move != nil {
		action = "调整甘特图开发人和需求顺序"
	}
	rev, err := s.Store.Change(r.Context(), actor(r).ID, in.Base, "edit", action, true, func(tx *sql.Tx, data *requests.Data, user auth.User) error {
		if move := in.Move; move != nil {
			if !user.Admin() {
				return store.ErrForbidden
			}
			index := requestIndex(data, move.ID)
			if index < 0 || data.Requests[index].Archived {
				return store.ErrNotFound
			}
			row := &data.Requests[index]
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
		return nil
	})
	s.finish(w, r, rev, err)
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
	label := "调整需求方优先级"
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
		label = "清除需求方优先级"
	default:
		s.fail(w, store.Bad("优先级操作无效"))
		return
	}
	rev, err := s.Store.Change(r.Context(), actor(r).ID, in.Base, "edit", label, true, func(_ *sql.Tx, data *requests.Data, _ auth.User) error {
		if in.Action == "clear" {
			for i := range data.Requests {
				row := &data.Requests[i]
				if !row.Archived && row.RequesterRank > 0 {
					row.RequesterRank = 0
					row.Revision++
				}
			}
			return nil
		}
		index := requestIndex(data, *in.ID)
		if index < 0 || data.Requests[index].Archived {
			return store.ErrNotFound
		}
		row := &data.Requests[index]
		if row.RequesterRank > 0 {
			unrankRequest(data, index)
		} else {
			last := 0
			for _, candidate := range data.Requests {
				if !candidate.Archived {
					last = max(last, candidate.RequesterRank)
				}
			}
			row.RequesterRank = last + 1
		}
		row.Revision++
		return nil
	})
	s.finish(w, r, rev, err)
}

func unrankRequest(data *requests.Data, index int) {
	rank := data.Requests[index].RequesterRank
	if rank == 0 {
		return
	}
	data.Requests[index].RequesterRank = 0
	for i := range data.Requests {
		row := &data.Requests[i]
		if !row.Archived && row.RequesterRank > rank {
			row.RequesterRank--
			row.Revision++
		}
	}
}
