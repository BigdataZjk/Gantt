package schedule

// 排期段操作：移动/伸缩/删除/补排期、人天与交付联动、休假加班标记。
// 人天联动按“有效开发日”计算（工作日且未休假，或已标记加班的休息日），
// 与原型 phaseDays 一致；仅标记休假/加班本身不改变日期和人天。

func toSet(values []string) map[string]bool {
	out := make(map[string]bool, len(values))
	for _, value := range values {
		out[value] = true
	}
	return out
}

func effectiveTotal(segs []Segment, vacation, overtime map[string]bool, idx *calendarIndex) int {
	total := 0
	for _, seg := range segs {
		total += idx.effectiveCount(seg.Start, seg.End, vacation, overtime)
	}
	return total
}

// gapWorkdays 返回第 index 段之前间隔内的工作日数量。
func gapWorkdays(segs []Segment, index int, idx *calendarIndex) int {
	if index <= 0 || index >= len(segs) {
		return 0
	}
	start := AddDays(segs[index-1].End, 1)
	end := AddDays(segs[index].Start, -1)
	if start == "" || end == "" || start > end {
		return 0
	}
	return idx.workdays(start, end)
}

// MoveSegment 把第 index 段移动到新的开始日期，保持该段有效开发日天数不变；
// 该段内的休假/加班标记随段平移（加班落在工作日时丢弃）。段前 HOLD 标记跟随该段。
// 新位置与同一需求其它段重叠时返回 segment_overlap。
func MoveSegment(p Plan, c Calendar, index int, newStart string) (Plan, error) {
	if index < 0 || index >= len(p.Segments) {
		return Plan{}, errIndexOutOfRange()
	}
	if _, err := ParseDate(newStart); err != nil {
		return Plan{}, err
	}
	idx := newCalendarIndex(c)
	segs := clonePlan(p).Segments
	seg := segs[index]
	vacationSet, overtimeSet := markSets(p)
	duration := idx.effectiveCount(seg.Start, seg.End, vacationSet, overtimeSet)
	if duration < 1 {
		// 原型 drag.duration = phaseDays(segment) || 3
		duration = PlaceholderDays
	}
	delta := daySpan(seg.Start, newStart)
	vacation := shiftMarks(p.Vacation, seg.Start, seg.End, delta, idx, false)
	overtime := shiftMarks(p.Overtime, seg.Start, seg.End, delta, idx, true)
	if !idx.isWorkday(newStart) && !containsDate(vacation, newStart) {
		overtime = append(overtime, newStart)
	}
	newEnd := idx.finishEffective(newStart, duration, toSet(vacation), toSet(overtime))
	if newEnd == "" {
		return Plan{}, errRangeExceeded()
	}
	for i, other := range segs {
		if i == index {
			continue
		}
		if newStart <= other.End && newEnd >= other.Start {
			return Plan{}, errSegmentOverlap()
		}
	}
	segs[index] = Segment{Start: newStart, End: newEnd, HoldBefore: seg.HoldBefore}
	sortSegments(segs)
	segs[0].HoldBefore = false
	days := 0.0
	if p.Days > 0 {
		days = float64(effectiveTotal(segs, toSet(vacation), toSet(overtime), idx))
	}
	return Normalize(Plan{
		Segments: segs,
		Days:     days,
		Vacation: vacation,
		Overtime: overtime,
	}, c)
}

// ResizeSegment 伸缩第 index 段：edge 为 "start" 或 "end"，date 为目标边界日期。
// 边界会避让相邻段；若相邻间隔已被标记为真 HOLD，则不能把边界伸入该间隔。
// 边界取最近的有效开发日（工作日或加班日，且未休假）；人天按有效开发日重算。
func ResizeSegment(p Plan, c Calendar, index int, edge string, date string) (Plan, error) {
	if index < 0 || index >= len(p.Segments) {
		return Plan{}, errIndexOutOfRange()
	}
	if edge != "start" && edge != "end" {
		return Plan{}, errInvalidEdge()
	}
	if _, err := ParseDate(date); err != nil {
		return Plan{}, err
	}
	idx := newCalendarIndex(c)
	segs := clonePlan(p).Segments
	seg := segs[index]
	vacationSet, overtimeSet := markSets(p)
	eligible := func(day string) bool {
		return !vacationSet[day] && (idx.isWorkday(day) || overtimeSet[day])
	}
	if edge == "start" {
		limit := minSupportedDate
		if index > 0 {
			if segs[index].HoldBefore && gapWorkdays(segs, index, idx) > 0 {
				// 真 HOLD 间隔不允许被收缩，保持在原开始日期。
				limit = seg.Start
			} else {
				limit = AddDays(segs[index-1].End, 1)
			}
		}
		if date < limit {
			date = limit
		}
		for guard := 0; date <= seg.End && !eligible(date) && guard < maxScanDays; guard++ {
			date = AddDays(date, 1)
		}
		if date == "" || date > seg.End || !eligible(date) {
			return Plan{}, errNoWorkdays()
		}
		segs[index].Start = date
	} else {
		limit := maxSupportedDate
		if index < len(segs)-1 {
			if segs[index+1].HoldBefore && gapWorkdays(segs, index+1, idx) > 0 {
				// 真 HOLD 间隔不允许被扩张，保持在原结束日期。
				limit = seg.End
			} else {
				limit = AddDays(segs[index+1].Start, -1)
			}
		}
		if date > limit {
			date = limit
		}
		for guard := 0; date >= seg.Start && !eligible(date) && guard < maxScanDays; guard++ {
			date = AddDays(date, -1)
		}
		if date == "" || date < seg.Start || !eligible(date) {
			return Plan{}, errNoWorkdays()
		}
		segs[index].End = date
	}
	days := effectiveTotal(segs, vacationSet, overtimeSet, idx)
	return Normalize(Plan{
		Segments: segs,
		Days:     float64(days),
		Vacation: p.Vacation,
		Overtime: p.Overtime,
	}, c)
}

// RemoveSegment 删除第 index 段。剩余段日期保持不变，人天合计剩余段有效开发日，
// 准入取第一段，交付取最后一段；新第一段的 HoldBefore 清空。
// 被删除段内的休假/加班标记一并清理；全部删除后清空准入与交付日期，保留删除前预估人天。
func RemoveSegment(p Plan, c Calendar, index int) (Plan, error) {
	if len(p.Segments) == 0 {
		return Plan{}, errNoSegments()
	}
	if index < 0 || index >= len(p.Segments) {
		return Plan{}, errIndexOutOfRange()
	}
	idx := newCalendarIndex(c)
	removed := p.Segments[index]
	segs := make([]Segment, 0, len(p.Segments)-1)
	segs = append(segs, p.Segments[:index]...)
	segs = append(segs, p.Segments[index+1:]...)
	vacation := filterMarks(p.Vacation, removed.Start, removed.End)
	overtime := filterMarks(p.Overtime, removed.Start, removed.End)
	if len(segs) == 0 {
		// 删完最后一段：清空日期，保留删除前的预估人天。
		return Normalize(Plan{
			Segments: []Segment{},
			Days:     p.Days,
			Vacation: vacation,
			Overtime: overtime,
		}, c)
	}
	segs = append([]Segment(nil), segs...)
	segs[0].HoldBefore = false
	days := effectiveTotal(segs, toSet(vacation), toSet(overtime), idx)
	return Normalize(Plan{
		Segments: segs,
		Days:     float64(days),
		Vacation: vacation,
		Overtime: overtime,
	}, c)
}

type mergePiece struct {
	segment Segment
	touched bool
}

// AddSegment 在 [start,end] 内补排期：只挑工作日、跳过休假、跳过已排期日期，
// 邻接或中间没有空工作日的片段自动合并，否则新增独立段；可覆盖原 HOLD 间隔。
// 被部分覆盖后仍含工作日的原 HOLD 间隔会保留在对应新段上；人天按有效开发日重算。
func AddSegment(p Plan, c Calendar, start, end string) (Plan, error) {
	if _, err := ParseDate(start); err != nil {
		return Plan{}, err
	}
	if _, err := ParseDate(end); err != nil {
		return Plan{}, err
	}
	if start > end {
		return Plan{}, errSegmentInvalid()
	}
	if !isInRange(start) || !isInRange(end) {
		return Plan{}, errRangeExceeded()
	}
	idx := newCalendarIndex(c)
	original := clonePlan(p).Segments
	vacationSet := toSet(p.Vacation)
	added := map[string]bool{}
	covered := func(day string) bool {
		for _, seg := range original {
			if day >= seg.Start && day <= seg.End {
				return true
			}
		}
		return false
	}
	for day, guard := start, 0; day <= end && guard < maxScanDays; day, guard = AddDays(day, 1), guard+1 {
		if day == "" {
			break
		}
		if !idx.isWorkday(day) || covered(day) || vacationSet[day] {
			continue
		}
		added[day] = true
	}
	if len(added) == 0 {
		return Plan{}, errNoWorkdays()
	}

	// 记录原 HOLD 间隔，供合并后重算标记。
	type holdRange struct{ start, end string }
	holds := make([]holdRange, 0, len(original))
	for i := 1; i < len(original); i++ {
		if !original[i].HoldBefore {
			continue
		}
		gapStart := AddDays(original[i-1].End, 1)
		gapEnd := AddDays(original[i].Start, -1)
		if gapStart == "" || gapEnd == "" || gapStart > gapEnd {
			continue
		}
		holds = append(holds, holdRange{start: gapStart, end: gapEnd})
	}

	pieces := make([]mergePiece, 0, len(original)+len(added))
	for _, seg := range original {
		pieces = append(pieces, mergePiece{segment: seg})
	}
	for day := range added {
		pieces = append(pieces, mergePiece{segment: Segment{Start: day, End: day}, touched: true})
	}
	for i := 1; i < len(pieces); i++ {
		for j := i; j > 0 && pieces[j].segment.Start < pieces[j-1].segment.Start; j-- {
			pieces[j], pieces[j-1] = pieces[j-1], pieces[j]
		}
	}
	merged := make([]mergePiece, 0, len(pieces))
	for _, current := range pieces {
		if len(merged) == 0 {
			merged = append(merged, current)
			continue
		}
		previous := &merged[len(merged)-1]
		unfilledGap := false
		gapStart := AddDays(previous.segment.End, 1)
		gapEnd := AddDays(current.segment.Start, -1)
		if gapStart != "" && gapEnd != "" && gapStart <= gapEnd {
			for day, guard := gapStart, 0; day <= gapEnd && guard < maxScanDays; day, guard = AddDays(day, 1), guard+1 {
				if day == "" {
					break
				}
				if !idx.isWorkday(day) || vacationSet[day] || added[day] {
					continue
				}
				unfilledGap = true
				break
			}
		}
		joins := current.segment.Start <= previous.segment.End ||
			((previous.touched || current.touched) && !unfilledGap)
		if joins {
			if current.segment.End > previous.segment.End {
				previous.segment.End = current.segment.End
			}
			previous.touched = previous.touched || current.touched
			continue
		}
		merged = append(merged, current)
	}

	segs := make([]Segment, 0, len(merged))
	for i, item := range merged {
		segment := item.segment
		segment.HoldBefore = false
		if i > 0 {
			newGapStart := AddDays(merged[i-1].segment.End, 1)
			newGapEnd := AddDays(segment.Start, -1)
			if newGapStart != "" && newGapEnd != "" && newGapStart <= newGapEnd {
				for _, hold := range holds {
					intersectStart, intersectEnd := hold.start, hold.end
					if newGapStart > intersectStart {
						intersectStart = newGapStart
					}
					if newGapEnd < intersectEnd {
						intersectEnd = newGapEnd
					}
					if intersectStart <= intersectEnd && idx.workdays(intersectStart, intersectEnd) > 0 {
						segment.HoldBefore = true
						break
					}
				}
			}
		}
		segs = append(segs, segment)
	}
	days := effectiveTotal(segs, vacationSet, toSet(p.Overtime), idx)
	return Normalize(Plan{
		Segments: segs,
		Days:     float64(days),
		Vacation: p.Vacation,
		Overtime: p.Overtime,
	}, c)
}

// SetDays 修改开发人天：默认延长或缩短最后一段；没有分段时按开始日期重新推算交付日期；
// Days == 0 表示待估，保留既有日期并回到 0 语义。
func SetDays(p Plan, c Calendar, days float64) (Plan, error) {
	if days < 0 || days > maxPlanDays || days != float64(int(days)) {
		return Plan{}, errInvalidDays()
	}
	idx := newCalendarIndex(c)
	vacationSet, overtimeSet := markSets(p)
	if days == 0 {
		return Normalize(Plan{
			Segments: clonePlan(p).Segments,
			Days:     0,
			Start:    p.Start,
			Delivery: p.Delivery,
			Vacation: p.Vacation,
			Overtime: p.Overtime,
		}, c)
	}
	if len(p.Segments) == 0 {
		if p.Start == "" {
			return Normalize(Plan{Days: days, Vacation: p.Vacation, Overtime: p.Overtime}, c)
		}
		end := idx.finishEffective(p.Start, int(days), vacationSet, overtimeSet)
		if end == "" {
			return Plan{}, errRangeExceeded()
		}
		return Normalize(Plan{
			Days:     days,
			Start:    p.Start,
			Delivery: end,
			Vacation: p.Vacation,
			Overtime: p.Overtime,
		}, c)
	}
	segs := clonePlan(p).Segments
	last := len(segs) - 1
	others := effectiveTotal(segs[:last], vacationSet, overtimeSet, idx)
	if int(days) < others+1 {
		return Plan{}, errDaysTooSmall(others)
	}
	newEnd := idx.finishEffective(segs[last].Start, int(days)-others, vacationSet, overtimeSet)
	if newEnd == "" {
		return Plan{}, errRangeExceeded()
	}
	segs[last].End = newEnd
	return Normalize(Plan{
		Segments: segs,
		Days:     days,
		Vacation: p.Vacation,
		Overtime: p.Overtime,
	}, c)
}

// SetDelivery 修改交付日期并按有效开发日反算人天；不能早于准入日期或最后一段开始日期，
// 且至少包含 1 个有效开发日。
func SetDelivery(p Plan, c Calendar, delivery string) (Plan, error) {
	if _, err := ParseDate(delivery); err != nil {
		return Plan{}, err
	}
	idx := newCalendarIndex(c)
	vacationSet, overtimeSet := markSets(p)
	if len(p.Segments) == 0 {
		if p.Start == "" {
			return Plan{}, errDeliveryWithoutStart()
		}
		if delivery < p.Start {
			return Plan{}, errDeliveryBeforeStart()
		}
		days := idx.effectiveCount(p.Start, delivery, vacationSet, overtimeSet)
		if days < 1 {
			return Plan{}, errNoWorkdays()
		}
		return Normalize(Plan{
			Days:     float64(days),
			Start:    p.Start,
			Delivery: delivery,
			Vacation: p.Vacation,
			Overtime: p.Overtime,
		}, c)
	}
	segs := clonePlan(p).Segments
	last := len(segs) - 1
	if delivery < segs[0].Start || delivery < segs[last].Start {
		return Plan{}, errDeliveryBeforeStart()
	}
	count := idx.effectiveCount(segs[last].Start, delivery, vacationSet, overtimeSet)
	if count < 1 {
		return Plan{}, errNoWorkdays()
	}
	others := effectiveTotal(segs[:last], vacationSet, overtimeSet, idx)
	segs[last].End = delivery
	return Normalize(Plan{
		Segments: segs,
		Days:     float64(others + count),
		Vacation: p.Vacation,
		Overtime: p.Overtime,
	}, c)
}

// SetVacation 标记/取消休假（只允许工作日）。仅修改标记，不改既有日期与人天。
func SetVacation(p Plan, c Calendar, day string, on bool) (Plan, error) {
	if _, err := ParseDate(day); err != nil {
		return Plan{}, err
	}
	if !IsWorkday(day, c) {
		return Plan{}, errMarkInvalid("休息日不能标记休假")
	}
	out := clonePlan(p)
	out.Vacation = toggleDate(out.Vacation, day, on)
	out.Overtime = toggleDate(out.Overtime, day, false)
	return out, nil
}

// SetOvertime 标记/取消加班（只允许休息日）。仅修改标记，不改既有日期与人天。
func SetOvertime(p Plan, c Calendar, day string, on bool) (Plan, error) {
	if _, err := ParseDate(day); err != nil {
		return Plan{}, err
	}
	if IsWorkday(day, c) {
		return Plan{}, errMarkInvalid("工作日不能标记加班")
	}
	out := clonePlan(p)
	out.Overtime = toggleDate(out.Overtime, day, on)
	out.Vacation = toggleDate(out.Vacation, day, false)
	return out, nil
}

// shiftMarks 把落在 [fromStart,fromEnd] 的标记平移 delta 天，用于段移动时标记跟段走。
// 平移后落在工作日的加班标记会被丢弃（加班只能标记休息日）。
func shiftMarks(values []string, fromStart, fromEnd string, delta int, idx *calendarIndex, overtime bool) []string {
	out := make([]string, 0, len(values))
	for _, day := range values {
		if day >= fromStart && day <= fromEnd {
			shifted := AddDays(day, delta)
			if shifted == "" {
				continue
			}
			if overtime && idx.isWorkday(shifted) {
				continue
			}
			out = append(out, shifted)
			continue
		}
		out = append(out, day)
	}
	sortStrings(out)
	return out
}

// filterMarks 返回不在 [start,end] 内的标记。
func filterMarks(values []string, start, end string) []string {
	out := make([]string, 0, len(values))
	for _, day := range values {
		if day >= start && day <= end {
			continue
		}
		out = append(out, day)
	}
	return out
}

// toggleDate 添加或移除一个日期并保持升序。
func toggleDate(values []string, day string, on bool) []string {
	out := make([]string, 0, len(values)+1)
	exists := false
	for _, value := range values {
		if value == day {
			exists = true
			if !on {
				continue
			}
		}
		out = append(out, value)
	}
	if on && !exists {
		out = append(out, day)
	}
	sortStrings(out)
	return out
}

func relationErrorf(message string) error {
	return &Error{Code: ErrInvalidPlan, Message: message}
}

// movePlan 把整个排期（含多段）移动到新的开始日期，保留各段有效开发天数与段间工作日空档，
// 段前 HOLD 标记与段内标记随段移动。单段模式保持单段模式（不强行生成 segments）。
func movePlan(p Plan, c Calendar, idx *calendarIndex, newStart string) (Plan, error) {
	if _, err := ParseDate(newStart); err != nil {
		return Plan{}, err
	}
	singleMode := len(p.Segments) == 0
	source := clonePlan(p).Segments
	if singleMode {
		if p.Start == "" || p.Delivery == "" {
			return Normalize(p, c)
		}
		source = []Segment{{Start: p.Start, End: p.Delivery}}
	}
	vacationSet, overtimeSet := markSets(p)
	newSegs := make([]Segment, 0, len(source))
	deltas := make([]int, len(source))
	for i, seg := range source {
		target := newStart
		if i > 0 {
			gap := idx.workdays(AddDays(source[i-1].End, 1), AddDays(seg.Start, -1))
			target = idx.shiftWorkdays(newSegs[i-1].End, gap+1)
			if target == "" {
				return Plan{}, errRangeExceeded()
			}
			if !idx.isWorkday(target) && idx.isWorkday(seg.Start) {
				return Plan{}, relationErrorf("跨过休息日后无法保持未选需求的原有关系，请一并勾选相邻需求")
			}
		}
		delta := daySpan(seg.Start, target)
		deltas[i] = delta
		duration := idx.effectiveCount(seg.Start, seg.End, vacationSet, overtimeSet)
		if duration < 1 {
			duration = PlaceholderDays
		}
		segVacation := map[string]bool{}
		segOvertime := map[string]bool{}
		for _, day := range p.Vacation {
			if day >= seg.Start && day <= seg.End {
				segVacation[AddDays(day, delta)] = true
			}
		}
		for _, day := range p.Overtime {
			if day >= seg.Start && day <= seg.End {
				shifted := AddDays(day, delta)
				if shifted != "" && !idx.isWorkday(shifted) {
					segOvertime[shifted] = true
				}
			}
		}
		end := idx.finishEffective(target, duration, segVacation, segOvertime)
		if end == "" {
			return Plan{}, errRangeExceeded()
		}
		newSegs = append(newSegs, Segment{Start: target, End: end, HoldBefore: seg.HoldBefore})
	}
	newSegs[0].HoldBefore = false
	deltaFor := func(day string) (int, bool) {
		for i, seg := range source {
			if day >= seg.Start && day <= seg.End {
				return deltas[i], true
			}
		}
		return 0, false
	}
	vacation := make([]string, 0, len(p.Vacation))
	for _, day := range p.Vacation {
		if delta, ok := deltaFor(day); ok {
			if shifted := AddDays(day, delta); shifted != "" {
				vacation = append(vacation, shifted)
			}
			continue
		}
		vacation = append(vacation, day)
	}
	overtime := make([]string, 0, len(p.Overtime))
	for _, day := range p.Overtime {
		if delta, ok := deltaFor(day); ok {
			shifted := AddDays(day, delta)
			if shifted != "" && !idx.isWorkday(shifted) {
				overtime = append(overtime, shifted)
			}
			continue
		}
		overtime = append(overtime, day)
	}
	if singleMode {
		return Normalize(Plan{
			Segments: []Segment{},
			Days:     p.Days,
			Start:    newSegs[0].Start,
			Delivery: newSegs[0].End,
			Vacation: vacation,
			Overtime: overtime,
		}, c)
	}
	return Normalize(Plan{
		Segments: newSegs,
		Days:     p.Days,
		Vacation: vacation,
		Overtime: overtime,
	}, c)
}
