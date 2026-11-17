package store

import (
	"context"
	"database/sql"
	"encoding/json"

	"rsm/internal/requests"
)

// 仅从连续可还原的历史快照补回实际时间，不推测已清理的历史。
func (s *Store) backfillRequestTimes(ctx context.Context) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	current, _, err := readData(ctx, tx)
	if err != nil {
		return err
	}
	needed := false
	targets := make(map[int64]*requests.Request, len(current.Requests))
	for i := range current.Requests {
		row := &current.Requests[i]
		targets[row.ID] = row
		if row.PoolEnteredAt == "" || (row.Archived && row.ArchivedAt == "") {
			needed = true
		}
	}
	if !needed {
		return nil
	}
	after := make(map[int64]requests.Request, len(current.Requests))
	for _, row := range current.Requests {
		after[row.ID] = row
	}
	rows, err := tx.QueryContext(ctx, "select created_at,before_data from history order by id desc")
	if err != nil {
		return err
	}
	changed := false
	for rows.Next() {
		var stamp string
		var raw sql.NullString
		if err = rows.Scan(&stamp, &raw); err != nil {
			rows.Close()
			return err
		}
		var before requests.Data
		if !raw.Valid || json.Unmarshal([]byte(raw.String), &before) != nil || before.Requests == nil || before.NextID < 1 {
			break
		}
		previous := make(map[int64]requests.Request, len(before.Requests))
		for _, row := range before.Requests {
			previous[row.ID] = row
		}
		for id, next := range after {
			target := targets[id]
			if target == nil {
				continue
			}
			old, exists := previous[id]
			if target.PoolEnteredAt == "" && (!exists || (old.Archived && !next.Archived)) {
				target.PoolEnteredAt = stamp
				changed = true
			}
			if target.ArchivedAt == "" && exists && !old.Archived && next.Archived {
				target.ArchivedAt = stamp
				changed = true
			}
		}
		after = previous
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err = rows.Close(); err != nil {
		return err
	}
	if changed {
		payload, err := json.Marshal(current)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "update metadata set payload=? where id=1", string(payload)); err != nil {
			return err
		}
	}
	return tx.Commit()
}
