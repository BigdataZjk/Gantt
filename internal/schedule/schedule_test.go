package schedule

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type fixture struct {
	CalendarIsWorkday []struct {
		Date     string `json:"date"`
		Expected bool   `json:"expected"`
		Note     string `json:"note"`
	} `json:"calendarIsWorkday"`
	CalendarSupportedYear []struct {
		Year     int  `json:"year"`
		Expected bool `json:"expected"`
	} `json:"calendarSupportedYear"`
	AddDays []struct {
		Date     string `json:"date"`
		N        int    `json:"n"`
		Expected string `json:"expected"`
	} `json:"addDays"`
	CountWorkdays []struct {
		Start    string `json:"start"`
		End      string `json:"end"`
		Expected int    `json:"expected"`
		Note     string `json:"note"`
	} `json:"countWorkdays"`
	DisplayDays []struct {
		Days     float64 `json:"days"`
		Expected float64 `json:"expected"`
	} `json:"displayDays"`
	Normalize []struct {
		Name      string `json:"name"`
		Input     Plan   `json:"input"`
		Expected  *Plan  `json:"expected"`
		ErrorCode string `json:"errorCode"`
	} `json:"normalize"`
	Gaps []struct {
		Name     string `json:"name"`
		Plan     Plan   `json:"plan"`
		Expected []Gap  `json:"expected"`
	} `json:"gaps"`
	EffectiveSegments []struct {
		Name     string    `json:"name"`
		Plan     Plan      `json:"plan"`
		Expected []Segment `json:"expected"`
	} `json:"effectiveSegments"`
	EffectiveDays []struct {
		Name     string `json:"name"`
		Plan     Plan   `json:"plan"`
		Expected int    `json:"expected"`
	} `json:"effectiveDays"`
	Overlap []struct {
		Name                string `json:"name"`
		A                   Plan   `json:"a"`
		B                   Plan   `json:"b"`
		ExpectedOverlapDays int    `json:"expectedOverlapDays"`
		ExpectedOverlaps    bool   `json:"expectedOverlaps"`
	} `json:"overlap"`
	MoveSegment []struct {
		Name      string `json:"name"`
		Input     Plan   `json:"input"`
		Index     int    `json:"index"`
		NewStart  string `json:"newStart"`
		Expected  *Plan  `json:"expected"`
		ErrorCode string `json:"errorCode"`
	} `json:"moveSegment"`
	ResizeSegment []struct {
		Name      string `json:"name"`
		Input     Plan   `json:"input"`
		Index     int    `json:"index"`
		Edge      string `json:"edge"`
		Date      string `json:"date"`
		Expected  *Plan  `json:"expected"`
		ErrorCode string `json:"errorCode"`
	} `json:"resizeSegment"`
	RemoveSegment []struct {
		Name      string `json:"name"`
		Input     Plan   `json:"input"`
		Index     int    `json:"index"`
		Expected  *Plan  `json:"expected"`
		ErrorCode string `json:"errorCode"`
	} `json:"removeSegment"`
	AddSegment []struct {
		Name      string `json:"name"`
		Input     Plan   `json:"input"`
		Start     string `json:"start"`
		End       string `json:"end"`
		Expected  *Plan  `json:"expected"`
		ErrorCode string `json:"errorCode"`
	} `json:"addSegment"`
	SetDays []struct {
		Name      string  `json:"name"`
		Input     Plan    `json:"input"`
		Days      float64 `json:"days"`
		Expected  *Plan   `json:"expected"`
		ErrorCode string  `json:"errorCode"`
	} `json:"setDays"`
	SetDelivery []struct {
		Name      string `json:"name"`
		Input     Plan   `json:"input"`
		Delivery  string `json:"delivery"`
		Expected  *Plan  `json:"expected"`
		ErrorCode string `json:"errorCode"`
	} `json:"setDelivery"`
	SetVacation []struct {
		Name      string `json:"name"`
		Input     Plan   `json:"input"`
		Date      string `json:"date"`
		On        bool   `json:"on"`
		Expected  *Plan  `json:"expected"`
		ErrorCode string `json:"errorCode"`
	} `json:"setVacation"`
	SetOvertime []struct {
		Name      string `json:"name"`
		Input     Plan   `json:"input"`
		Date      string `json:"date"`
		On        bool   `json:"on"`
		Expected  *Plan  `json:"expected"`
		ErrorCode string `json:"errorCode"`
	} `json:"setOvertime"`
	Sequence []struct {
		Name      string            `json:"name"`
		Requests  []SequenceRequest `json:"requests"`
		Expected  *SequenceResult   `json:"expected"`
		ErrorCode string            `json:"errorCode"`
	} `json:"sequence"`
}

func loadFixture(t *testing.T) (fixture, Calendar) {
	t.Helper()
	path := filepath.Join("..", "..", "testdata", "schedule", "cases.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取共享 fixture 失败: %v", err)
	}
	var f fixture
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("解析共享 fixture 失败: %v", err)
	}
	return f, DefaultCalendar()
}

func toJSON(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	return string(data)
}

func assertPlan(t *testing.T, scenario string, got Plan, want Plan) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s：结果不一致\n got: %s\nwant: %s", scenario, toJSON(t, got), toJSON(t, want))
	}
}

func assertError(t *testing.T, scenario string, err error, code string) {
	t.Helper()
	if code == "" {
		if err != nil {
			t.Fatalf("%s：预期成功但返回错误 %v", scenario, err)
		}
		return
	}
	if err == nil {
		t.Fatalf("%s：预期错误码 %s 但成功返回", scenario, code)
	}
	if got := Code(err); got != code {
		t.Fatalf("%s：错误码不一致 got=%q want=%q (%v)", scenario, got, code, err)
	}
}

func TestCalendarFixture(t *testing.T) {
	f, calendar := loadFixture(t)
	if len(calendar.Years) == 0 || calendar.Source == "" {
		t.Fatalf("默认日历必须声明年份与来源")
	}
	for _, c := range f.CalendarIsWorkday {
		if got := IsWorkday(c.Date, calendar); got != c.Expected {
			t.Errorf("IsWorkday(%s) = %v, want %v (%s)", c.Date, got, c.Expected, c.Note)
		}
	}
	for _, c := range f.CalendarSupportedYear {
		if got := IsSupportedYear(c.Year, calendar); got != c.Expected {
			t.Errorf("IsSupportedYear(%d) = %v, want %v", c.Year, got, c.Expected)
		}
	}
	for _, c := range f.AddDays {
		if got := AddDays(c.Date, c.N); got != c.Expected {
			t.Errorf("AddDays(%s,%d) = %s, want %s", c.Date, c.N, got, c.Expected)
		}
	}
	for _, c := range f.CountWorkdays {
		if got := CountWorkdays(c.Start, c.End, calendar); got != c.Expected {
			t.Errorf("CountWorkdays(%s,%s) = %d, want %d (%s)", c.Start, c.End, got, c.Expected, c.Note)
		}
	}
	for _, c := range f.DisplayDays {
		if got := DisplayDays(Plan{Days: c.Days}); got != c.Expected {
			t.Errorf("DisplayDays(%v) = %v, want %v", c.Days, got, c.Expected)
		}
	}
}

func TestDefaultCalendarIntegrity(t *testing.T) {
	calendar := DefaultCalendar()
	rest := map[string]bool{}
	work := map[string]bool{}
	for _, day := range calendar.RestDays {
		if !ValidDate(day) {
			t.Fatalf("非法休息日 %s", day)
		}
		if rest[day] {
			t.Fatalf("重复休息日 %s", day)
		}
		rest[day] = true
	}
	for _, day := range calendar.WorkDays {
		if !ValidDate(day) {
			t.Fatalf("非法调休上班日 %s", day)
		}
		if work[day] {
			t.Fatalf("重复调休上班日 %s", day)
		}
		work[day] = true
		if rest[day] {
			t.Fatalf("同一天既放假日又上班日 %s", day)
		}
	}
	// 2025、2026 每年都应有法定假日与调休上班日
	for _, year := range []int{2025, 2026} {
		hasRest, hasWork := false, false
		for day := range rest {
			if YearOf(day) == year {
				hasRest = true
			}
		}
		for day := range work {
			if YearOf(day) == year {
				hasWork = true
			}
		}
		if !hasRest || !hasWork {
			t.Fatalf("%d 年缺少法定假日或调休上班日", year)
		}
	}
}

func TestNormalizeFixture(t *testing.T) {
	f, calendar := loadFixture(t)
	if len(f.Normalize) == 0 {
		t.Fatal("fixture 未包含 normalize 用例")
	}
	for _, c := range f.Normalize {
		got, err := Normalize(c.Input, calendar)
		assertError(t, c.Name, err, c.ErrorCode)
		if c.ErrorCode != "" {
			continue
		}
		if c.Expected == nil {
			t.Fatalf("%s：fixture 缺少 expected", c.Name)
		}
		assertPlan(t, c.Name, got, *c.Expected)
		// 归一化必须幂等，供服务端重复校验与前端预览复用。
		again, err := Normalize(got, calendar)
		assertError(t, c.Name+"（幂等）", err, "")
		assertPlan(t, c.Name+"（幂等）", again, got)
	}
}

func TestGapsFixture(t *testing.T) {
	f, calendar := loadFixture(t)
	for _, c := range f.Gaps {
		got := Gaps(c.Plan, calendar)
		if got == nil {
			got = []Gap{}
		}
		if !reflect.DeepEqual(got, c.Expected) {
			t.Fatalf("%s：got %s want %s", c.Name, toJSON(t, got), toJSON(t, c.Expected))
		}
	}
}

func TestEffectiveSegmentsFixture(t *testing.T) {
	f, _ := loadFixture(t)
	for _, c := range f.EffectiveSegments {
		got := EffectiveSegments(c.Plan)
		if !reflect.DeepEqual(got, c.Expected) {
			t.Fatalf("%s：got %s want %s", c.Name, toJSON(t, got), toJSON(t, c.Expected))
		}
	}
}

func TestEffectiveDaysFixture(t *testing.T) {
	f, calendar := loadFixture(t)
	for _, c := range f.EffectiveDays {
		if got := EffectiveDays(c.Plan, calendar); got != c.Expected {
			t.Fatalf("%s：EffectiveDays got %d want %d", c.Name, got, c.Expected)
		}
	}
}

func TestOverlapFixture(t *testing.T) {
	f, calendar := loadFixture(t)
	for _, c := range f.Overlap {
		if got := OverlapDays(c.A, c.B, calendar); got != c.ExpectedOverlapDays {
			t.Fatalf("%s：OverlapDays got %d want %d", c.Name, got, c.ExpectedOverlapDays)
		}
		if got := Overlaps(c.A, c.B, calendar); got != c.ExpectedOverlaps {
			t.Fatalf("%s：Overlaps got %v want %v", c.Name, got, c.ExpectedOverlaps)
		}
	}
}

func TestMoveSegmentFixture(t *testing.T) {
	f, calendar := loadFixture(t)
	for _, c := range f.MoveSegment {
		got, err := MoveSegment(c.Input, calendar, c.Index, c.NewStart)
		assertError(t, c.Name, err, c.ErrorCode)
		if err == nil {
			assertPlan(t, c.Name, got, *c.Expected)
		}
	}
}

func TestResizeSegmentFixture(t *testing.T) {
	f, calendar := loadFixture(t)
	for _, c := range f.ResizeSegment {
		got, err := ResizeSegment(c.Input, calendar, c.Index, c.Edge, c.Date)
		assertError(t, c.Name, err, c.ErrorCode)
		if err == nil {
			assertPlan(t, c.Name, got, *c.Expected)
		}
	}
}

func TestRemoveSegmentFixture(t *testing.T) {
	f, calendar := loadFixture(t)
	for _, c := range f.RemoveSegment {
		got, err := RemoveSegment(c.Input, calendar, c.Index)
		assertError(t, c.Name, err, c.ErrorCode)
		if err == nil {
			assertPlan(t, c.Name, got, *c.Expected)
		}
	}
}

func TestAddSegmentFixture(t *testing.T) {
	f, calendar := loadFixture(t)
	for _, c := range f.AddSegment {
		got, err := AddSegment(c.Input, calendar, c.Start, c.End)
		assertError(t, c.Name, err, c.ErrorCode)
		if err == nil {
			assertPlan(t, c.Name, got, *c.Expected)
		}
	}
}

func TestSetDaysFixture(t *testing.T) {
	f, calendar := loadFixture(t)
	for _, c := range f.SetDays {
		got, err := SetDays(c.Input, calendar, c.Days)
		assertError(t, c.Name, err, c.ErrorCode)
		if err == nil {
			assertPlan(t, c.Name, got, *c.Expected)
		}
	}
}

func TestSetDeliveryFixture(t *testing.T) {
	f, calendar := loadFixture(t)
	for _, c := range f.SetDelivery {
		got, err := SetDelivery(c.Input, calendar, c.Delivery)
		assertError(t, c.Name, err, c.ErrorCode)
		if err == nil {
			assertPlan(t, c.Name, got, *c.Expected)
		}
	}
}

func TestMarkFixture(t *testing.T) {
	f, calendar := loadFixture(t)
	for _, c := range f.SetVacation {
		got, err := SetVacation(c.Input, calendar, c.Date, c.On)
		assertError(t, c.Name, err, c.ErrorCode)
		if err == nil {
			assertPlan(t, c.Name, got, *c.Expected)
		}
	}
	for _, c := range f.SetOvertime {
		got, err := SetOvertime(c.Input, calendar, c.Date, c.On)
		assertError(t, c.Name, err, c.ErrorCode)
		if err == nil {
			assertPlan(t, c.Name, got, *c.Expected)
		}
	}
}

func TestSequenceFixture(t *testing.T) {
	f, calendar := loadFixture(t)
	for _, c := range f.Sequence {
		got, err := Sequence(c.Requests, calendar)
		assertError(t, c.Name, err, c.ErrorCode)
		if err == nil {
			if !reflect.DeepEqual(got, *c.Expected) {
				t.Fatalf("%s：顺排结果不一致\n got: %s\nwant: %s", c.Name, toJSON(t, got), toJSON(t, c.Expected))
			}
		}
	}
}

func TestSequenceDoesNotMutateInput(t *testing.T) {
	_, calendar := loadFixture(t)
	requests := []SequenceRequest{
		{ID: "a", Name: "需求A", Developer: "李明", Selected: true, Plan: Plan{Segments: []Segment{{Start: "2026-11-16", End: "2026-11-20"}}, Days: 5, Start: "2026-11-16", Delivery: "2026-11-20", Vacation: []string{}, Overtime: []string{}}},
		{ID: "u", Name: "未选U", Developer: "李明", Selected: false, Plan: Plan{Segments: []Segment{{Start: "2026-11-18", End: "2026-11-19"}}, Days: 2, Start: "2026-11-18", Delivery: "2026-11-19", Vacation: []string{}, Overtime: []string{}}},
	}
	before := toJSON(t, requests)
	if _, err := Sequence(requests, calendar); err != nil {
		t.Fatalf("顺排失败: %v", err)
	}
	if after := toJSON(t, requests); after != before {
		t.Fatalf("Sequence 不应修改入参\nbefore: %s\nafter: %s", before, after)
	}
}

func TestUnsupportedYearFallback(t *testing.T) {
	calendar := DefaultCalendar()
	// 2028-01-03 为周一，超出日历覆盖范围时按普通周末规则计算。
	if !IsWorkday("2028-01-03", calendar) {
		t.Fatal("超支持年份应回退为普通周末规则")
	}
	if IsWorkday("2028-01-01", calendar) {
		t.Fatal("2028-01-01 是周六，应为休息日")
	}
	if years := UnsupportedYears(calendar, "2026-11-16", "2028-01-03", "2028-06-01"); !reflect.DeepEqual(years, []int{2028}) {
		t.Fatalf("UnsupportedYears = %v, want [2028]", years)
	}
}

func TestInvalidCalendarDatesIgnored(t *testing.T) {
	calendar := Calendar{RestDays: []string{"bad"}, WorkDays: []string{"2026-11-21"}, Years: []int{2026}}
	if !IsWorkday("2026-11-21", calendar) {
		t.Fatal("调休上班日应优先于周末")
	}
	if !IsWorkday("2026-11-16", calendar) {
		t.Fatal("普通工作日应按周末规则计算")
	}
	if IsWorkday("bad", calendar) {
		t.Fatal("非法日期应返回 false")
	}
}

func BenchmarkIsWorkday(b *testing.B) {
	calendar := DefaultCalendar()
	for i := 0; i < b.N; i++ {
		_ = IsWorkday("2026-11-16", calendar)
	}
}
