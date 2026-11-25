package requests

import (
	"testing"

	"rsm/internal/schedule"
)

func TestCompactAfterDeleteUsesOnlyFreedDaysAndPreservesRestDays(t *testing.T) {
	calendar := schedule.Calendar{RestDays: []string{"2028-01-07"}, WorkDays: []string{"2028-01-08"}}
	rows := []Request{
		{Developer: "dev", Start: "2028-01-03", Delivery: "2028-01-06", Days: 4, Vacation: []string{"2028-01-04"}},
		{Developer: "dev", Start: "2028-01-03", Delivery: "2028-01-03", Days: 1},
		{Developer: "dev", Start: "2028-01-10", Delivery: "2028-01-12", Days: 3},
		{Developer: "other", Start: "2028-01-10", Delivery: "2028-01-12", Days: 3},
	}
	updates := CompactAfterDelete(rows, 0, calendar)
	if moved := updates[2]; len(updates) != 1 || moved.Start != "2028-01-06" || moved.Delivery != "2028-01-10" || moved.Days != 3 {
		t.Fatalf("expected two released workdays to be reused across the holiday and makeup workday: %+v", updates)
	}
}

func TestCompactAfterDeleteReducesShiftToKeepOvertime(t *testing.T) {
	calendar := schedule.Calendar{}
	rows := []Request{
		{Developer: "dev", Start: "2026-11-13", Delivery: "2026-11-20", Days: 6},
		{Developer: "dev", Start: "2026-11-23", Delivery: "2026-11-28", Days: 5, Overtime: []string{"2026-11-28"}},
		{Developer: "dev", Start: "2026-11-26", Delivery: "2026-11-30", Days: 3, Overtime: []string{"2026-11-28"}},
	}
	updates := CompactAfterDelete(rows, 0, calendar)
	if a, b := updates[1], updates[2]; len(updates) != 2 ||
		a.Start != "2026-11-16" || a.Delivery != "2026-11-21" ||
		b.Start != "2026-11-19" || b.Delivery != "2026-11-23" ||
		len(a.Overtime) != 1 || len(b.Overtime) != 1 || a.Overtime[0] != "2026-11-21" || a.Overtime[0] != b.Overtime[0] {
		t.Fatalf("expected the largest shift that keeps both requests' shared overtime: %+v", updates)
	}
	rows[0].Start, rows[0].Days = "2026-11-20", 1
	if updates := CompactAfterDelete(rows, 0, calendar); len(updates) != 0 {
		t.Fatalf("overtime should not be moved onto a workday: %+v", updates)
	}
}
