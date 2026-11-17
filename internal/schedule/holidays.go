package schedule

import (
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
)

type HolidayDay struct {
	Name     string `json:"name"`
	Date     string `json:"date"`
	IsOffDay bool   `json:"isOffDay"`
}

type CalendarEdition struct {
	Year      int          `json:"year"`
	Days      []HolidayDay `json:"days"`
	Papers    []string     `json:"papers"`
	Source    string       `json:"source"`
	UpdatedAt string       `json:"updatedAt,omitempty"`
}

// ParseHolidayJSON accepts the public holiday-cn format, including cross-year New Year arrangements.
func ParseHolidayJSON(raw []byte, year int) (CalendarEdition, error) {
	var in struct {
		Year int `json:"year"`
		Days []struct {
			Name     string `json:"name"`
			Date     string `json:"date"`
			IsOffDay *bool  `json:"isOffDay"`
		} `json:"days"`
		Papers []string `json:"papers"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return CalendarEdition{}, fmt.Errorf("日历文件不是有效 JSON")
	}
	if in.Year < 2000 || in.Year > 2099 || in.Year != year {
		return CalendarEdition{}, fmt.Errorf("日历年份必须与所选年份一致（2000—2099）")
	}
	if len(in.Days) < 1 || len(in.Days) > 100 || len(in.Papers) > 10 {
		return CalendarEdition{}, fmt.Errorf("日历尚未公布或日期条目无效，原日历保持不变")
	}
	out := CalendarEdition{Year: in.Year, Days: []HolidayDay{}, Papers: []string{}}
	seen := map[string]bool{}
	hasRest := false
	for _, day := range in.Days {
		parsed, err := ParseDate(day.Date)
		name := strings.TrimSpace(day.Name)
		// An announcement may include dates in the adjacent year, but never unrelated months.
		if err != nil || day.Date < fmt.Sprintf("%d-12-01", year-1) || day.Date > fmt.Sprintf("%d-01-31", year+1) || parsed.Year() < 2000 || name == "" || len([]rune(name)) > 60 || day.IsOffDay == nil || seen[day.Date] {
			return CalendarEdition{}, fmt.Errorf("日历包含非法、重复或缺少休班标识的日期")
		}
		seen[day.Date] = true
		hasRest = hasRest || *day.IsOffDay
		out.Days = append(out.Days, HolidayDay{Name: name, Date: day.Date, IsOffDay: *day.IsOffDay})
	}
	if !hasRest {
		return CalendarEdition{}, fmt.Errorf("日历未包含放假安排，拒绝替换现有日历")
	}
	for _, paper := range in.Papers {
		u, err := url.Parse(paper)
		if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || len(paper) > 1000 {
			return CalendarEdition{}, fmt.Errorf("公告链接必须为有效 HTTPS 地址")
		}
		out.Papers = append(out.Papers, paper)
	}
	sort.Slice(out.Days, func(i, j int) bool { return out.Days[i].Date < out.Days[j].Date })
	return out, nil
}

// ComposeCalendar replaces announcement editions, then lets the newer year's announcement resolve cross-year dates.
func ComposeCalendar(editions map[int]CalendarEdition) Calendar {
	out := Calendar{RestDays: []string{}, WorkDays: []string{}, Years: []int{}, Source: "国务院办公厅公布的中国大陆节假日与调休安排", Editions: []CalendarEdition{}}
	for year := range editions {
		out.Years = append(out.Years, year)
	}
	sort.Ints(out.Years)
	days := map[string]bool{}
	for _, year := range out.Years {
		edition := editions[year]
		out.Editions = append(out.Editions, edition)
		for _, day := range edition.Days {
			days[day.Date] = day.IsOffDay
		}
	}
	for date, rest := range days {
		if rest {
			out.RestDays = append(out.RestDays, date)
		} else {
			out.WorkDays = append(out.WorkDays, date)
		}
	}
	sort.Strings(out.RestDays)
	sort.Strings(out.WorkDays)
	return out
}
