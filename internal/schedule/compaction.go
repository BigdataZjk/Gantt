package schedule

import "slices"

// EarlierDates moves a set of schedule dates by the same number of workdays.
// Rest-day markers keep their ordering in the gap before the corresponding workday.
// If a gap cannot fit its markers, try a smaller shift. Floors are exclusive.
func EarlierDates(c Calendar, dates []string, floor string, floors map[string]string, maxShift int) map[string]string {
	if len(dates) == 0 || maxShift <= 0 {
		return nil
	}
	dates = slices.Clone(dates)
	slices.Sort(dates)
	dates = slices.Compact(dates)
	idx := newCalendarIndex(c)
	if !isInRange(dates[0]) || !isInRange(dates[len(dates)-1]) || dates[0] <= floor {
		return nil
	}
	start := max(minSupportedDate, idx.prevWorkday(floor))
	last := idx.nextWorkday(dates[len(dates)-1])
	if last == "" {
		return nil
	}
	workdays := make([]string, 0)
	for day := start; day <= last; day = AddDays(day, 1) {
		if idx.isWorkday(day) {
			workdays = append(workdays, day)
		}
	}

	type dateGroup struct {
		workday int
		dates   []string
	}
	var groups []dateGroup
	position := 0
	for _, day := range dates {
		for workdays[position] < day {
			position++
		}
		if len(groups) == 0 || groups[len(groups)-1].workday != position {
			groups = append(groups, dateGroup{workday: position})
		}
		group := &groups[len(groups)-1]
		group.dates = append(group.dates, day)
	}

	for shift := min(maxShift, groups[0].workday); shift > 0; shift-- {
		mapped := make(map[string]string, len(dates))
		for _, group := range groups {
			sourceWorkday := workdays[group.workday]
			targetIndex := group.workday - shift
			targetWorkday := workdays[targetIndex]
			rest := group.dates
			if rest[len(rest)-1] == sourceWorkday {
				mapped[sourceWorkday] = targetWorkday
				rest = rest[:len(rest)-1]
			}
			if len(rest) == 0 {
				continue
			}
			available := daySpan(minSupportedDate, targetWorkday)
			if targetIndex > 0 {
				available = daySpan(workdays[targetIndex-1], targetWorkday) - 1
			}
			if len(rest) > available {
				break
			}
			offset := -available - 1
			for i, day := range rest {
				offset = max(offset+1, daySpan(sourceWorkday, day))
				offset = min(offset, i-len(rest))
				mapped[day] = AddDays(targetWorkday, offset)
			}
		}
		if len(mapped) != len(dates) || mapped[dates[0]] <= floor {
			continue
		}
		clearsFloors := true
		for day, floor := range floors {
			if mapped[day] <= floor {
				clearsFloors = false
				break
			}
		}
		if clearsFloors {
			return mapped
		}
	}
	return nil
}
