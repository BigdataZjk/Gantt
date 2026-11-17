package schedule

import (
	"strings"
	"testing"
)

func TestParseHolidayJSON(t *testing.T) {
	raw := `{"$schema":"https://example.test/schema.json","year":2028,"papers":["https://example.test/notice"],"days":[{"name":"元旦","date":"2028-01-01","isOffDay":true},{"name":"元旦","date":"2027-12-31","isOffDay":true},{"name":"元旦","date":"2028-01-08","isOffDay":false}]}`
	edition, err := ParseHolidayJSON([]byte(raw), 2028)
	if err != nil || edition.Year != 2028 || len(edition.Days) != 3 || edition.Days[0].Date != "2027-12-31" || edition.Days[2].IsOffDay {
		t.Fatalf("parse cross-year public JSON: %+v, %v", edition, err)
	}
	for _, bad := range []string{
		`null`,
		`{"year":2028,"days":[]}`,
		strings.Replace(raw, `"year":2028`, `"year":2027`, 1),
		strings.Replace(raw, `"2028-01-01"`, `"2028-02-30"`, 1),
		strings.Replace(raw, `"2028-01-01"`, `"2028-1-01"`, 1),
		strings.Replace(raw, `"2027-12-31"`, `"2027-11-30"`, 1),
		strings.Replace(raw, `"2028-01-08"`, `"2029-02-01"`, 1),
		strings.Replace(raw, `"2028-01-08"`, `"2028-01-01"`, 1),
		strings.Replace(raw, `"isOffDay":false`, `"isOffDay":null`, 1),
		strings.Replace(raw, `"isOffDay":false`, `"missing":false`, 1),
		strings.ReplaceAll(raw, `"isOffDay":true`, `"isOffDay":false`),
		strings.Replace(raw, `"name":"元旦"`, `"name":" "`, 1),
		strings.Replace(raw, `https://example.test/notice`, `http://example.test/notice`, 1),
		strings.Replace(raw, `https://example.test/notice`, `https://user:pass@example.test/notice`, 1),
	} {
		if _, err := ParseHolidayJSON([]byte(bad), 2028); err == nil {
			t.Errorf("accepted invalid JSON: %s", bad)
		}
	}
}

func TestComposeCalendarPreservesCrossYearAnnouncements(t *testing.T) {
	editions := map[int]CalendarEdition{
		2028: {Year: 2028, Days: []HolidayDay{{Date: "2028-12-29", IsOffDay: false}, {Date: "2028-01-03", IsOffDay: true}}},
		2029: {Year: 2029, Days: []HolidayDay{{Date: "2028-12-29", IsOffDay: true}, {Date: "2029-01-01", IsOffDay: true}}},
	}
	calendar := ComposeCalendar(editions)
	if len(calendar.Years) != 2 || calendar.Years[0] != 2028 || IsWorkday("2028-12-29", calendar) || len(calendar.WorkDays) != 0 {
		t.Fatalf("newer announcement did not take precedence: %+v", calendar)
	}
	editions[2028] = CalendarEdition{Year: 2028, Days: []HolidayDay{{Date: "2028-01-04", IsOffDay: true}}}
	calendar = ComposeCalendar(editions)
	if !IsWorkday("2028-01-03", calendar) || IsWorkday("2028-01-04", calendar) || IsWorkday("2028-12-29", calendar) || IsWorkday("2029-01-01", calendar) {
		t.Fatalf("annual replacement lost a different announcement: %+v", calendar)
	}
}

func TestDefault2027SpringFestival(t *testing.T) {
	calendar := DefaultCalendar()
	if IsWorkday("2027-02-05", calendar) || !IsWorkday("2027-01-31", calendar) || !IsWorkday("2027-02-14", calendar) {
		t.Fatal("Spring Festival or adjusted Sundays are incorrect")
	}
	end, err := AddWorkdays("2027-02-04", 2, calendar)
	if err != nil || end != "2027-02-14" {
		t.Fatalf("delivery crossing Spring Festival = %s, %v", end, err)
	}
}
