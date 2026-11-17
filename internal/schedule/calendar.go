// Package schedule 提供 RSM 的纯排期核心：中国工作日日历、排期段校验与归一化、
// 单段移动/伸缩/删除/补排期、人天与交付联动，以及顺排预览。
//
// 日期一律为 "YYYY-MM-DD" 的 ISO 字符串，内部按 UTC 计算，不依赖本地时区或夏令时。
// 本包不访问数据库、网络或全局可变状态，Go 服务端与前端 TypeScript 预览共用
// testdata/schedule/cases.json 中的同一批用例保证行为一致。
package schedule

import (
	"time"
)

// DateLayout 是全包统一使用的 ISO 日期布局。
const DateLayout = "2006-01-02"

// 可排期日期的硬边界，避免异常输入触发超长循环。
const (
	minSupportedDate = "1970-01-01"
	maxSupportedDate = "2099-12-31"
	maxPlanYears     = 5
	maxPlanDays      = 1305 // 5 年按约 261 个工作日/年折算的上限
	maxScanDays      = 4000 // 单次区间扫描保护，远大于 5 年跨度
)

// Calendar 是中国工作日日历。RestDays 为放假日期，WorkDays 为调休上班日期，
// 二者优先于周末规则；没有列出的日期按周六周日休息。Years 声明可靠覆盖的年份，
// 超出该范围的日期仍按周末规则计算，调用方可据此提示用户。
type Calendar struct {
	RestDays []string          `json:"restDays"`
	WorkDays []string          `json:"workDays"`
	Years    []int             `json:"years"`
	Source   string            `json:"source"`
	Editions []CalendarEdition `json:"editions,omitempty"`
}

const defaultCalendarSource = "本地维护：国务院办公厅关于2025年部分节假日安排的通知（国办发明电〔2024〕12号）、关于2026年部分节假日安排的通知（国办发明电〔2025〕7号）、关于2027年部分节假日安排的通知；未覆盖年份按周末规则计算"

type holidayRange struct{ from, to string }

var defaultRestRanges = []holidayRange{
	// 2025
	{"2025-01-01", "2025-01-01"},
	{"2025-01-28", "2025-02-04"},
	{"2025-04-04", "2025-04-06"},
	{"2025-05-01", "2025-05-05"},
	{"2025-05-31", "2025-06-02"},
	{"2025-10-01", "2025-10-08"},
	// 2026
	{"2026-01-01", "2026-01-03"},
	{"2026-02-15", "2026-02-23"},
	{"2026-04-04", "2026-04-06"},
	{"2026-05-01", "2026-05-05"},
	{"2026-06-19", "2026-06-21"},
	{"2026-09-25", "2026-09-27"},
	{"2026-10-01", "2026-10-07"},
	// 2027
	{"2027-01-01", "2027-01-03"},
	{"2027-02-05", "2027-02-13"},
	{"2027-04-03", "2027-04-05"},
	{"2027-05-01", "2027-05-05"},
	{"2027-06-09", "2027-06-09"},
	{"2027-09-15", "2027-09-15"},
	{"2027-10-01", "2027-10-07"},
}

var defaultWorkDays = []string{
	// 2025 调休上班
	"2025-01-26", "2025-02-08", "2025-04-27", "2025-09-28", "2025-10-11",
	// 2026 调休上班
	"2026-01-04", "2026-02-14", "2026-02-28", "2026-05-09", "2026-09-20", "2026-10-10",
	// 2027 调休上班
	"2027-01-31", "2027-02-14", "2027-05-08", "2027-09-26", "2027-10-09",
}

// DefaultCalendar 返回 2025—2027 年已公布的中国法定假日与调休安排。
// 每次调用返回新的切片，调用方可以安全修改返回值。
func DefaultCalendar() Calendar {
	rest := make([]string, 0, 96)
	for _, r := range defaultRestRanges {
		for day := r.from; day <= r.to; day = mustAddDays(day, 1) {
			rest = append(rest, day)
		}
	}
	c := Calendar{
		RestDays: rest,
		WorkDays: append([]string(nil), defaultWorkDays...),
		Years:    []int{2025, 2026, 2027},
		Source:   defaultCalendarSource,
	}
	papers := map[int]string{
		2025: "https://www.gov.cn/zhengce/zhengceku/202411/content_6986383.htm",
		2026: "https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm",
		2027: "https://www.gov.cn/zhengce/zhengceku/202611/content_7085102.htm",
	}
	for _, year := range c.Years {
		edition := CalendarEdition{Year: year, Source: "内置 · 国务院办公厅公告", Papers: []string{papers[year]}, Days: []HolidayDay{}}
		for _, date := range c.RestDays {
			if YearOf(date) == year {
				edition.Days = append(edition.Days, HolidayDay{Name: "法定节假日", Date: date, IsOffDay: true})
			}
		}
		for _, date := range c.WorkDays {
			if YearOf(date) == year {
				edition.Days = append(edition.Days, HolidayDay{Name: "调休上班", Date: date, IsOffDay: false})
			}
		}
		c.Editions = append(c.Editions, edition)
	}
	return c
}

// ParseDate 严格解析 ISO 日期，拒绝 "2026-2-1"、"2026-02-30" 等写法。
func ParseDate(day string) (time.Time, error) {
	if len(day) != len("2006-01-02") || day[4] != '-' || day[7] != '-' {
		return time.Time{}, &Error{Code: ErrInvalidDate, Message: "日期必须是有效的 YYYY-MM-DD"}
	}
	t, err := time.Parse(DateLayout, day)
	if err != nil || t.Format(DateLayout) != day {
		return time.Time{}, &Error{Code: ErrInvalidDate, Message: "日期必须是有效的 YYYY-MM-DD"}
	}
	return t, nil
}

// ValidDate 判断字符串是否为有效 ISO 日期。
func ValidDate(day string) bool {
	_, err := ParseDate(day)
	return err == nil
}

// AddDays 返回偏移 n 天后的日期；输入非法时返回空字符串。
func AddDays(day string, n int) string {
	t, err := ParseDate(day)
	if err != nil {
		return ""
	}
	return t.AddDate(0, 0, n).Format(DateLayout)
}

func mustAddDays(day string, n int) string {
	return AddDays(day, n)
}

// Weekday 返回 ISO 日期的星期（0 为周日）；非法日期返回 0 与错误。
func Weekday(day string) (time.Weekday, error) {
	t, err := ParseDate(day)
	if err != nil {
		return time.Sunday, err
	}
	return t.Weekday(), nil
}

func isInRange(day string) bool {
	return day >= minSupportedDate && day <= maxSupportedDate
}

// IsWorkday 判断某天是否为中国法定工作日：调休上班日为工作日；放假日期与周末为休息日；
// 未在 Calendar 中列出的年份按周末规则计算。非法日期返回 false。
// 该函数只做 O(len(RestDays)+len(WorkDays)) 比较，不扫描整年；
// 大量逐格渲染请在前端缓存日历索引（TypeScript 侧已内置缓存）。
func IsWorkday(day string, c Calendar) bool {
	t, err := ParseDate(day)
	if err != nil {
		return false
	}
	for _, d := range c.WorkDays {
		if d == day {
			return true
		}
	}
	for _, d := range c.RestDays {
		if d == day {
			return false
		}
	}
	weekday := t.Weekday()
	return weekday != time.Saturday && weekday != time.Sunday
}

// IsSupportedYear 判断日历是否声明可靠覆盖该年份。未覆盖年份仍按周末规则参与计算。
func IsSupportedYear(year int, c Calendar) bool {
	for _, y := range c.Years {
		if y == year {
			return true
		}
	}
	return false
}

// YearOf 返回 ISO 日期所在年份；非法日期返回 0。
func YearOf(day string) int {
	t, err := ParseDate(day)
	if err != nil {
		return 0
	}
	return t.Year()
}

// calendarIndex 是排期计算内部使用的日历索引，一次构建多次查询。
type calendarIndex struct {
	rest map[string]struct{}
	work map[string]struct{}
}

func newCalendarIndex(c Calendar) *calendarIndex {
	idx := &calendarIndex{
		rest: make(map[string]struct{}, len(c.RestDays)),
		work: make(map[string]struct{}, len(c.WorkDays)),
	}
	for _, d := range c.RestDays {
		if ValidDate(d) {
			idx.rest[d] = struct{}{}
		}
	}
	for _, d := range c.WorkDays {
		if ValidDate(d) {
			idx.work[d] = struct{}{}
		}
	}
	return idx
}

func (idx *calendarIndex) isWorkday(day string) bool {
	t, err := ParseDate(day)
	if err != nil {
		return false
	}
	if _, ok := idx.work[day]; ok {
		return true
	}
	if _, ok := idx.rest[day]; ok {
		return false
	}
	weekday := t.Weekday()
	return weekday != time.Saturday && weekday != time.Sunday
}

func (idx *calendarIndex) workdays(start, end string) int {
	if !ValidDate(start) || !ValidDate(end) || end < start {
		return 0
	}
	count := 0
	for day, guard := start, 0; day <= end && guard < maxScanDays; day, guard = mustAddDays(day, 1), guard+1 {
		if idx.isWorkday(day) {
			count++
		}
	}
	return count
}

// isEffective 判断某天是否计为一个有效开发日：休假日不计，
// 工作日或已标记加班的休息日计入。与原型 dayState 的有效开发日口径一致。
func (idx *calendarIndex) isEffective(day string, vacation, overtime map[string]bool) bool {
	if vacation[day] {
		return false
	}
	return idx.isWorkday(day) || overtime[day]
}

// effectiveCount 返回闭区间内计入人天的有效开发日数量。
func (idx *calendarIndex) effectiveCount(start, end string, vacation, overtime map[string]bool) int {
	if !ValidDate(start) || !ValidDate(end) || end < start {
		return 0
	}
	count := 0
	for day, guard := start, 0; day <= end && guard < maxScanDays; day, guard = mustAddDays(day, 1), guard+1 {
		if day != "" && idx.isEffective(day, vacation, overtime) {
			count++
		}
	}
	return count
}

// finishEffective 返回从 start（含）开始第 days 个有效开发日的日期。
func (idx *calendarIndex) finishEffective(start string, days int, vacation, overtime map[string]bool) string {
	if days < 1 || !ValidDate(start) {
		return ""
	}
	left := days
	for day, guard := start, 0; guard < maxScanDays; day, guard = mustAddDays(day, 1), guard+1 {
		if day != "" && idx.isEffective(day, vacation, overtime) {
			left--
			if left == 0 {
				return day
			}
		}
	}
	return ""
}

// nextWorkday 返回不早于 day 的第一个工作日。
func (idx *calendarIndex) nextWorkday(day string) string {
	for guard := 0; day != "" && guard < maxScanDays; guard++ {
		if idx.isWorkday(day) {
			return day
		}
		day = mustAddDays(day, 1)
	}
	return ""
}

// prevWorkday 返回不晚于 day 的最后一个工作日。
func (idx *calendarIndex) prevWorkday(day string) string {
	for guard := 0; day != "" && guard < maxScanDays; guard++ {
		if idx.isWorkday(day) {
			return day
		}
		day = mustAddDays(day, -1)
	}
	return ""
}

// finish 返回从 start（含）开始第 days 个工作日的日期；days 必须 >= 1。
func (idx *calendarIndex) finish(start string, days int) string {
	if days < 1 || !ValidDate(start) {
		return ""
	}
	left := days
	for day, guard := start, 0; guard < maxScanDays; day, guard = mustAddDays(day, 1), guard+1 {
		if idx.isWorkday(day) {
			left--
			if left == 0 {
				return day
			}
		}
	}
	return ""
}

// shiftWorkdays 按工作日步进：n>0 向后移动 n 个工作日，n<0 向前移动。
// 与原型 moveWorkingDate 一致，起点本身不计入步进。
func (idx *calendarIndex) shiftWorkdays(day string, n int) string {
	if !ValidDate(day) || n == 0 {
		return day
	}
	step, left := 1, n
	if n < 0 {
		step, left = -1, -n
	}
	for guard := 0; left > 0 && guard < maxScanDays; guard++ {
		day = mustAddDays(day, step)
		if idx.isWorkday(day) {
			left--
		}
	}
	if left > 0 {
		return ""
	}
	return day
}

// workingOffset 返回两个日期之间间隔的工作日数量（b>=a 为正）。
func (idx *calendarIndex) workingOffset(a, b string) int {
	if !ValidDate(a) || !ValidDate(b) {
		return 0
	}
	if b >= a {
		return idx.workdays(mustAddDays(a, 1), b)
	}
	return -idx.workdays(mustAddDays(b, 1), a)
}

// daySpan 返回两个 ISO 日期之间相差的自然日数量。
func daySpan(a, b string) int {
	ta, errA := ParseDate(a)
	tb, errB := ParseDate(b)
	if errA != nil || errB != nil {
		return 0
	}
	return int(tb.Sub(ta).Hours() / 24)
}

// CountWorkdays 返回闭区间 [start,end] 内的工作日数量。
func CountWorkdays(start, end string, c Calendar) int {
	return newCalendarIndex(c).workdays(start, end)
}

// AddWorkdays 返回从 start（含）开始第 n 个工作日的日期。
func AddWorkdays(start string, n int, c Calendar) (string, error) {
	if n < 1 {
		return "", &Error{Code: ErrInvalidDays, Message: "工作日天数必须大于 0"}
	}
	out := newCalendarIndex(c).finish(start, n)
	if out == "" {
		return "", &Error{Code: ErrRangeExceeded, Message: "排期日期超出支持范围"}
	}
	return out, nil
}

// NextWorkday 返回不早于 day 的第一个工作日。
func NextWorkday(day string, c Calendar) (string, error) {
	out := newCalendarIndex(c).nextWorkday(day)
	if out == "" {
		return "", &Error{Code: ErrRangeExceeded, Message: "排期日期超出支持范围"}
	}
	return out, nil
}

// UnsupportedYears 返回 plans 中不在日历覆盖范围内的年份（去重升序），前端可据此提示。
func UnsupportedYears(c Calendar, days ...string) []int {
	seen := map[int]struct{}{}
	var out []int
	for _, day := range days {
		year := YearOf(day)
		if year == 0 || IsSupportedYear(year, c) {
			continue
		}
		if _, ok := seen[year]; ok {
			continue
		}
		seen[year] = struct{}{}
		out = append(out, year)
	}
	sortInts(out)
	return out
}

func sortInts(values []int) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}

// normalizeStrings 校验、去重并排序日期字符串列表。
func normalizeStrings(values []string) ([]string, error) {
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, err := ParseDate(value); err != nil {
			return nil, err
		}
		if !isInRange(value) {
			return nil, &Error{Code: ErrRangeExceeded, Message: "标记日期超出支持范围"}
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	sortStrings(out)
	return out, nil
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}

func containsDate(values []string, day string) bool {
	for _, value := range values {
		if value == day {
			return true
		}
	}
	return false
}

func cloneStrings(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}
	return append([]string(nil), values...)
}
