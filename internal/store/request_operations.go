package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"

	"rsm/internal/auth"
	"rsm/internal/history"
	"rsm/internal/requests"
)

// An empty value represents a missing JSON field, distinct from an explicit null.
type requestFields map[string]string

type requestChange struct {
	ID     int64         `json:"id"`
	Before requestFields `json:"before"`
	After  requestFields `json:"after"`
}

type orderChange struct {
	Before []int64 `json:"before"`
	After  []int64 `json:"after"`
}

type requestOperation struct {
	ActorID  string                 `json:"actorId"`
	Admin    bool                   `json:"admin,omitempty"`
	Calendar []byte                 `json:"calendar,omitempty"`
	Requests []requestChange        `json:"requests,omitempty"`
	Orders   map[string]orderChange `json:"orders,omitempty"`
	Used     bool                   `json:"used,omitempty"`
}

var scheduleFields = []string{"developer", "days", "start", "delivery", "segments", "vacation", "overtime", "supportSegments"}

func fieldsOf(row requests.Request) (requestFields, error) {
	raw, err := json.Marshal(row)
	if err != nil {
		return nil, err
	}
	var rawFields map[string]json.RawMessage
	if err = json.Unmarshal(raw, &rawFields); err != nil {
		return nil, err
	}
	delete(rawFields, "revision")
	fields := make(requestFields, len(rawFields))
	for key, value := range rawFields {
		fields[key] = string(value)
	}
	return fields, nil
}

func fieldsMatch(current, expected requestFields) bool {
	for key, value := range expected {
		if current[key] != value {
			return false
		}
	}
	return true
}

func captureRequestOperation(ctx context.Context, tx *sql.Tx, who auth.User, before, after requests.Data) (*requestOperation, error) {
	op := &requestOperation{ActorID: who.ID, Admin: who.Admin()}
	oldRows := make(map[int64]requests.Request, len(before.Requests))
	for _, row := range before.Requests {
		oldRows[row.ID] = row
	}
	scheduleChanged := false
	for _, row := range after.Requests {
		old, exists := oldRows[row.ID]
		delete(oldRows, row.ID)
		if exists && old.Revision == row.Revision {
			continue
		}
		next, err := fieldsOf(row)
		if err != nil {
			return nil, err
		}
		change := requestChange{ID: row.ID, After: next}
		if exists {
			previous, err := fieldsOf(old)
			if err != nil {
				return nil, err
			}
			change.Before, change.After = requestFields{}, requestFields{}
			for key, value := range previous {
				if value != next[key] {
					change.Before[key], change.After[key] = value, next[key]
				}
			}
			for key, value := range next {
				if _, ok := previous[key]; !ok {
					change.Before[key], change.After[key] = "", value
				}
			}
			if len(change.Before) == 0 {
				continue
			}
			change.Before["archived"], change.After["archived"] = previous["archived"], next["archived"]
			for _, key := range scheduleFields {
				if _, changed := change.Before[key]; changed {
					scheduleChanged = true
					for _, field := range scheduleFields {
						change.Before[field], change.After[field] = previous[field], next[field]
					}
					break
				}
			}
		}
		op.Requests = append(op.Requests, change)
	}
	for _, row := range oldRows {
		previous, err := fieldsOf(row)
		if err != nil {
			return nil, err
		}
		op.Requests = append(op.Requests, requestChange{ID: row.ID, Before: previous})
	}
	op.Orders = make(map[string]orderChange)
	for developer, order := range before.GanttRowOrder {
		if next := after.GanttRowOrder[developer]; !slices.Equal(order, next) {
			op.Orders[developer] = orderChange{Before: order, After: next}
		}
	}
	for developer, order := range after.GanttRowOrder {
		if len(before.GanttRowOrder[developer]) == 0 && len(order) > 0 {
			op.Orders[developer] = orderChange{After: order}
		}
	}
	if len(op.Requests) == 0 && len(op.Orders) == 0 {
		return nil, nil
	}
	if scheduleChanged {
		var err error
		op.Calendar, err = operationCalendar(ctx, tx)
		if err != nil {
			return nil, err
		}
	}
	return op, nil
}

func operationCalendar(ctx context.Context, tx *sql.Tx) ([]byte, error) {
	calendar, err := ReadCalendar(ctx, tx)
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal([2][]string{calendar.RestDays, calendar.WorkDays})
	if err != nil {
		return nil, err
	}
	signature := sha256.Sum256(raw)
	return signature[:], nil
}

func (s *Store) ReverseRequestOperation(ctx context.Context, actorID string, base *int64, id int64, redo bool) (revision, operationID int64, err error) {
	detail := history.Detail{Label: "撤回需求操作"}
	if redo {
		detail.Label = "重做需求操作"
	}
	return s.ChangeRequests(ctx, actorID, base, "edit", &detail, func(tx *sql.Tx, data *requests.Data, who auth.User) error {
		var raw string
		var undone bool
		err := tx.QueryRowContext(ctx, "select payload,undone from history_details join history on history_id=id where id=?", id).Scan(&raw, &undone)
		if errors.Is(err, sql.ErrNoRows) {
			return Bad("这条操作的撤回记录已过期")
		}
		if err != nil {
			return err
		}
		var entry storedHistoryDetail
		if err = json.Unmarshal([]byte(raw), &entry); err != nil {
			return err
		}
		op := entry.Operation
		if op == nil || op.ActorID != who.ID || (op.Admin && !who.Admin()) {
			return ErrForbidden
		}
		if undone || op.Used {
			return Bad("这条操作已被撤回或重做")
		}
		if len(op.Calendar) != 0 {
			current, err := operationCalendar(ctx, tx)
			if err != nil {
				return err
			}
			if !slices.Equal(current, op.Calendar) {
				return Bad("工作日历已更新，当前排期未改动")
			}
		}
		if err = op.reverse(ctx, tx, data, *base+1, redo); err != nil {
			return err
		}
		detail.Subject = entry.Subject
		detail.Tags = []history.Value{history.Text(entry.Label)}
		detail.Changes = make([]history.Change, len(entry.Changes))
		for i, change := range entry.Changes {
			change.Before, change.After = change.After, change.Before
			detail.Changes[i] = change
		}
		_, err = tx.ExecContext(ctx, "update history_details set payload=json_set(payload,'$.requestOperation.used',json('true')) where history_id=?", id)
		return err
	})
}

func (op *requestOperation) reverse(ctx context.Context, tx *sql.Tx, data *requests.Data, revision int64, redo bool) error {
	conflict := Bad("相关需求或顺序已被后续操作修改，保留最新数据")
	for developer, change := range op.Orders {
		if !slices.Equal(data.GanttRowOrder[developer], change.After) {
			return conflict
		}
	}
	indexes := make(map[int64]int, len(data.Requests))
	for i, row := range data.Requests {
		indexes[row.ID] = i
	}
	removed := make(map[int64]bool)
	domains := make(map[string]bool, len(data.Domains))
	for _, domain := range data.Domains {
		domains[domain.Name] = true
	}
	var developers map[string]bool
	addedSupportTargets := make(map[int64]bool)
	for _, change := range op.Requests {
		i, exists := indexes[change.ID]
		if exists != (change.After != nil) {
			return conflict
		}
		var fields requestFields
		var previous requests.Request
		if exists {
			previous = data.Requests[i]
			current, err := fieldsOf(previous)
			if err != nil {
				return err
			}
			if !fieldsMatch(current, change.After) || (change.Before == nil && !fieldsMatch(change.After, current)) {
				return conflict
			}
			fields = current
		} else {
			fields = make(requestFields)
		}
		if change.Before == nil {
			removed[change.ID] = true
			continue
		}
		for key, value := range change.Before {
			if value == "" {
				delete(fields, key)
			} else {
				fields[key] = value
			}
		}
		rawFields := make(map[string]json.RawMessage, len(fields))
		for key, value := range fields {
			rawFields[key] = json.RawMessage(value)
		}
		raw, err := json.Marshal(rawFields)
		if err != nil {
			return err
		}
		var row requests.Request
		if err = json.Unmarshal(raw, &row); err != nil {
			return err
		}
		if row.Domain != previous.Domain && row.Domain != "" && !domains[row.Domain] {
			return Bad("原业务域已不存在，无法恢复这条操作")
		}
		if row.Developer != previous.Developer && row.Developer != "" {
			if developers == nil {
				developers, err = Developers(ctx, tx)
				if err != nil {
					return err
				}
			}
			if !developers[row.Developer] {
				return Bad("原开发人已不可用，无法恢复这条操作")
			}
		}
		for _, segment := range row.SupportSegments {
			if !slices.ContainsFunc(previous.SupportSegments, func(old requests.SupportSegment) bool {
				return old.RequestID == segment.RequestID
			}) {
				addedSupportTargets[segment.RequestID] = true
			}
		}
		row.Revision = max(previous.Revision+1, revision)
		if exists {
			data.Requests[i] = row
		} else {
			data.Requests = append(data.Requests, row)
		}
	}
	data.Requests = slices.DeleteFunc(data.Requests, func(row requests.Request) bool { return removed[row.ID] })
	if len(op.Orders) > 0 && data.GanttRowOrder == nil {
		data.GanttRowOrder = make(map[string][]int64)
	}
	for developer, change := range op.Orders {
		if len(change.Before) == 0 {
			delete(data.GanttRowOrder, developer)
		} else {
			data.GanttRowOrder[developer] = change.Before
		}
	}
	people := make(map[int64]string, len(data.Requests))
	ranks := make(map[int]bool)
	largestRank := 0
	for _, row := range data.Requests {
		people[row.ID] = row.Developer
		if !row.Archived {
			delete(addedSupportTargets, row.ID)
		}
		if !redo && len(removed) > 0 && slices.ContainsFunc(row.SupportSegments, func(segment requests.SupportSegment) bool {
			return removed[segment.RequestID]
		}) {
			return Bad("这条需求已有补位引用，无法撤回创建")
		}
		if row.RequesterRank > 0 && !row.Archived {
			if ranks[row.RequesterRank] {
				return conflict
			}
			ranks[row.RequesterRank] = true
			largestRank = max(largestRank, row.RequesterRank)
		}
	}
	if len(addedSupportTargets) > 0 {
		return Bad("补位目标已归档或删除，无法恢复补位")
	}
	if largestRank != len(ranks) {
		return conflict
	}
	for developer, order := range data.GanttRowOrder {
		for _, id := range order {
			if person, exists := people[id]; !exists || person != developer {
				return conflict
			}
		}
	}
	return nil
}
