package requests

import (
	"slices"
	"strings"

	"rsm/internal/schedule"
)

type scheduledRequest struct {
	index      int
	plan       schedule.Plan
	allocation schedule.Plan
	start, end string
	fixed      bool
}

func scheduledRow(index int, row Request, calendar schedule.Calendar) scheduledRequest {
	plan := schedule.Plan{
		Start: row.Start, Delivery: row.Delivery, Days: row.Days,
		Segments: row.Segments, Vacation: row.Vacation, Overtime: row.Overtime,
	}
	if len(plan.Segments) != 0 {
		plan.Start = plan.Segments[0].Start
	}
	plan.Delivery = schedule.DeliveryOf(plan, calendar)
	allocation := plan
	allocation.Segments = schedule.EffectiveSegments(plan)
	for _, support := range row.SupportSegments {
		allocation.Segments = append(allocation.Segments, schedule.Segment{Start: support.Start, End: support.End})
	}
	out := scheduledRequest{index: index, plan: plan, allocation: allocation, fixed: row.Archived || row.Status == "已完成"}
	for _, segment := range allocation.Segments {
		if out.start == "" || segment.Start < out.start {
			out.start = segment.Start
		}
		out.end = max(out.end, segment.End)
	}
	return out
}

// CompactAfterDelete returns schedule updates for the same developer. Parallel
// rows move on one date map, and historical or overlapping allocations bound
// the movable portion of the timeline.
func CompactAfterDelete(rows []Request, deletedIndex int, calendar schedule.Calendar) map[int]Request {
	deleted := rows[deletedIndex]
	if deleted.Developer == "" {
		return nil
	}
	removed := scheduledRow(deletedIndex, deleted, calendar)
	if removed.start == "" {
		return nil
	}
	var timeline []scheduledRequest
	for index, row := range rows {
		if index != deletedIndex && row.Developer == deleted.Developer {
			if entry := scheduledRow(index, row, calendar); entry.start != "" {
				timeline = append(timeline, entry)
			}
		}
	}
	slices.SortFunc(timeline, func(a, b scheduledRequest) int { return strings.Compare(a.start, b.start) })

	floor := schedule.AddDays(removed.start, -1)
	var following []scheduledRequest
	for start := 0; start < len(timeline); {
		block := timeline[start]
		end, fixed := block.end, block.fixed
		next := start + 1
		for next < len(timeline) && timeline[next].start <= end {
			end = max(end, timeline[next].end)
			fixed = fixed || timeline[next].fixed
			next++
		}
		if block.start <= removed.end {
			floor = max(floor, end)
		} else if fixed {
			break
		} else {
			following = append(following, timeline[start:next]...)
		}
		start = next
	}
	if len(following) == 0 || floor >= removed.end {
		return nil
	}
	freed := 0
	for day := range schedule.ActiveDays(removed.allocation, calendar) {
		if day > floor {
			freed++
		}
	}
	if freed == 0 {
		return nil
	}

	var dates []string
	floors := make(map[string]string)
	for _, entry := range following {
		for _, segment := range entry.allocation.Segments {
			dates = append(dates, segment.Start, segment.End)
		}
		for _, marks := range [][]string{entry.plan.Vacation, entry.plan.Overtime} {
			for _, day := range marks {
				if day < entry.start {
					floors[entry.start] = max(floors[entry.start], day)
				} else if day <= entry.end {
					dates = append(dates, day)
				}
			}
		}
	}
	mapped := schedule.EarlierDates(calendar, dates, floor, floors, freed)
	if mapped == nil {
		return nil
	}

	updates := make(map[int]Request, len(following))
	for _, entry := range following {
		row := rows[entry.index]
		if entry.plan.Start != "" && entry.plan.Delivery != "" {
			row.Start, row.Delivery = mapped[entry.plan.Start], mapped[entry.plan.Delivery]
		}
		row.Segments = slices.Clone(row.Segments)
		for i, segment := range row.Segments {
			row.Segments[i].Start, row.Segments[i].End = mapped[segment.Start], mapped[segment.End]
		}
		row.SupportSegments = slices.Clone(row.SupportSegments)
		for i, segment := range row.SupportSegments {
			row.SupportSegments[i].Start, row.SupportSegments[i].End = mapped[segment.Start], mapped[segment.End]
		}
		row.Vacation = moveIncludedMarks(row.Vacation, entry, mapped)
		row.Overtime = moveIncludedMarks(row.Overtime, entry, mapped)
		updates[entry.index] = row
	}
	return updates
}

func moveIncludedMarks(marks []string, entry scheduledRequest, dates map[string]string) []string {
	out := slices.Clone(marks)
	for i, day := range out {
		if day >= entry.start && day <= entry.end {
			out[i] = dates[day]
		}
	}
	return out
}
