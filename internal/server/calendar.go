package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"slices"
	"time"

	"rsm/internal/auth"
	"rsm/internal/history"
	"rsm/internal/requests"
	"rsm/internal/schedule"
	"rsm/internal/store"
)

const holidaySource = "https://github.com/NateScarlet/holiday-cn"
const maxCalendarBytes = 256 << 10

var holidayClient = &http.Client{
	Timeout:       8 * time.Second,
	CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
}

func (s *Server) calendarPermission(w http.ResponseWriter, r *http.Request) bool {
	u := actor(r)
	if u.ID == "" {
		s.fail(w, store.ErrUnauthorized)
		return false
	}
	if !u.Admin() {
		s.fail(w, store.ErrForbidden)
		return false
	}
	return true
}

func (s *Server) refreshCalendar(w http.ResponseWriter, r *http.Request) {
	if !s.calendarPermission(w, r) {
		return
	}
	var in struct {
		Base *int64 `json:"baseRevision"`
		Year int    `json:"year"`
	}
	if err := decode(w, r, &in); err != nil {
		s.fail(w, err)
		return
	}
	if err := revision(in.Base); err != nil {
		s.fail(w, err)
		return
	}
	if in.Year < 2000 || in.Year > 2099 {
		s.fail(w, store.Bad("请选择 2000—2099 年"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 18*time.Second)
	defer cancel()
	var edition schedule.CalendarEdition
	var err error
	for _, pattern := range []string{
		"https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/%d.json",
		"https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/%d.json",
	} {
		edition, err = fetchHoliday(ctx, fmt.Sprintf(pattern, in.Year), in.Year)
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			break
		}
	}
	if err != nil {
		s.fail(w, store.Bad("未能取得有效年度日历：可能尚未公布或网络不可用。原日历已保留，可稍后刷新或导入 JSON。"))
		return
	}
	edition.Source = holidaySource
	s.saveCalendar(w, r, in.Base, edition)
}

func fetchHoliday(ctx context.Context, address string, year int) (schedule.CalendarEdition, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return schedule.CalendarEdition{}, err
	}
	res, err := holidayClient.Do(req)
	if err != nil {
		return schedule.CalendarEdition{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return schedule.CalendarEdition{}, fmt.Errorf("日历源响应 %d", res.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxCalendarBytes+1))
	if err != nil {
		return schedule.CalendarEdition{}, err
	}
	if len(raw) > maxCalendarBytes {
		return schedule.CalendarEdition{}, fmt.Errorf("日历源超过大小限制")
	}
	return schedule.ParseHolidayJSON(raw, year)
}

func (s *Server) importCalendar(w http.ResponseWriter, r *http.Request) {
	if !s.calendarPermission(w, r) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxCalendarBytes)
	var in struct {
		Base     *int64          `json:"baseRevision"`
		Year     int             `json:"year"`
		Calendar json.RawMessage `json:"calendar"`
	}
	if err := decode(w, r, &in); err != nil {
		s.fail(w, err)
		return
	}
	if err := revision(in.Base); err != nil {
		s.fail(w, err)
		return
	}
	edition, err := schedule.ParseHolidayJSON(in.Calendar, in.Year)
	if err != nil {
		s.fail(w, store.Bad(err.Error()))
		return
	}
	edition.Source = "管理员导入 · holiday-cn JSON"
	s.saveCalendar(w, r, in.Base, edition)
}

func (s *Server) saveCalendar(w http.ResponseWriter, r *http.Request, base *int64, edition schedule.CalendarEdition) {
	edition.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	detail := history.Detail{Label: "同步工作日历", SummaryOnly: true}
	source := "holiday-cn"
	if edition.Source != holidaySource {
		detail.Label, source = "导入工作日历", "JSON 导入"
	}
	detail.Tags = []history.Value{history.Text(fmt.Sprintf("%d 年", edition.Year)), history.Text(source)}
	rev, err := s.Store.ChangeLogged(r.Context(), actor(r).ID, base, "admin", &detail, false, func(tx *sql.Tx, _ *requests.Data, _ auth.User) error {
		calendar, err := store.ReadCalendar(r.Context(), tx)
		if err != nil {
			return err
		}
		var before schedule.CalendarEdition
		for _, current := range calendar.Editions {
			if current.Year == edition.Year {
				before = current
				break
			}
		}
		describeCalendarChange(&detail, before, edition)
		return store.SaveCalendar(r.Context(), tx, edition)
	})
	s.finish(w, r, rev, err)
}

func describeCalendarChange(detail *history.Detail, before, after schedule.CalendarEdition) {
	oldDays, nextDays := map[string]schedule.HolidayDay{}, map[string]schedule.HolidayDay{}
	dates := make([]string, 0, len(before.Days)+len(after.Days))
	for _, day := range before.Days {
		oldDays[day.Date] = day
		dates = append(dates, day.Date)
	}
	for _, day := range after.Days {
		nextDays[day.Date] = day
		dates = append(dates, day.Date)
	}
	slices.Sort(dates)
	holidays, workdays, other := 0, 0, 0
	for _, date := range slices.Compact(dates) {
		old, next := oldDays[date], nextDays[date]
		if old == next {
			continue
		}
		before, after := calendarDayValue(old), calendarDayValue(next)
		detail.Changes = append(detail.Changes, history.Change{Field: "日期安排", Tags: []history.Value{history.Text(date)}, Before: &before, After: &after})
		switch {
		case next.IsOffDay && !old.IsOffDay:
			holidays++
		case (old.Date != "" && !old.IsOffDay) || (next.Date != "" && !next.IsOffDay):
			workdays++
		default:
			other++
		}
	}
	for _, count := range []struct {
		value int
		label string
	}{{holidays, "新增 %d 个节假日"}, {workdays, "调整 %d 个补班日"}, {other, "更新 %d 个节假日"}} {
		if count.value > 0 {
			detail.Tags = append(detail.Tags, history.Text(fmt.Sprintf(count.label, count.value)))
		}
	}
	if len(detail.Changes) == 0 {
		detail.Tags = append(detail.Tags, history.Text("日期安排未变"))
	}
	logField(detail, "数据来源", before.Source, after.Source, "")
}

func calendarDayValue(day schedule.HolidayDay) history.Value {
	switch {
	case day.Date == "":
		return history.Text("常规日历")
	case day.IsOffDay:
		return history.Text("节假日 · " + day.Name)
	default:
		return history.Text("补班 · " + day.Name)
	}
}
