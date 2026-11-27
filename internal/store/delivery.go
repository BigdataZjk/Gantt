package store

import (
	"context"
	"database/sql"
	"slices"

	"rsm/internal/requests"
	"rsm/internal/schedule"
)

type P0DeliveryChange struct {
	RequestID  int64  `json:"requestId"`
	Name       string `json:"name"`
	Before     string `json:"before"`
	After      string `json:"after"`
	BeforeDays *int   `json:"beforeDays,omitempty"`
	AfterDays  *int   `json:"afterDays,omitempty"`
}

type P0DeliveryConfirmation struct {
	Token   string             `json:"token"`
	Changes []P0DeliveryChange `json:"changes"`
}

func (P0DeliveryConfirmation) Error() string { return "请确认 P0 需求的排期变更" }

type p0DeliveryConfirmationKey struct{}
type verifyP0DeliveryConfirmation func(revision int64, changes []P0DeliveryChange) error

func WithP0DeliveryConfirmation(ctx context.Context, verify func(int64, []P0DeliveryChange) error) context.Context {
	return context.WithValue(ctx, p0DeliveryConfirmationKey{}, verifyP0DeliveryConfirmation(verify))
}

type requestSchedule struct {
	priority string
	plan     schedule.Plan
}

type requestScheduleSnapshot struct {
	rows     map[int64]requestSchedule
	calendar schedule.Calendar
}

func readRequestSchedules(ctx context.Context, tx *sql.Tx, rows []requests.Request) (requestScheduleSnapshot, error) {
	previous := requestScheduleSnapshot{rows: make(map[int64]requestSchedule, len(rows))}
	var hasSchedules bool
	for _, row := range rows {
		plan := requestPlan(row)
		plan.Segments = slices.Clone(plan.Segments)
		plan.Vacation = slices.Clone(plan.Vacation)
		plan.Overtime = slices.Clone(plan.Overtime)
		previous.rows[row.ID] = requestSchedule{priority: row.Priority, plan: plan}
		hasSchedules = hasSchedules || hasScheduleDates(plan)
	}
	if hasSchedules {
		calendar, err := ReadCalendar(ctx, tx)
		if err != nil {
			return requestScheduleSnapshot{}, err
		}
		previous.calendar = calendar
	}
	return previous, nil
}

func checkP0ScheduleChanges(ctx context.Context, tx *sql.Tx, revision int64, before requestScheduleSnapshot, rows []requests.Request) error {
	var changes []P0DeliveryChange
	var calendar schedule.Calendar
	var loaded, sameCalendar bool
	for _, row := range rows {
		old, exists := before.rows[row.ID]
		if !exists || (old.priority != "P0" && row.Priority != "P0") {
			continue
		}
		plan := requestPlan(row)
		if !hasScheduleDates(old.plan) && !hasScheduleDates(plan) {
			continue
		}
		if !loaded {
			var err error
			calendar, err = ReadCalendar(ctx, tx)
			if err != nil {
				return err
			}
			loaded = true
			sameCalendar = slices.Equal(calendar.RestDays, before.calendar.RestDays) && slices.Equal(calendar.WorkDays, before.calendar.WorkDays)
		}
		if sameCalendar && sameRequestPlan(old.plan, plan) {
			continue
		}
		oldDate, oldDays := resolveScheduleImpact(old.plan, before.calendar)
		newDate, newDays := resolveScheduleImpact(plan, calendar)
		if oldDate == newDate && oldDays == newDays {
			continue
		}
		change := P0DeliveryChange{RequestID: row.ID, Name: row.Name, Before: oldDate, After: newDate}
		if oldDays != newDays {
			change.BeforeDays, change.AfterDays = &oldDays, &newDays
		}
		changes = append(changes, change)
	}
	if len(changes) == 0 {
		return nil
	}
	if verify, ok := ctx.Value(p0DeliveryConfirmationKey{}).(verifyP0DeliveryConfirmation); ok {
		return verify(revision, changes)
	}
	return P0DeliveryConfirmation{Changes: changes}
}

func requestPlan(row requests.Request) schedule.Plan {
	return schedule.Plan{
		Segments: row.Segments, Start: row.Start, Delivery: row.Delivery,
		Days: row.Days, Vacation: row.Vacation, Overtime: row.Overtime,
	}
}

func hasScheduleDates(plan schedule.Plan) bool {
	return plan.Start != "" || plan.Delivery != "" || len(plan.Segments) > 0
}

func sameRequestPlan(a, b schedule.Plan) bool {
	return a.Start == b.Start && a.Delivery == b.Delivery && a.Days == b.Days &&
		slices.Equal(a.Segments, b.Segments) && slices.Equal(a.Vacation, b.Vacation) && slices.Equal(a.Overtime, b.Overtime)
}

func resolveScheduleImpact(plan schedule.Plan, calendar schedule.Calendar) (string, int) {
	plan.Delivery = schedule.DeliveryOf(plan, calendar)
	if len(plan.Segments) == 0 {
		plan.Segments = schedule.EffectiveSegments(plan)
	}
	return plan.Delivery, schedule.EffectiveDays(plan, calendar)
}
