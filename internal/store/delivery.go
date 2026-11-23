package store

import (
	"context"
	"database/sql"

	"rsm/internal/requests"
	"rsm/internal/schedule"
)

type P0DeliveryChange struct {
	RequestID int64  `json:"requestId"`
	Name      string `json:"name"`
	Before    string `json:"before"`
	After     string `json:"after"`
}

type P0DeliveryConfirmation struct {
	Token   string             `json:"token"`
	Changes []P0DeliveryChange `json:"changes"`
}

func (P0DeliveryConfirmation) Error() string { return "请确认 P0 需求的交付日期变更" }

type p0DeliveryConfirmationKey struct{}
type verifyP0DeliveryConfirmation func(revision int64, changes []P0DeliveryChange) error

func WithP0DeliveryConfirmation(ctx context.Context, verify func(int64, []P0DeliveryChange) error) context.Context {
	return context.WithValue(ctx, p0DeliveryConfirmationKey{}, verifyP0DeliveryConfirmation(verify))
}

type requestDelivery struct {
	priority string
	date     string
}

func readDeliveryDates(ctx context.Context, tx *sql.Tx, rows []requests.Request) (map[int64]requestDelivery, error) {
	dates := make(map[int64]requestDelivery, len(rows))
	resolve := deliveryDateResolver(ctx, tx)
	for _, row := range rows {
		date, err := resolve(row)
		if err != nil {
			return nil, err
		}
		dates[row.ID] = requestDelivery{priority: row.Priority, date: date}
	}
	return dates, nil
}

func checkP0DeliveryChanges(ctx context.Context, tx *sql.Tx, revision int64, before map[int64]requestDelivery, rows []requests.Request) error {
	var changes []P0DeliveryChange
	resolve := deliveryDateResolver(ctx, tx)
	for _, row := range rows {
		old, exists := before[row.ID]
		if !exists || (old.priority != "P0" && row.Priority != "P0") {
			continue
		}
		date, err := resolve(row)
		if err != nil {
			return err
		}
		if old.date != date {
			changes = append(changes, P0DeliveryChange{RequestID: row.ID, Name: row.Name, Before: old.date, After: date})
		}
	}
	if len(changes) == 0 {
		return nil
	}
	if verify, ok := ctx.Value(p0DeliveryConfirmationKey{}).(verifyP0DeliveryConfirmation); ok {
		return verify(revision, changes)
	}
	return P0DeliveryConfirmation{Changes: changes}
}

func deliveryDateResolver(ctx context.Context, tx *sql.Tx) func(requests.Request) (string, error) {
	var calendar schedule.Calendar
	loaded := false
	return func(row requests.Request) (string, error) {
		// 旧记录可能需要由开始日期和工作日历推算交付日期。
		if !loaded && len(row.Segments) == 0 && row.Start != "" && !schedule.ValidDate(row.Delivery) {
			var err error
			calendar, err = ReadCalendar(ctx, tx)
			if err != nil {
				return "", err
			}
			loaded = true
		}
		return schedule.DeliveryOf(schedule.Plan{
			Segments: row.Segments, Start: row.Start, Delivery: row.Delivery,
			Days: row.Days, Vacation: row.Vacation, Overtime: row.Overtime,
		}, calendar), nil
	}
}
