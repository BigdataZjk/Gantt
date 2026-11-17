package store

import (
	"context"
	"database/sql"
	"encoding/json"

	"rsm/internal/schedule"
)

func ReadCalendar(ctx context.Context, q queryer) (schedule.Calendar, error) {
	editions := map[int]schedule.CalendarEdition{}
	for _, edition := range schedule.DefaultCalendar().Editions {
		editions[edition.Year] = edition
	}
	rows, err := q.QueryContext(ctx, "select payload from calendar_years order by year")
	if err != nil {
		return schedule.Calendar{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return schedule.Calendar{}, err
		}
		var edition schedule.CalendarEdition
		if err := json.Unmarshal([]byte(raw), &edition); err != nil {
			return schedule.Calendar{}, err
		}
		editions[edition.Year] = edition
	}
	if err := rows.Err(); err != nil {
		return schedule.Calendar{}, err
	}
	return schedule.ComposeCalendar(editions), nil
}

func SaveCalendar(ctx context.Context, tx *sql.Tx, edition schedule.CalendarEdition) error {
	raw, err := json.Marshal(edition)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "insert into calendar_years(year,payload) values (?,?) on conflict(year) do update set payload=excluded.payload", edition.Year, string(raw))
	return err
}
