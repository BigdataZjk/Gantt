package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"rsm/internal/history"
)

func (s *Store) HistoryDetail(ctx context.Context, id int64) (history.Detail, error) {
	var raw string
	var detail history.Detail
	err := s.DB.QueryRowContext(ctx, "select payload from history_details where history_id=?", id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return detail, ErrNotFound
	}
	if err != nil {
		return detail, err
	}
	err = json.Unmarshal([]byte(raw), &detail)
	return detail, err
}

func insertHistory(ctx context.Context, tx *sql.Tx, actor, action, createdAt string, reversible bool, before any, detail *history.Detail) error {
	if detail != nil {
		action = detail.Action()
	}
	result, err := tx.ExecContext(ctx, "insert into history(actor,action,created_at,reversible,before_data) values (?,?,?,?,?)", actor, action, createdAt, reversible, before)
	if err != nil {
		return err
	}
	if detail != nil {
		id, err := result.LastInsertId()
		if err != nil {
			return err
		}
		compact, err := json.Marshal(detail.Preview())
		if err != nil {
			return err
		}
		full, err := json.Marshal(detail)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "insert into history_details(history_id,preview,payload) values (?,?,?)", id, string(compact), string(full))
		return err
	}
	return nil
}
