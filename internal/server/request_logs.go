package server

import (
	"context"
	"database/sql"
	"fmt"
	"slices"
	"strconv"

	"rsm/internal/history"
	"rsm/internal/requests"
	"rsm/internal/schedule"
	"rsm/internal/store"
)

type requestLogLookup struct {
	people map[string]string
	names  map[int64]string
	colors map[string]string
}

func readRequestLogLookup(ctx context.Context, tx *sql.Tx, data *requests.Data) (requestLogLookup, error) {
	users, err := store.Users(ctx, tx)
	lookup := requestLogLookup{
		people: make(map[string]string, len(users)),
		names:  make(map[int64]string, len(data.Requests)),
		colors: make(map[string]string, len(data.Domains)),
	}
	for _, user := range users {
		lookup.people[user.ID] = user.Username
	}
	for _, request := range data.Requests {
		lookup.names[request.ID] = request.Name
	}
	for _, domain := range data.Domains {
		lookup.colors[domain.Name] = domain.Color
	}
	return lookup, err
}

func (l requestLogLookup) developer(id string) string {
	if id == "" {
		return "未分配"
	}
	if name := l.people[id]; name != "" {
		return name
	}
	return "已删除账号"
}

func (l requestLogLookup) requestName(id int64) string {
	if name := l.names[id]; name != "" {
		return name
	}
	return fmt.Sprintf("需求 #%d（已删除）", id)
}

func logValue(text, kind string) history.Value {
	if text == "" {
		return history.Text("未填写")
	}
	return history.Value{Text: text, Kind: kind}
}

func (l requestLogLookup) domain(name string) history.Value {
	value := logValue(name, "domain")
	value.Color = l.colors[name]
	return value
}

func logField(detail *history.Detail, field, before, after string, compact string) {
	if before != after {
		old, next := logValue(before, ""), logValue(after, "")
		detail.Changes = append(detail.Changes, history.Change{Field: field, Before: &old, After: &next, Compact: compact})
	}
}

type logRange struct{ start, end string }

func (r logRange) text() string {
	if r.start == r.end {
		return r.start
	}
	return r.start + " ～ " + r.end
}

func rangeDifference(before, after []logRange) []logRange {
	missing := make([]logRange, 0)
	for _, span := range before {
		if !slices.Contains(after, span) {
			missing = append(missing, span)
		}
	}
	return missing
}

func appendRangeDiff(detail *history.Detail, field, subject, absent string, tags []history.Value, removed, added []logRange) {
	add := func(before, after string) {
		old, next := history.Text(before), history.Text(after)
		detail.Changes = append(detail.Changes, history.Change{Subject: subject, Field: field, Tags: tags, Before: &old, After: &next})
	}
	if len(removed) == 1 && len(added) == 1 {
		add(removed[0].text(), added[0].text())
		return
	}
	for _, span := range removed {
		add(span.text(), absent)
	}
	for _, span := range added {
		add(absent, span.text())
	}
}

func plannedRanges(r requests.Request) []logRange {
	segments := schedule.EffectiveSegments(schedule.Plan{Segments: r.Segments, Start: r.Start, Delivery: r.Delivery})
	ranges := make([]logRange, 0, len(segments))
	for _, segment := range segments {
		ranges = append(ranges, logRange{segment.Start, segment.End})
	}
	return ranges
}

func holdRanges(r requests.Request) []logRange {
	ranges := make([]logRange, 0)
	for i, segment := range r.Segments {
		if i == 0 || !segment.HoldBefore {
			continue
		}
		start := schedule.AddDays(r.Segments[i-1].End, 1)
		end := schedule.AddDays(segment.Start, -1)
		if start != "" && end != "" && start <= end {
			ranges = append(ranges, logRange{start, end})
		}
	}
	return ranges
}

func appendHoldDiff(detail *history.Detail, old, next requests.Request) {
	before, after := holdRanges(old), holdRanges(next)
	hold, gap := logValue("HOLD", "status"), history.Text("普通间隔")
	for _, span := range rangeDifference(before, after) {
		detail.Changes = append(detail.Changes, history.Change{Field: "暂停间隔", Tags: []history.Value{history.Text(span.text())}, Before: &hold, After: &gap})
	}
	for _, span := range rangeDifference(after, before) {
		detail.Changes = append(detail.Changes, history.Change{Field: "暂停间隔", Tags: []history.Value{history.Text(span.text())}, Before: &gap, After: &hold})
	}
}

func (l requestLogLookup) appendDayMarkDiff(detail *history.Detail, old, next requests.Request, calendar schedule.Calendar) {
	if slices.Equal(old.Vacation, next.Vacation) && slices.Equal(old.Overtime, next.Overtime) {
		return
	}
	days := slices.Concat(old.Vacation, old.Overtime, next.Vacation, next.Overtime)
	slices.Sort(days)
	for _, day := range slices.Compact(days) {
		before, after := dayMark(old, day, calendar), dayMark(next, day, calendar)
		if before != after {
			detail.Changes = append(detail.Changes, history.Change{
				Field:  "当天安排",
				Tags:   []history.Value{history.Text(l.developer(next.Developer)), history.Text(day)},
				Before: &before, After: &after,
			})
		}
	}
}

func dayMark(r requests.Request, day string, calendar schedule.Calendar) history.Value {
	switch {
	case slices.Contains(r.Vacation, day):
		return history.Text("休假")
	case slices.Contains(r.Overtime, day):
		return history.Text("加班日")
	case schedule.IsWorkday(day, calendar):
		return history.Text("工作日")
	default:
		return history.Text("休息日")
	}
}

func supportRanges(segments []requests.SupportSegment, id int64) []logRange {
	ranges := make([]logRange, 0)
	for _, segment := range segments {
		if segment.RequestID == id {
			ranges = append(ranges, logRange{segment.Start, segment.End})
		}
	}
	return ranges
}

func (l requestLogLookup) appendSupportDiff(detail *history.Detail, old, next requests.Request) {
	if slices.Equal(old.SupportSegments, next.SupportSegments) {
		return
	}
	targets := make([]int64, 0, len(old.SupportSegments)+len(next.SupportSegments))
	for _, segment := range slices.Concat(old.SupportSegments, next.SupportSegments) {
		targets = append(targets, segment.RequestID)
	}
	slices.Sort(targets)
	for _, target := range slices.Compact(targets) {
		before, after := supportRanges(old.SupportSegments, target), supportRanges(next.SupportSegments, target)
		appendRangeDiff(detail, "补位日期", l.requestName(target), "未补位", []history.Value{history.Text(l.developer(next.Developer))},
			rangeDifference(before, after), rangeDifference(after, before))
	}
}

func (l requestLogLookup) describeRequestEdit(old, next requests.Request, calendar schedule.Calendar, operation string) history.Detail {
	detail := history.Detail{Label: "编辑需求", Subject: old.Name}
	detail.Add("状态", logValue(old.Status, "status"), logValue(next.Status, "status"))
	detail.Add("开发人", history.Text(l.developer(old.Developer)), history.Text(l.developer(next.Developer)))
	detail.Add("优先级", logValue(old.Priority, "priority"), logValue(next.Priority, "priority"))
	logField(&detail, "需求名称", old.Name, next.Name, "")
	logField(&detail, "提需人", old.Requester, next.Requester, "")
	logField(&detail, "提需日期", old.RequestedAt, next.RequestedAt, "")
	detail.Add("业务域", l.domain(old.Domain), l.domain(next.Domain))
	detail.Add("需求类型", logValue(old.RequestType, "requestType"), logValue(next.RequestType, "requestType"))
	logField(&detail, "项目", old.Project, next.Project, "")
	logField(&detail, "评审时间", old.Review, next.Review, "")
	logField(&detail, "预期交付", old.Expected, next.Expected, "")
	logField(&detail, "PRD 链接", old.PRD, next.PRD, "已更新")
	logField(&detail, "BRD 链接", old.BRD, next.BRD, "已更新")
	logField(&detail, "望岳链接", old.Wangyue, next.Wangyue, "已更新")
	logField(&detail, "备注", old.Notes, next.Notes, "已更新")
	fieldCount := len(detail.Changes)

	before, after := plannedRanges(old), plannedRanges(next)
	removed, added := rangeDifference(before, after), rangeDifference(after, before)
	appendRangeDiff(&detail, "排期段", "", "无排期段", nil, removed, added)
	if len(removed)+len(added) == 0 {
		logField(&detail, "准入日期", old.Start, next.Start, "")
		logField(&detail, "交付日期", old.Delivery, next.Delivery, "")
	}
	l.appendSupportDiff(&detail, old, next)
	l.appendDayMarkDiff(&detail, old, next, calendar)
	appendHoldDiff(&detail, old, next)
	detail.Add("开发人天", logPersonDays(old.Days), logPersonDays(next.Days))

	switch {
	case len(detail.Changes) == 0:
		detail.Tags = []history.Value{history.Text("内容未变")}
	case fieldCount == 0:
		detail.Label = scheduleLogLabel(detail.Changes, old, next, removed, added, operation)
	case len(detail.Changes) == 1 && detail.Changes[0].Field == "优先级":
		detail.Label = "调整优先级"
	}
	return detail
}

func logPersonDays(days float64) history.Value {
	return history.Text(strconv.FormatFloat(days, 'f', -1, 64) + " 人天")
}

func scheduleLogLabel(changes []history.Change, old, next requests.Request, removed, added []logRange, operation string) string {
	switch operation {
	case "sequence":
		return "应用顺排"
	case "ganttUndo":
		return "撤回甘特操作"
	}
	switch changes[0].Field {
	case "排期段":
		switch {
		case len(removed) == 0:
			return "新增排期"
		case len(added) == 0:
			return "删除排期段"
		case len(removed) == 1 && len(added) == 1:
			before, after := removed[0], added[0]
			if before.start == after.start || before.end == after.end {
				if after.start < before.start || after.end > before.end {
					return "延长排期"
				}
				return "缩短排期"
			}
			if old.Days == next.Days {
				return "移动排期"
			}
		}
	case "补位日期":
		if len(next.SupportSegments) > len(old.SupportSegments) {
			return "新增补位"
		}
		if len(next.SupportSegments) < len(old.SupportSegments) {
			return "取消补位"
		}
		return "调整补位"
	case "当天安排":
		if len(changes) == 1 {
			switch {
			case changes[0].After.Text == "休假":
				return "标记休假"
			case changes[0].After.Text == "加班日":
				return "标记加班"
			case changes[0].Before.Text == "休假":
				return "取消休假"
			case changes[0].Before.Text == "加班日":
				return "取消加班"
			}
		}
		return "调整休假或加班"
	case "暂停间隔":
		if len(changes) == 1 {
			if changes[0].After.Text == "HOLD" {
				return "标记 HOLD"
			}
			return "取消 HOLD"
		}
		return "调整 HOLD"
	}
	return "调整排期"
}
