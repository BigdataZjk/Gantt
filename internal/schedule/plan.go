package schedule

import (
	"math"
)

// Segment 是一个连续排期段，日期均为 ISO 字符串。
// HoldBefore 表示本段之前、与上一段之间的间隔是否被用户显式标记为 HOLD；
// 只有该标记为真且间隔内存在工作日时，才显示 HOLD（纯周末/法定假日空档不是 HOLD）。
type Segment struct {
	Start      string `json:"start"`
	End        string `json:"end"`
	HoldBefore bool   `json:"holdBefore,omitempty"`
}

// Plan 是一个需求的排期信息。
//
// Segments 为多段排期；Start 取第一段开始，Delivery 取最后一段结束。
// Days 是所有排期段内的工作日总数，不计段间空档；Days == 0 表示待估，
// 图上按 PlaceholderDays 占位但保留 0 语义。
// Vacation 为按需求按天的休假标记，Overtime 为休息日加班标记。
// 标记本身不改变既有日期和人天；后续拉伸、补排期、人天/交付联动会按
// “有效开发日”（工作日或加班，且未休假）重新计算人天（与原型一致）。
type Plan struct {
	Segments []Segment `json:"segments"`
	Days     float64   `json:"days"`
	Start    string    `json:"start"`
	Delivery string    `json:"delivery"`
	Vacation []string  `json:"vacation"`
	Overtime []string  `json:"overtime"`
}

// PlaceholderDays 是待估（Days == 0）但已有日期时的图上占位开发天数。
const PlaceholderDays = 3

// DisplayDays 返回图上应该展示的开发天数：待估按 PlaceholderDays 占位。
func DisplayDays(p Plan) float64 {
	if p.Days <= 0 {
		return PlaceholderDays
	}
	return p.Days
}

// markSets 把计划级休假/加班标记转成查询集合。
func markSets(p Plan) (map[string]bool, map[string]bool) {
	vacation := make(map[string]bool, len(p.Vacation))
	for _, day := range p.Vacation {
		vacation[day] = true
	}
	overtime := make(map[string]bool, len(p.Overtime))
	for _, day := range p.Overtime {
		overtime[day] = true
	}
	return vacation, overtime
}

func hasMarks(p Plan) bool {
	return len(p.Vacation) > 0 || len(p.Overtime) > 0
}

// Normalize 校验并归一化排期，供 Go 服务端与前端共用同一套规则。
//
// 规则：
//   - 日期必须是有效的 ISO 日期，且在 1970-01-01 至 2099-12-31 之间，排期跨度不超过 5 年；
//   - 分段必须按开始日期严格升序、互不重叠；每段至少包含 1 个工作日或有效开发日（加班日）；
//   - 第一段不能带 HoldBefore（段前没有上一段），其余分段的 HoldBefore 原样保留；
//   - 有分段时 Start 取第一段开始、Delivery 取最后一段结束；
//   - 没有休假/加班标记时，Days > 0 与分段严格联动：人天不足则延长最后一段、超出则缩短
//     最后一段，前面各段已占人天 + 最后一段至少 1 人天仍不够时返回 days_too_small；
//   - 存在休假/加班标记时，标记本身不改变人天，因此接受已存储的 Days（不再根据日期反推），
//     避免“标记/取消标记”把既有日期和人天改掉；日期结构仍严格校验；
//   - 无分段时保留预估人天；Days == 0 表示待估，保留 0 语义，仅有开始日期时按
//     PlaceholderDays 生成占位交付日期用于展示；
//   - Vacation、Overtime 只做日期校验、去重与排序，不影响日期和已存储人天。
func Normalize(p Plan, c Calendar) (Plan, error) {
	if math.IsNaN(p.Days) || math.IsInf(p.Days, 0) || p.Days < 0 || p.Days > maxPlanDays || p.Days != math.Trunc(p.Days) {
		return Plan{}, errInvalidDays()
	}
	idx := newCalendarIndex(c)
	vacation, err := normalizeStrings(p.Vacation)
	if err != nil {
		return Plan{}, err
	}
	overtime, err := normalizeStrings(p.Overtime)
	if err != nil {
		return Plan{}, err
	}
	out := Plan{
		Segments: []Segment{},
		Days:     p.Days,
		Start:    p.Start,
		Delivery: p.Delivery,
		Vacation: vacation,
		Overtime: overtime,
	}

	segs := make([]Segment, 0, len(p.Segments))
	for _, raw := range p.Segments {
		if raw.Start == "" || raw.End == "" {
			return Plan{}, errSegmentInvalid()
		}
		if _, err := ParseDate(raw.Start); err != nil {
			return Plan{}, err
		}
		if _, err := ParseDate(raw.End); err != nil {
			return Plan{}, err
		}
		if raw.Start > raw.End {
			return Plan{}, errSegmentInvalid()
		}
		if !isInRange(raw.Start) || !isInRange(raw.End) {
			return Plan{}, errRangeExceeded()
		}
		segs = append(segs, Segment{Start: raw.Start, End: raw.End, HoldBefore: raw.HoldBefore})
	}

	if len(segs) == 0 {
		return normalizeWithoutSegments(out, idx, c)
	}
	for i := 1; i < len(segs); i++ {
		if segs[i].Start <= segs[i-1].Start {
			return Plan{}, errSegmentOrder()
		}
		if segs[i].Start <= segs[i-1].End {
			return Plan{}, errSegmentOverlap()
		}
	}
	// 第一段之前没有间隔，不允许残留 HoldBefore。
	segs[0].HoldBefore = false
	vacationSet, overtimeSet := markSets(out)
	last := len(segs) - 1
	total := 0
	lastCount := 0
	for i, seg := range segs {
		base := idx.workdays(seg.Start, seg.End)
		effective := idx.effectiveCount(seg.Start, seg.End, vacationSet, overtimeSet)
		if base < 1 && effective < 1 {
			return Plan{}, errSegmentNoWorkdays()
		}
		total += base
		if i == last {
			lastCount = base
		}
	}
	if out.Days > 0 && !hasMarks(out) && total != int(out.Days) {
		// 无标记时人天与分段严格联动：以人天为准调整最后一段。
		others := total - lastCount
		if int(out.Days) < others+1 {
			return Plan{}, errDaysTooSmall(others)
		}
		target := int(out.Days) - others
		newEnd := idx.finish(segs[last].Start, target)
		if newEnd == "" {
			return Plan{}, errRangeExceeded()
		}
		segs[last].End = newEnd
	}
	out.Segments = segs
	out.Start = segs[0].Start
	out.Delivery = segs[last].End
	if err := validatePlanRange(out); err != nil {
		return Plan{}, err
	}
	return out, nil
}

// normalizeWithoutSegments 处理单段/无分段排期：保留预估人天，联动交付与开始日期。
func normalizeWithoutSegments(out Plan, idx *calendarIndex, c Calendar) (Plan, error) {
	start, delivery := out.Start, out.Delivery
	if start != "" {
		if _, err := ParseDate(start); err != nil {
			return Plan{}, err
		}
		if !isInRange(start) {
			return Plan{}, errRangeExceeded()
		}
	}
	if delivery != "" {
		if _, err := ParseDate(delivery); err != nil {
			return Plan{}, err
		}
		if !isInRange(delivery) {
			return Plan{}, errRangeExceeded()
		}
		if start == "" {
			return Plan{}, errDeliveryWithoutStart()
		}
		if delivery < start {
			return Plan{}, errDeliveryBeforeStart()
		}
	}
	vacationSet, overtimeSet := markSets(out)
	marked := hasMarks(out)
	if out.Days == 0 {
		// 待估：保留 0 语义；仅开始日期时生成 3 个有效开发日占位交付日期用于展示。
		if start != "" && delivery == "" {
			delivery = idx.finishEffective(start, PlaceholderDays, vacationSet, overtimeSet)
			if delivery == "" {
				return Plan{}, errRangeExceeded()
			}
		}
		out.Start, out.Delivery = start, delivery
		out.Segments = []Segment{}
		return out, validatePlanRange(out)
	}
	if start == "" {
		// 空排期只保留预估人天，不生成日期。
		out.Start, out.Delivery = "", ""
		out.Segments = []Segment{}
		return out, nil
	}
	if delivery == "" {
		delivery = idx.finishEffective(start, int(out.Days), vacationSet, overtimeSet)
		if delivery == "" {
			return Plan{}, errRangeExceeded()
		}
	}
	if !marked {
		// 无休假/加班标记时，以日期反算人天（与服务端保存口径一致）。
		days := idx.workdays(start, delivery)
		if days < 1 {
			return Plan{}, errNoWorkdays()
		}
		if days > maxPlanDays {
			return Plan{}, errInvalidDays()
		}
		out.Days = float64(days)
	}
	out.Start, out.Delivery = start, delivery
	out.Segments = []Segment{}
	return out, validatePlanRange(out)
}

// validatePlanRange 校验所有排期日期在硬边界内且整段跨度不超过 5 年。
func validatePlanRange(p Plan) error {
	dates := make([]string, 0, len(p.Segments)*2+2)
	dates = append(dates, p.Start, p.Delivery)
	for _, seg := range p.Segments {
		dates = append(dates, seg.Start, seg.End)
	}
	for _, day := range dates {
		if day == "" {
			continue
		}
		if !isInRange(day) {
			return errRangeExceeded()
		}
	}
	first, last := p.Start, p.Delivery
	if len(p.Segments) > 0 {
		first = p.Segments[0].Start
		last = p.Segments[len(p.Segments)-1].End
	}
	if first == "" || last == "" {
		return nil
	}
	if last < first {
		return errSegmentInvalid()
	}
	t, err := ParseDate(first)
	if err != nil {
		return err
	}
	limit := t.AddDate(maxPlanYears, 0, 0).Format(DateLayout)
	if last > limit {
		return errRangeExceeded()
	}
	return nil
}

// EffectiveSegments 返回渲染用排期段：有多段时原样返回；单段模式（只有 Start/Delivery）
// 合成一段，供前端甘特图与后端展示统一使用。
func EffectiveSegments(p Plan) []Segment {
	if len(p.Segments) > 0 {
		out := make([]Segment, len(p.Segments))
		copy(out, p.Segments)
		return out
	}
	if p.Start == "" || p.Delivery == "" {
		return []Segment{}
	}
	return []Segment{{Start: p.Start, End: p.Delivery}}
}

// SegmentDays 返回一个排期段内的工作日数量（不含加班、不扣休假）。
func SegmentDays(seg Segment, c Calendar) int {
	return newCalendarIndex(c).workdays(seg.Start, seg.End)
}

// TotalDays 返回所有排期段的工作日总数（不含加班、不扣休假），不计段间空档。
func TotalDays(p Plan, c Calendar) int {
	idx := newCalendarIndex(c)
	total := 0
	for _, seg := range p.Segments {
		total += idx.workdays(seg.Start, seg.End)
	}
	return total
}

// SegmentEffectiveDays 返回一个排期段内的有效开发日数量：
// 工作日且未休假，或休息日已标记加班；与原型 phaseDays 口径一致。
func SegmentEffectiveDays(p Plan, seg Segment, c Calendar) int {
	idx := newCalendarIndex(c)
	vacation, overtime := markSets(p)
	return idx.effectiveCount(seg.Start, seg.End, vacation, overtime)
}

// EffectiveDays 返回所有排期段的有效开发日总数（含加班、扣休假），不计段间空档。
func EffectiveDays(p Plan, c Calendar) int {
	idx := newCalendarIndex(c)
	vacation, overtime := markSets(p)
	total := 0
	for _, seg := range p.Segments {
		total += idx.effectiveCount(seg.Start, seg.End, vacation, overtime)
	}
	return total
}

// DeliveryOf 返回交付日期：最后一段结束；否则用已存交付或按有效开发日推算。
func DeliveryOf(p Plan, c Calendar) string {
	if len(p.Segments) > 0 {
		return p.Segments[len(p.Segments)-1].End
	}
	if p.Delivery != "" && ValidDate(p.Delivery) {
		return p.Delivery
	}
	if p.Start == "" {
		return ""
	}
	idx := newCalendarIndex(c)
	days := int(p.Days)
	if days < 1 {
		days = PlaceholderDays
	}
	vacation, overtime := markSets(p)
	return idx.finishEffective(p.Start, days, vacation, overtime)
}

// Gap 是两段排期之间的间隔。Hold 为真表示用户把该间隔显式标记为 HOLD
// （下一段的 HoldBefore 为真）且间隔内存在工作日；纯周末或连续法定休息日空档
// 即使勾选 HOLD 也不是真 HOLD。
type Gap struct {
	AfterIndex int    `json:"afterIndex"`
	Start      string `json:"start"`
	End        string `json:"end"`
	Workdays   int    `json:"workdays"`
	Hold       bool   `json:"hold"`
}

// Gaps 返回分段之间的间隔信息。
func Gaps(p Plan, c Calendar) []Gap {
	idx := newCalendarIndex(c)
	out := make([]Gap, 0, len(p.Segments))
	for i := 1; i < len(p.Segments); i++ {
		start := AddDays(p.Segments[i-1].End, 1)
		end := AddDays(p.Segments[i].Start, -1)
		if start == "" || end == "" || start > end {
			continue
		}
		workdays := idx.workdays(start, end)
		out = append(out, Gap{
			AfterIndex: i - 1,
			Start:      start,
			End:        end,
			Workdays:   workdays,
			Hold:       p.Segments[i].HoldBefore && workdays > 0,
		})
	}
	return out
}

// ActiveDays 返回排期段覆盖的实际开发日集合：工作日且未休假，或已标记加班。
func ActiveDays(p Plan, c Calendar) map[string]struct{} {
	idx := newCalendarIndex(c)
	vacation, overtime := markSets(p)
	days := map[string]struct{}{}
	for _, seg := range p.Segments {
		for day, guard := seg.Start, 0; day <= seg.End && guard < maxScanDays; day, guard = AddDays(day, 1), guard+1 {
			if day == "" {
				break
			}
			if idx.isEffective(day, vacation, overtime) {
				days[day] = struct{}{}
			}
		}
	}
	return days
}

// OverlapDays 返回两个需求在同一开发日内并行开发的天数。
func OverlapDays(a, b Plan, c Calendar) int {
	start, end := a.Start, DeliveryOf(a, c)
	otherStart, otherEnd := b.Start, DeliveryOf(b, c)
	if start == "" || end == "" || otherStart == "" || otherEnd == "" {
		return 0
	}
	if otherStart > start {
		start = otherStart
	}
	if otherEnd < end {
		end = otherEnd
	}
	if start > end {
		return 0
	}
	activeA := ActiveDays(a, c)
	activeB := ActiveDays(b, c)
	count := 0
	for day, guard := start, 0; day <= end && guard < maxScanDays; day, guard = AddDays(day, 1), guard+1 {
		if day == "" {
			break
		}
		if _, ok := activeA[day]; !ok {
			continue
		}
		if _, ok := activeB[day]; ok {
			count++
		}
	}
	return count
}

// Overlaps 判断两个需求是否存在并行开发日。
func Overlaps(a, b Plan, c Calendar) bool {
	return OverlapDays(a, b, c) > 0
}

// Unscheduled 判断排期是否没有任何日期（仍可能有预估人天）。
func Unscheduled(p Plan) bool {
	return len(p.Segments) == 0 && p.Start == "" && p.Delivery == ""
}

// Estimated 判断是否处于待估人天状态（Days == 0）。
func Estimated(p Plan) bool {
	return p.Days == 0
}

// clonePlan 深拷贝切片，避免操作函数修改入参。
func clonePlan(p Plan) Plan {
	segments := make([]Segment, len(p.Segments))
	copy(segments, p.Segments)
	return Plan{
		Segments: segments,
		Days:     p.Days,
		Start:    p.Start,
		Delivery: p.Delivery,
		Vacation: cloneStrings(p.Vacation),
		Overtime: cloneStrings(p.Overtime),
	}
}

func sortSegments(segs []Segment) {
	for i := 1; i < len(segs); i++ {
		for j := i; j > 0 && segs[j].Start < segs[j-1].Start; j-- {
			segs[j], segs[j-1] = segs[j-1], segs[j]
		}
	}
}
